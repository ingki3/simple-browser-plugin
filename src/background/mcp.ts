// MCP 연동(#140): 로컬 다리(mcp/sbp-mcp.mjs)를 폴링해 다른 AI 도구의 요청을 원격 대화(channel "mcp")로 처리하고 최종 답을 돌려준다.
// - 다리와는 설정의 비밀로 서로를 확인하고 본문을 암호화한다(src/lib/mcpProtocol.ts). 응답을 복호화하지 못하면 버린다.
// - 원격 정책은 텔레그램과 같다(승인이 필요한 동작은 하지 않음 — openrouter.ts의 원격 정책).
// - 작업 계약: 실행 전에 작업 id를 저장하고 같은 작업은 다시 실행하지 않는다. 결과 전송만 다시 시도한다. 다리에 60초 넘게 닿지 않거나
//   기한이 지나면 스스로 멈춘다. 서비스 워커가 다시 뜨면 진행 중이던 작업은 중단으로 보고한다(자동 재실행 없음).
import {
  MCP_DEFAULT_PORT,
  aadOf,
  deriveKeys,
  makeHeader,
  newSecret,
  open,
  parseNext,
  seal,
  signRequest,
  type McpKeys,
  type McpNext,
} from "@/lib/mcpProtocol";
import { remoteErrorText } from "@/lib/telegram";
import { RemoteRunner } from "./remoteRunner";
import { maskStringForModel } from "./loginSecrets";
import { debugLog } from "./debug";

const STORE_KEY = "mcp";
const ALARM = "mcp-poll";
// 다리는 최대 20초 붙잡는다. 전체 요청은 25초 안에(서비스 워커는 fetch 응답을 30초 넘게 기다리면 내려갈 수 있다).
const FETCH_LIMIT_MS = 25_000;
const LEASE_MS = 60_000;
const MAX_LOOP_FAILURES = 5;

interface McpJob {
  bridgeId: string;
  jobId: string;
  state: "running" | "finished";
}

interface McpState {
  enabled: boolean;
  port: number;
  secret: string;
  bridgeId: string;
  bridgeVersion: string;
  lastOkAt: number;
  lastError: string;
  job: McpJob | null;
}

const EMPTY: McpState = { enabled: false, port: MCP_DEFAULT_PORT, secret: "", bridgeId: "", bridgeVersion: "", lastOkAt: 0, lastError: "", job: null };

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function load(): Promise<McpState> {
  const raw = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  return raw && typeof raw === "object" ? { ...EMPTY, ...(raw as Partial<McpState>) } : { ...EMPTY };
}

function update(fn: (s: McpState) => McpState): Promise<McpState> {
  return serial(async () => {
    const next = fn(await load());
    await chrome.storage.local.set({ [STORE_KEY]: next });
    return next;
  });
}

// ---- 설정 화면 ----

export interface McpStatus {
  enabled: boolean;
  port: number;
  hasSecret: boolean;
  connected: boolean;
  lastOkAt: number;
  bridgeVersion: string;
  lastError: string;
}

function statusOf(s: McpState): McpStatus {
  return {
    enabled: s.enabled,
    port: s.port,
    hasSecret: !!s.secret,
    connected: s.enabled && Date.now() - s.lastOkAt < LEASE_MS,
    lastOkAt: s.lastOkAt,
    bridgeVersion: s.bridgeVersion,
    lastError: s.lastError,
  };
}

export async function mcpStatus(): Promise<McpStatus> {
  await recovered;
  return statusOf(await load());
}

// 비밀(다리 설정에 넣어야 해서 설정 화면이 보여 준다). 없으면 만든다.
export async function mcpSecret(): Promise<string> {
  await recovered;
  const s = await update((cur) => (cur.secret ? cur : { ...cur, secret: newSecret() }));
  return s.secret;
}

export async function mcpSet(patch: { enabled?: boolean; port?: number }): Promise<McpStatus> {
  await recovered;
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)) throw new Error("포트는 1024~65535 사이 정수여야 합니다.");
  const s = await update((cur) => ({
    ...cur,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.port !== undefined ? { port: patch.port } : {}),
    secret: cur.secret || newSecret(),
    lastError: "",
  }));
  restart();
  if (s.enabled) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  else await chrome.alarms.clear(ALARM).catch(() => false);
  return statusOf(s);
}

