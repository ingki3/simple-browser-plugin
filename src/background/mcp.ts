// MCP 연동(#140): 로컬 다리(mcp/sbp-mcp.mjs)를 폴링해 다른 AI 도구의 요청을 원격 대화(channel "mcp")로 처리하고 최종 답을 돌려준다.
// - 다리와는 설정의 비밀로 서로를 확인하고 본문을 암호화한다(src/lib/mcpProtocol.ts). 응답을 복호화하지 못하면 버린다.
// - 원격 정책은 텔레그램과 같다(openrouter.ts의 원격 정책). 승인이 필요한 이동·클릭은 설정 "MCP 클라이언트에 승인 묻기"(기본 끔)를
//   켜고 다리·클라이언트가 form elicitation을 지원할 때만 다리를 거쳐 클라이언트에 묻는다(#185 — 승인을 클라이언트 프로그램에 맡기는 것).
// - 작업 계약: 실행 전에 작업 id를 저장하고 같은 작업은 다시 실행하지 않는다. 결과 전송만 다시 시도한다. 다리에 60초 넘게 닿지 않거나
//   기한이 지나면 스스로 멈춘다. 서비스 워커가 다시 뜨면 진행 중이던 작업은 중단으로 보고한다(자동 재실행 없음).
import {
  MCP_DEFAULT_PORT,
  aadOf,
  b64url,
  deriveKeys,
  makeHeader,
  newSecret,
  open,
  parseNext,
  seal,
  signRequest,
  type McpAskResult,
  type McpKeys,
  type McpNext,
} from "@/lib/mcpProtocol";
import type { RemoteApprover, RemoteAskResult, RemoteQuestion } from "@/lib/remoteApproval";
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
}

// 보내지 못한 결과(다리가 받았다고 답할 때까지 다시 보낸다 — 브라우저 작업은 다시 하지 않는다).
interface McpPending {
  bridgeId: string;
  jobId: string;
  outcome: "ok" | "error";
  text: string;
}

interface McpState {
  enabled: boolean;
  port: number;
  secret: string;
  bridgeId: string;
  bridgeVersion: string;
  lastOkAt: number;
  lastError: string;
  // 승인이 필요한 이동·클릭을 MCP 클라이언트에 묻기(#185, 기본 끔 — 클라이언트 프로그램에 승인을 맡긴다).
  askApproval: boolean;
  // 실행 중인 작업(서비스 워커가 다시 뜨면 중단으로 보고한다).
  job: McpJob | null;
  pending: McpPending | null;
  // 이미 맡은 작업 id(최근 20개). 다리가 같은 작업을 다시 보내도 다시 실행하지 않는다(서비스 워커가 다시 뜬 뒤에도).
  seen: string[];
}

const EMPTY: McpState = { enabled: false, port: MCP_DEFAULT_PORT, secret: "", bridgeId: "", bridgeVersion: "", lastOkAt: 0, lastError: "", askApproval: false, job: null, pending: null, seen: [] };

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
  askApproval: boolean;
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
    askApproval: s.askApproval,
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

export async function mcpSet(patch: { enabled?: boolean; port?: number; askApproval?: boolean }): Promise<McpStatus> {
  await recovered;
  // 승인 묻기만 바꾸면 연결은 그대로 두고, 끄면 기다리는 질문을 거둔다(물을 수 없는 것으로).
  if (patch.askApproval !== undefined && patch.enabled === undefined && patch.port === undefined) {
    const s = await update((cur) => ({ ...cur, askApproval: patch.askApproval === true }));
    askEnabled = s.askApproval;
    if (!askEnabled) for (const w of [...askWaiters.values()]) w.cancel("unavailable");
    return statusOf(s);
  }
  if (patch.port !== undefined && (!Number.isInteger(patch.port) || patch.port < 1024 || patch.port > 65535)) throw new Error("포트는 1024~65535 사이 정수여야 합니다.");
  const s = await update((cur) => ({
    ...cur,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.port !== undefined ? { port: patch.port } : {}),
    secret: cur.secret || newSecret(),
    ...(patch.askApproval !== undefined ? { askApproval: patch.askApproval } : {}),
    lastError: "",
  }));
  askEnabled = s.askApproval;
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

async function bridgeFetch(s: McpState, method: "GET" | "POST", path: "/v1/next" | "/v1/result" | "/v1/ask", value: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new BridgeError("멈춤");
  const keys = await keysOf(s.secret);
  const header = makeHeader(Date.now());
  const mac = await signRequest(keys, method, path, header);
  const aad = aadOf(method, path, header);
  const body = method === "POST" ? await seal(keys.extEnc, aad, value) : undefined;
  // 키·서명·봉인을 기다리는 사이 멈췄으면 보내지 않는다.
  if (signal.aborted) throw new BridgeError("멈춤");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_LIMIT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
        method,
        headers: { "x-sbp": header, "x-sbp-mac": mac, ...(method === "POST" ? { "content-type": "text/plain" } : {}) },
        body,
        signal: AbortSignal.any([signal, controller.signal]),
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
  }
}

// 다리에 결과를 보낸다(몇 번 다시 시도). conn: 작업을 받을 때의 연결 — 그 뒤 설정이 바뀌었으면(세대가 다르면) 보내지 않는다.
async function postResult(conn: Conn, jobId: string, outcome: "ok" | "error" | "cancelled" | "accepted", text: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (conn.gen !== connGen) return false;
    try {
      await bridgeFetch(conn.s, "POST", "/v1/result", { jobId, outcome, text }, loopAbort.signal);
      return true;
    } catch (err) {
      if (loopAbort.signal.aborted || conn.gen !== connGen) return false;
      debugLog("mcp:result_retry", err instanceof Error ? err.message : String(err), "warn");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

// 최종 결과: 먼저 저장해 두고(서비스 워커가 내려가도 다시 보낼 수 있게) 보낸 뒤 지운다.
let delivering = false;
async function deliver(conn: Conn, p: McpPending): Promise<void> {
  if (conn.gen !== connGen) return;
  await update((cur) => ({ ...cur, pending: p }));
  if (delivering) return;
  delivering = true;
  try {
    if (await postResult(conn, p.jobId, p.outcome, p.text)) await update((cur) => (cur.pending?.jobId === p.jobId ? { ...cur, pending: null } : cur));
  } finally {
    delivering = false;
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
// 연결 세대. 설정(켜기·포트·비밀)이 바뀔 때마다 올린다. 그 전에 받은 작업은 시작하지 않고, 그 결과는 새 연결로 보내지 않는다.
let connGen = 0;
interface Conn {
  gen: number;
  s: McpState;
}

function restart(): void {
  connGen++;
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
      // 이 폴링을 보낼 때의 연결 세대. 응답을 받는 사이 설정이 바뀌었으면 그 응답(작업)은 쓰지 않는다.
      const gen = connGen;
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
      if (signal.aborted || gen !== connGen) return;
      failures = 0;
      lastContact = Date.now();
      await handleNext({ gen, s }, next);
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

async function handleNext(conn: Conn, n: McpNext): Promise<void> {
  const s = conn.s;
  // 다리가 바뀌었으면(다시 띄움) 대화·작업 탭·진행 중 작업과 보내지 못한 결과를 버린다(예전 다리는 받을 수 없다).
  if (n.bridgeId !== s.bridgeId) {
    if (s.bridgeId) runner.drop();
    const keepJob = s.job?.bridgeId === n.bridgeId ? s.job : null;
    const keepPending = s.pending?.bridgeId === n.bridgeId ? s.pending : null;
    conn.s = await update((cur) => ({ ...cur, bridgeId: n.bridgeId, bridgeVersion: n.version, lastOkAt: Date.now(), lastError: "", job: keepJob, pending: keepPending }));
  } else {
    conn.s = await update((cur) => ({ ...cur, lastOkAt: Date.now(), lastError: "", bridgeVersion: n.version }));
  }
  const st = conn.s;
  bridgeFeatures = n.features ?? [];
  // 승인 질문의 답: 지금 작업의 기다리는 질문이면 전하고, 어느 경우든 받았다고 알린다(다리가 다시 보내지 않게).
  for (const a of n.answers ?? []) {
    const w = askWaiters.get(a.askId);
    if (w && current?.jobId === a.jobId && w.jobId === a.jobId) w.answer(a.result);
    else void postAsk(conn, { op: "ack", jobId: a.jobId, askId: a.askId }, cleanupSignal());
  }
  // 서비스 워커가 다시 뜨기 전에 실행 중이던 작업: 다시 실행하지 않고 중단으로 보고한다.
  if (st.job && st.job.bridgeId === n.bridgeId && current?.jobId !== st.job.jobId) {
    const jobId = st.job.jobId;
    conn.s = await update((cur) => ({ ...cur, job: null }));
    void deliver(conn, { bridgeId: n.bridgeId, jobId, outcome: "error", text: "브라우저가 다시 시작되어 요청이 중단되었습니다. 다시 요청하세요." });
  } else if (st.pending && st.pending.bridgeId === n.bridgeId && !delivering) {
    // 보내지 못한 결과를 다시 보낸다.
    void deliver(conn, st.pending);
  }
  for (const id of n.cancel ?? []) {
    // 진행 중인 작업이면 멈추고, 실행이 끝난 뒤 취소 확인을 보낸다(startJob). 모르는 작업이면 바로 확인한다.
    if (current?.jobId === id) {
      debugLog("mcp:cancel");
      runner.stop();
    } else void postResult(conn, id, "cancelled", "");
  }
  checkLease();
  if (n.job) {
    const j = n.job;
    // 이미 받은 작업(받았다는 확인을 다리가 못 받아 다시 보냄): 다시 실행하지 않고 확인만 다시 보낸다.
    const latest = await load();
    if (current?.jobId === j.jobId || latest.seen.includes(j.jobId) || latest.pending?.jobId === j.jobId) void postResult(conn, j.jobId, "accepted", "");
    else startJob(conn, n.bridgeId, j);
  }
}

function startJob(conn: Conn, bridgeId: string, job: NonNullable<McpNext["job"]>): void {
  void (async () => {
    if (runner.busy) {
      void postResult(conn, job.jobId, "error", "브라우저 도우미가 앞의 요청을 처리하고 있습니다.");
      return;
    }
    // 실행하기 전에 작업 id를 저장한다(같은 작업을 다시 실행하지 않고, 다시 뜨면 중단으로 보고하게).
    await update((cur) => ({ ...cur, job: { bridgeId, jobId: job.jobId }, seen: [...cur.seen.filter((x) => x !== job.jobId), job.jobId].slice(-20) }));
    // 그 사이 설정이 바뀌었거나(끄기·포트·비밀) 다른 작업이 시작했으면 실행하지 않는다.
    if (conn.gen !== connGen || runner.busy) {
      await update((cur) => (cur.job?.jobId === job.jobId ? { ...cur, job: null } : cur));
      return;
    }
    const running = runner.run(job.request, undefined, approverFor(conn, job));
    if (!running) return;
    current = { jobId: job.jobId, deadline: job.deadline };
    void postResult(conn, job.jobId, "accepted", "");
    debugLog("mcp:request", `${job.request.length}자`);
    running.start();
    const end = await running.end;
    if (current?.jobId === job.jobId) current = null;
    await update((cur) => (cur.job?.jobId === job.jobId ? { ...cur, job: null } : cur));
    if (conn.gen !== connGen) return;
    if (end.status === "stopped") {
      void postResult(conn, job.jobId, "cancelled", "");
      return;
    }
    let p: McpPending;
    if (end.status === "failed") p = { bridgeId, jobId: job.jobId, outcome: "error", text: remoteErrorText(undefined) };
    else if (end.result.outcome === "error") p = { bridgeId, jobId: job.jobId, outcome: "error", text: remoteErrorText(end.result.action) };
    else {
      try {
        p = { bridgeId, jobId: job.jobId, outcome: "ok", text: (await maskStringForModel(end.result.finalText || "끝났습니다(답할 내용이 없습니다).")).text };
      } catch {
        p = { bridgeId, jobId: job.jobId, outcome: "error", text: "결과를 안전하게 보내지 못했습니다. 브라우저 패널에서 확인하세요." };
      }
    }
    await deliver(conn, p);
  })();
}

// ---- 승인 질문(#185) ----

const ASK_TTL_MS = 5 * 60_000;
// 다리가 알린 기능(구 다리는 없음 → 묻지 않는다)과 설정.
let bridgeFeatures: string[] = [];
let askEnabled = false;
// 기다리는 질문(askId → 답·거두기). 답은 /v1/next의 answers로 온다.
const askWaiters = new Map<string, { jobId: string; answer(r: McpAskResult): void; cancel(r: "unavailable"): void }>();

// ack·withdraw는 턴 신호도 연결 세대도 보지 않는다 — 턴이 끝났거나 설정을 바꿔 연결을 다시 시작한 뒤에도(restart) 질문을 보낸
// 그 다리에 닿아야 클라이언트의 질문 창이 닫힌다. 그 연결 정보(conn.s)로 보내고 10초가 지나면 그만.
function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(10_000);
}

type AskBody = { op: "ask" | "ack" | "withdraw"; jobId: string; askId: string; message?: string };

// /v1/ask를 같은 본문으로 몇 번 다시 보낸다(1·2·4초). 다리는 같은 id·같은 본문을 멱등으로 처리한다.
async function postAsk(conn: Conn, body: AskBody, signal: AbortSignal): Promise<{ ok: boolean; state?: string } | null> {
  // 정리(ack·withdraw)는 연결이 바뀐 뒤에도 보낸다. 새 질문(ask)은 지금 연결일 때만.
  const cleanup = body.op !== "ask";
  for (let i = 0; i < 3; i++) {
    if ((!cleanup && conn.gen !== connGen) || signal.aborted) return null;
    try {
      const r = (await bridgeFetch(conn.s, "POST", "/v1/ask", body, signal)) as { ok?: unknown; state?: unknown } | null;
      return { ok: r?.ok === true, state: typeof r?.state === "string" ? r.state : undefined };
    } catch (err) {
      if (signal.aborted || (!cleanup && conn.gen !== connGen)) return null;
      debugLog("mcp:ask_retry", `${body.op} · ${err instanceof Error ? err.message : String(err)}`, "warn");
      await abortableSleep(1000 * 2 ** i, signal);
    }
  }
  return null;
}

function approverFor(conn: Conn, job: NonNullable<McpNext["job"]>): RemoteApprover {
  return {
    canAsk: () => askEnabled && conn.gen === connGen && bridgeFeatures.includes("ask") && job.canAsk === true,
    ask: (q, signal) => askByBridge(conn, job, q, signal),
  };
}

async function askByBridge(conn: Conn, job: NonNullable<McpNext["job"]>, q: RemoteQuestion, signal: AbortSignal): Promise<RemoteAskResult> {
  if (signal.aborted) return "aborted";
  // 부르는 쪽이 canAsk를 본 뒤 기다리는 사이(자동 로그인 값 검사 등) 설정을 끄거나 연결을 바꿨을 수 있다. 등록 직전에 다시 본다
  // (여기서 등록까지 await가 없어, 그 뒤 끄면 mcpSet이 이 질문을 거둔다).
  if (!askEnabled || conn.gen !== connGen || !bridgeFeatures.includes("ask") || job.canAsk !== true) return "unavailable";
  const expiresAt = Math.min(Date.now() + ASK_TTL_MS, job.deadline - 30_000);
  if (expiresAt <= Date.now()) return "unavailable";
  const askId = b64url(crypto.getRandomValues(new Uint8Array(16)));
  type Outcome = McpAskResult | "expired" | "aborted" | "unavailable";
  let resolve!: (v: Outcome) => void;
  const settled = new Promise<Outcome>((r) => (resolve = r));
  let done = false;
  // 질문 보내기(재시도 포함)의 중단. 결과가 정해지면(설정 끔·만료·중단·답) 더 보내지 않는다.
  const sendCtl = new AbortController();
  const settle = (v: Outcome) => {
    if (done) return;
    done = true;
    sendCtl.abort();
    askWaiters.delete(askId);
    clearTimeout(timer);
    resolve(v);
  };
  // 보내기 전에 기다림을 등록한다(답이 /v1/ask 응답보다 먼저 와도 받게). 답은 절대 만료 시각으로 다시 본다.
  askWaiters.set(askId, {
    jobId: job.jobId,
    answer: (r) => settle(Date.now() > expiresAt ? "expired" : r),
    cancel: (r) => settle(r),
  });
  const timer = setTimeout(() => settle("expired"), expiresAt - Date.now());
  const onAbort = () => settle("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  const sent = await postAsk(conn, { op: "ask", jobId: job.jobId, askId, message: q.text }, AbortSignal.any([loopAbort.signal, signal, sendCtl.signal]));
  if (!sent || !sent.ok || sent.state === "withdrawn" || sent.state === "gone") settle("unavailable");
  const r = await settled;
  signal.removeEventListener("abort", onAbort);
  if (r === "approved" || r === "denied" || r === "cancelled" || r === "error") {
    void postAsk(conn, { op: "ack", jobId: job.jobId, askId }, cleanupSignal());
    return r === "error" ? "unavailable" : r;
  }
  // 만료·중단·보내지 못함: 다리에 질문을 거두게 한다(클라이언트의 질문 창을 닫고 늦은 답을 버린다).
  void postAsk(conn, { op: "withdraw", jobId: job.jobId, askId }, cleanupSignal());
  return r;
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
    askEnabled = s.askApproval;
    if (s.enabled) {
      if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
      void loop();
    }
  } catch (err) {
    debugLog("mcp:recover", err instanceof Error ? err.message : String(err), "warn");
  }
})();