// 비밀을 새로 만든다(이전 다리 설정은 더 이상 통하지 않는다).
export async function mcpRegenerate(): Promise<McpStatus> {
  await recovered;
  const s = await update((cur) => ({ ...cur, secret: newSecret(), bridgeId: "", lastOkAt: 0, lastError: "" }));
  restart();
  return statusOf(s);
}

// ---- 다리와 주고받기 ----

class BridgeError extends Error {}

let keyCache: { secret: string; keys: McpKeys } | null = null;
async function keysOf(secret: string): Promise<McpKeys> {
  if (keyCache?.secret !== secret) keyCache = { secret, keys: await deriveKeys(secret) };
  return keyCache.keys;
}

async function bridgeFetch(s: McpState, method: "GET" | "POST", path: "/v1/next" | "/v1/result", value: unknown, signal: AbortSignal): Promise<unknown> {
  const keys = await keysOf(s.secret);
  const header = makeHeader(Date.now());
  const mac = await signRequest(keys, method, path, header);
  const aad = aadOf(method, path, header);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), FETCH_LIMIT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
        method,
        headers: { "x-sbp": header, "x-sbp-mac": mac, ...(method === "POST" ? { "content-type": "text/plain" } : {}) },
        body: method === "POST" ? await seal(keys.extEnc, aad, value) : undefined,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
      });
    } catch {
      throw new BridgeError(signal.aborted ? "멈춤" : "다리에 연결하지 못했습니다(실행 중인지, 포트가 같은지 확인).");
    }
    if (res.status === 401) throw new BridgeError("다리가 인증을 거절했습니다(비밀이 다릅니다).");
    if (!res.ok) throw new BridgeError(`다리 응답 오류(${res.status})`);
    const text = await res.text();
    try {
      return await open(keys.bridgeEnc, aad, text);
    } catch {
      // 비밀을 모르는 프로그램이 그 포트에 있다.
      throw new BridgeError("다리의 응답을 확인하지 못했습니다(다른 프로그램이 그 포트를 쓰고 있을 수 있습니다).");
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

// 결과는 몇 번 다시 보낸다(브라우저 작업은 다시 하지 않는다).
async function postResult(jobId: string, outcome: "ok" | "error" | "cancelled", text: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const s = await load();
    if (!s.enabled || !s.secret) return;
    try {
      await bridgeFetch(s, "POST", "/v1/result", { jobId, outcome, text }, loopAbort.signal);
      return;
    } catch (err) {
      if (loopAbort.signal.aborted) return;
      debugLog("mcp:result_retry", err instanceof Error ? err.message : String(err), "warn");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---- 수신 루프(하나만) ----

const runner = new RemoteRunner("mcp", { perRequest: true });
let looping = false;
// 루프가 도는 중에 다시 시작을 요청받았으면(설정 변경) 지금 루프가 끝난 뒤 새로 시작한다.
let rerun = false;
let loopAbort = new AbortController();
let lastContact = 0;
let current: { jobId: string; deadline: number } | null = null;

function restart(): void {
  loopAbort.abort();
  loopAbort = new AbortController();
  runner.drop();
  current = null;
  void loop();
}

async function loop(): Promise<void> {
  if (looping) {
    rerun = true;
    return;
  }
  looping = true;
  rerun = false;
  const signal = loopAbort.signal;
  const hold = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  let failures = 0;
  try {
    while (!signal.aborted) {
      const s = await load();
      if (!s.enabled || !s.secret) return;
      let next: McpNext | null;
      try {
        next = parseNext(await bridgeFetch(s, "GET", "/v1/next", undefined, signal));
        if (!next) throw new BridgeError("다리 응답 형식이 맞지 않습니다.");
      } catch (err) {
        if (signal.aborted) return;
        failures++;
        const why = err instanceof Error ? err.message : String(err);
        if (failures === 1) debugLog("mcp:poll_error", why, "warn");
        await update((cur) => ({ ...cur, lastError: why }));
        checkLease();
        // 실행 중이 아니면 몇 번 실패한 뒤 1분 알람에 맡긴다.
        if (failures >= MAX_LOOP_FAILURES && !runner.busy) return;
        await abortableSleep(Math.min(10_000, 1000 * 2 ** (failures - 1)), signal);
        continue;
      }
      failures = 0;
      lastContact = Date.now();
      await handleNext(s, next);
    }
  } finally {
    clearInterval(hold);
    looping = false;
    if (rerun) void loop();
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// 다리에 오래 닿지 않거나 기한이 지난 작업은 스스로 멈춘다(lease).
function checkLease(): void {
  if (!current || !runner.busy) return;
  if (Date.now() - lastContact > LEASE_MS || Date.now() > current.deadline) {
    debugLog("mcp:lease_expired", "", "warn");
    runner.stop();
  }
}

async function handleNext(s: McpState, n: McpNext): Promise<void> {
  // 다리가 바뀌었으면(다시 띄움) 대화·작업 탭·진행 중 작업을 버린다.
  if (n.bridgeId !== s.bridgeId) {
    if (s.bridgeId) runner.drop();
    const prev = s.job;
    await update((cur) => ({ ...cur, bridgeId: n.bridgeId, bridgeVersion: n.version, lastOkAt: Date.now(), lastError: "", job: prev && prev.bridgeId === n.bridgeId ? prev : null }));
  } else {
    await update((cur) => ({ ...cur, lastOkAt: Date.now(), lastError: "", bridgeVersion: n.version }));
  }
  // 서비스 워커가 다시 뜨기 전에 실행 중이던 작업: 다시 실행하지 않고 중단으로 보고한다.
  const st = await load();
  if (st.job?.state === "running" && st.job.bridgeId === n.bridgeId && current?.jobId !== st.job.jobId) {
    const jobId = st.job.jobId;
    await update((cur) => ({ ...cur, job: { ...st.job!, state: "finished" } }));
    void postResult(jobId, "error", "브라우저가 다시 시작되어 요청이 중단되었습니다. 다시 요청하세요.");
  }
  for (const id of n.cancel ?? []) {
    if (current?.jobId === id) {
      debugLog("mcp:cancel");
      runner.stop();
    }
    void postResult(id, "cancelled", "");
  }
  checkLease();
  if (n.job) startJob(n.bridgeId, n.job);
}

function startJob(bridgeId: string, job: NonNullable<McpNext["job"]>): void {
  void (async () => {
    const st = await load();
    // 같은 작업은 다시 실행하지 않는다.
    if (st.job?.jobId === job.jobId) return;
    if (runner.busy) {
      void postResult(job.jobId, "error", "브라우저 도우미가 앞의 요청을 처리하고 있습니다.");
      return;
    }
    await update((cur) => ({ ...cur, job: { bridgeId, jobId: job.jobId, state: "running" } }));
    const running = runner.run(job.request);
    if (!running) {
      void postResult(job.jobId, "error", "브라우저 도우미가 앞의 요청을 처리하고 있습니다.");
      return;
    }
    current = { jobId: job.jobId, deadline: job.deadline };
    debugLog("mcp:request", `${job.request.length}자`);
    running.start();
    const end = await running.end;
    if (current?.jobId === job.jobId) current = null;
    await update((cur) => (cur.job?.jobId === job.jobId ? { ...cur, job: { ...cur.job, state: "finished" } } : cur));
    if (end.status === "stopped") return postResult(job.jobId, "cancelled", "");
    if (end.status === "failed") return postResult(job.jobId, "error", remoteErrorText(undefined));
    if (end.result.outcome === "error") return postResult(job.jobId, "error", remoteErrorText(end.result.action));
    let text: string;
    try {
      text = (await maskStringForModel(end.result.finalText || "끝났습니다(답할 내용이 없습니다).")).text;
    } catch {
      return postResult(job.jobId, "error", "결과를 안전하게 보내지 못했습니다. 브라우저 패널에서 확인하세요.");
    }
    return postResult(job.jobId, "ok", text);
  })();
}

// ---- 알람·복구 ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void recovered.then(async () => {
    const s = await load();
    if (!s.enabled) await chrome.alarms.clear(ALARM).catch(() => false);
    else void loop();
  });
});

const recovered = (async () => {
  try {
    const s = await load();
    if (s.enabled) {
      if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
      void loop();
    }
  } catch (err) {
    debugLog("mcp:recover", err instanceof Error ? err.message : String(err), "warn");
  }
})();
