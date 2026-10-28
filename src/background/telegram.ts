// 텔레그램 연동(#139): 봇으로 받은 요청을 원격 대화(ChatAgent channel "telegram")로 처리하고 최종 답만 보낸다.
// - 원격 대화는 승인 카드가 필요한 동작을 하지 않는다(openrouter.ts의 원격 정책). 카드 내용·버튼을 보내지 않는다.
// - 허용 대상은 확인 코드로 연결한 개인 대화 하나(그 채팅의 그 사용자). 그 밖의 메시지는 답하지 않고 버린다.
// - 받기는 1분 알람마다, 요청을 처리하는 동안에는 이어서(/stop을 빨리 받으려고). 수신 루프는 하나만 돈다.
// - 토큰은 패널에 돌려주지 않고, 오류·로그에 요청 주소(토큰 포함)를 남기지 않는다.
import {
  backoffMs,
  checkPairing,
  newPairing,
  parseUpdate,
  remoteErrorText,
  splitMessage,
  staleMessage,
  type Pairing,
} from "@/lib/telegram";
import { RemoteRunner } from "./remoteRunner";
import { maskStringForModel } from "./loginSecrets";
import { onRepeatTriggered } from "./repeatTasks";
import { debugLog } from "./debug";

const STORE_KEY = "telegram";
const ALARM = "telegram-poll";
const API = "https://api.telegram.org";
const FAST_POLL_S = 20;
// 서비스 워커는 fetch 응답을 30초 넘게 기다리면 내려갈 수 있다.
const FETCH_LIMIT_MS = 25_000;
const RECENT = 5;

export interface TelegramRecent {
  at: number;
  preview: string;
  status: "running" | "done" | "stopped" | "failed" | "interrupted";
}

interface TelegramState {
  token: string;
  botName: string;
  chatId: number | null;
  chatLabel: string;
  connectedAt: number;
  epoch: number;
  offset: number;
  notifyRepeat: boolean;
  status: "idle" | "stopped_auth" | "stopped_conflict";
  failures: number;
  pairing: Pairing | null;
  recent: TelegramRecent[];
}

const EMPTY: TelegramState = {
  token: "",
  botName: "",
  chatId: null,
  chatLabel: "",
  connectedAt: 0,
  epoch: 0,
  offset: 0,
  notifyRepeat: false,
  status: "idle",
  failures: 0,
  pairing: null,
  recent: [],
};

// ---- 저장(한 줄로) ----

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function load(): Promise<TelegramState> {
  const raw = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  return raw && typeof raw === "object" ? { ...EMPTY, ...(raw as Partial<TelegramState>) } : { ...EMPTY };
}

// fn이 null을 돌려주면 바꾸지 않는다. epoch를 주면 그 연결 세대일 때만 바꾼다.
function update(fn: (s: TelegramState) => TelegramState | null, epoch?: number): Promise<TelegramState | null> {
  return serial(async () => {
    const cur = await load();
    if (epoch !== undefined && cur.epoch !== epoch) return null;
    const next = fn(cur);
    if (!next) return null;
    await chrome.storage.local.set({ [STORE_KEY]: next });
    return next;
  });
}

// ---- API 호출(토큰을 오류·로그에 남기지 않는다) ----

class TgError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly retryAfter = 0,
  ) {
    super(`텔레그램 ${method} 실패(${status || "연결 실패"})`);
    this.name = "TgError";
  }
}

async function tgCall<T>(token: string, method: string, params: Record<string, unknown>, signal?: AbortSignal, limitMs = FETCH_LIMIT_MS): Promise<T> {
  // 이미 멈춘 연결(연결 끊기·토큰 지우기)이면 보내지 않는다.
  if (signal?.aborted) throw new TgError(method, 0);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), limitMs);
  try {
    let res: Response;
    try {
      res = await fetch(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch {
      throw new TgError(method, 0);
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!res.ok || !body?.ok) throw new TgError(method, body?.error_code ?? res.status, body?.parameters?.retry_after ?? 0);
    return body.result as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// 평문으로 보낸다(마크다운 해석·링크 미리보기 없음). 429면 한 번 기다려 다시.
async function sendText(s: Pick<TelegramState, "token" | "chatId">, text: string, signal?: AbortSignal): Promise<void> {
  if (!s.token || s.chatId === null) return;
  for (const part of splitMessage(text)) {
    if (signal?.aborted) return;
    const params = { chat_id: s.chatId, text: part, link_preview_options: { is_disabled: true } };
    try {
      await tgCall(s.token, "sendMessage", params, signal);
    } catch (err) {
      if (err instanceof TgError && err.status === 429 && err.retryAfter > 0 && err.retryAfter <= 30) {
        await new Promise((r) => setTimeout(r, err.retryAfter * 1000));
        if (signal?.aborted) return;
        await tgCall(s.token, "sendMessage", params, signal);
      } else throw err;
    }
  }
}

// 자동 로그인 값을 가린 뒤 보낸다. 가림 목록을 못 읽으면 내용을 보내지 않는다.
async function sendMasked(s: Pick<TelegramState, "token" | "chatId">, text: string, signal?: AbortSignal): Promise<void> {
  let safe: string;
  try {
    safe = (await maskStringForModel(text)).text;
  } catch {
    safe = "결과를 안전하게 보내지 못했습니다. 패널에서 확인해 주세요.";
  }
  if (signal?.aborted) return;
  await sendText(s, safe, signal);
}

// ---- 연결 관리(설정 화면) ----

export interface TelegramStatus {
  hasToken: boolean;
  botName: string;
  connected: boolean;
  chatLabel: string;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  status: TelegramState["status"];
  notifyRepeat: boolean;
  recent: TelegramRecent[];
}

function statusOf(s: TelegramState): TelegramStatus {
  const pairing = s.pairing && Date.now() <= s.pairing.expiresAt ? s.pairing : null;
  return {
    hasToken: !!s.token,
    botName: s.botName,
    connected: s.chatId !== null,
    chatLabel: s.chatLabel,
    pairingCode: pairing?.code ?? null,
    pairingExpiresAt: pairing?.expiresAt ?? null,
    status: s.status,
    notifyRepeat: s.notifyRepeat,
    recent: s.recent,
  };
}

export async function telegramStatus(): Promise<TelegramStatus> {
  await recovered;
  const s = await load();
  // 확인 코드를 기다리는 동안 설정 화면이 상태를 물으면 한 번 받아 본다(알람을 기다리지 않고 연결이 빨리 끝나게).
  if (s.pairing && s.chatId === null) await receive(0);
  return statusOf(await load());
}

// 토큰을 확인(getMe)하고 저장한다. 다른 토큰이면 연결·기록을 모두 새로 시작한다.
export async function telegramSaveToken(raw: string): Promise<TelegramStatus> {
  await recovered;
  const token = raw.trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("봇 토큰 모양이 아닙니다. BotFather가 준 토큰(숫자:글자)을 그대로 붙여 넣으세요.");
  let me: { username?: string; first_name?: string };
  try {
    me = await tgCall(token, "getMe", {});
  } catch (err) {
    throw new Error(err instanceof TgError && err.status === 401 ? "텔레그램이 이 토큰을 받지 않았습니다. 토큰을 다시 확인하세요." : "텔레그램에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
  }
  endSession("토큰을 바꿈");
  const s = await update((cur) => ({ ...EMPTY, epoch: cur.epoch + 1, token, botName: me.username ? `@${me.username}` : (me.first_name ?? "봇"), notifyRepeat: cur.notifyRepeat }));
  debugLog("telegram:token", s?.botName ?? "");
  return statusOf(s ?? (await load()));
}

// 확인 코드를 만든다. 이 코드를 봇과의 개인 대화에 보내면 그 대화가 허용 대상이 된다.
export async function telegramStartPairing(): Promise<TelegramStatus> {
  await recovered;
  const s = await update((cur) => {
    if (!cur.token) return null;
    return { ...cur, pairing: newPairing(Date.now(), secureRandom), status: "idle", failures: 0 };
  });
  if (!s) throw new Error("먼저 봇 토큰을 저장하세요.");
  await ensureAlarm();
  void receive(0);
  return statusOf(s);
}

export async function telegramDisconnect(): Promise<TelegramStatus> {
  await recovered;
  endSession("연결 끊기");
  const s = await update((cur) => ({ ...cur, epoch: cur.epoch + 1, chatId: null, chatLabel: "", connectedAt: 0, pairing: null, status: "idle", failures: 0 }));
  await chrome.alarms.clear(ALARM).catch(() => false);
  return statusOf(s ?? (await load()));
}

export async function telegramClear(): Promise<TelegramStatus> {
  await recovered;
  endSession("토큰 지우기");
  const s = await update((cur) => ({ ...EMPTY, epoch: cur.epoch + 1 }));
  await chrome.alarms.clear(ALARM).catch(() => false);
  return statusOf(s ?? (await load()));
}

export async function telegramSetNotify(on: boolean): Promise<TelegramStatus> {
  await recovered;
  const s = await update((cur) => ({ ...cur, notifyRepeat: on }));
  return statusOf(s ?? (await load()));
}

function secureRandom(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

// ---- 받기 ----

type PollResult = "ok" | "error" | "stopped";
let receiving: Promise<PollResult> | null = null;
let pollAbort: AbortController | null = null;

// 수신 루프는 하나만: 이미 받는 중이면 그 결과를 기다린다.
function receive(timeoutS: number): Promise<PollResult> {
  if (!receiving) {
    receiving = pollOnce(timeoutS).finally(() => {
      receiving = null;
    });
  }
  return receiving;
}

async function pollOnce(timeoutS: number): Promise<PollResult> {
  const s = await load();
  if (!s.token || s.status !== "idle" || (s.chatId === null && !s.pairing)) return "stopped";
  const epoch = s.epoch;
  // 이 받기가 속한 연결. 그 뒤 연결을 끊거나 토큰을 바꾸면 이 받기에서 나온 요청은 실행하지 않는다.
  const conn = connAbort.signal;
  pollAbort = new AbortController();
  let updates: Array<{ update_id: number }>;
  try {
    // 전체 요청을 25초 안에 끝낸다(서비스 워커는 fetch 응답을 30초 넘게 기다리면 내려갈 수 있다). 대기는 그보다 짧게.
    updates = await tgCall(s.token, "getUpdates", { offset: s.offset, timeout: Math.min(timeoutS, 20), allowed_updates: ["message", "callback_query"] }, pollAbort.signal);
  } catch (err) {
    if (pollAbort.signal.aborted) return "stopped";
    const status = err instanceof TgError ? err.status : 0;
    // 401: 토큰 무효, 409: 다른 곳(웹훅·다른 폴러)이 같은 봇을 쓴다. 알람이 다시 켜지 않는다.
    const stop = status === 401 ? "stopped_auth" : status === 409 ? "stopped_conflict" : null;
    await update((cur) => ({ ...cur, status: stop ?? cur.status, failures: stop ? cur.failures : cur.failures + 1 }), epoch);
    debugLog("telegram:poll_error", String(status), "warn");
    return stop ? "stopped" : "error";
  } finally {
    pollAbort = null;
  }
  if (s.failures) await update((cur) => ({ ...cur, failures: 0 }), epoch);
  for (const u of [...updates].sort((a, b) => a.update_id - b.update_id)) {
    // 처리하기 전에 다음 offset을 저장한다(같은 메시지를 두 번 실행하지 않는다 — 저장하지 못하면 실행하지 않는다).
    const saved = await update((cur) => (u.update_id < cur.offset ? null : { ...cur, offset: u.update_id + 1 }), epoch).catch(() => null);
    if (!saved) continue;
    if (conn.aborted) return "stopped";
    await handleUpdate(saved, u, conn);
  }
  return "ok";
}

async function handleUpdate(s: TelegramState, u: unknown, conn: AbortSignal): Promise<void> {
  const a = parseUpdate(u, s.chatId);
  const now = Date.now();
  switch (a.kind) {
    case "ignore":
    case "callback":
      return;
    case "pair": {
      const r = checkPairing(s.pairing, a.code, now);
      if (!r.ok) {
        await update((cur) => ({ ...cur, pairing: r.next }), s.epoch);
        return;
      }
      if (now - a.at > 10 * 60_000) return;
      const next = await update((cur) => (cur.chatId !== null ? null : { ...cur, chatId: a.chatId, chatLabel: a.label, connectedAt: now, pairing: null }), s.epoch);
      if (!next) return;
      debugLog("telegram:paired");
      await ensureAlarm();
      await sendText(next, "간편 브라우저 도우미와 연결되었습니다. 할 일을 보내면 브라우저에서 처리하고 답을 보냅니다. /help로 사용법을 볼 수 있습니다.").catch(() => {});
      return;
    }
    case "command":
      if (staleMessage(a.at, s.connectedAt, now)) return;
      if (a.command === "help") await sendText(s, HELP).catch(() => {});
      else if (a.command === "stop") await sendText(s, stopRun() ? "멈췄습니다." : "진행 중인 요청이 없습니다.").catch(() => {});
      else {
        stopRun();
        runner.drop();
        await sendText(s, "새 대화를 시작합니다.").catch(() => {});
      }
      return;
    case "text":
      if (staleMessage(a.at, s.connectedAt, now)) {
        await sendText(s, "오래된 요청이라 실행하지 않았습니다. 다시 보내 주세요.").catch(() => {});
        return;
      }
      if (runner.busy || sending > 0) {
        await sendText(s, "앞의 요청을 처리하고 있습니다. /stop으로 멈출 수 있습니다.").catch(() => {});
        return;
      }
      if (conn.aborted) return;
      startRun(s, a.text, conn);
      return;
  }
}

const HELP = [
  "간편 브라우저 도우미 텔레그램 연동",
  "- 할 일을 글로 보내면 브라우저의 새 탭에서 처리하고 최종 답만 보냅니다. 예: \"naver.com에서 오늘 날씨 알려 줘\"",
  "- 이동은 요청에 적은 사이트 안에서만 합니다. 결제·삭제·개인정보 입력·로그인·저장 같은 승인이 필요한 동작은 하지 않습니다(패널에서 요청하세요).",
  "- /stop: 진행 중인 요청 멈추기, /new: 새 대화",
  "- 브라우저가 켜져 있어야 하고, 받는 데 최대 1분쯤 걸립니다.",
].join("\n");

// ---- 실행 ----

const runner = new RemoteRunner("telegram");
// 연결 세대마다 하나. 연결 끊기·토큰 바꾸기·지우기에서 끊어, 진행 중인 결과 보내기(가림·나눠 보내기·재시도 포함)를 멈춘다.
let connAbort = new AbortController();
// 답을 보내는 중(가림·나눠 보내기·재시도)인 요청 수. 그동안에는 다음 요청을 받지 않는다(답이 섞이거나 순서가 뒤바뀌지 않게).
let sending = 0;

// 답을 보내는 중인 요청의 중단(실행이 끝나 실행부의 슬롯이 빈 뒤에도 /stop·/new가 보내기를 멈추게).
let sendAbort: AbortController | null = null;

function stopRun(): boolean {
  const stopped = runner.stop();
  if (sendAbort) {
    sendAbort.abort();
    sendAbort = null;
    return true;
  }
  return stopped;
}

// 연결 끊기·토큰 바꾸기: 진행 중인 요청·받기를 멈추고 대화를 버린다.
function endSession(why: string): void {
  if (runner.busy) debugLog("telegram:stop", why);
  pollAbort?.abort();
  connAbort.abort();
  connAbort = new AbortController();
  sendAbort?.abort();
  sendAbort = null;
  runner.drop();
}

function startRun(s: TelegramState, text: string, conn: AbortSignal): void {
  // 요청을 처리하는 동안에는 이어서 받아 /stop을 빨리 처리한다. 받기가 멈췄으면(401·409·연결 끊기) 그만, 실패는 간격을 둔다.
  const run = runner.run(text, (mine) => {
    void (async () => {
      let failures = 0;
      while (mine()) {
        const r = await receive(FAST_POLL_S);
        if (r === "stopped") break;
        failures = r === "error" ? failures + 1 : 0;
        if (failures) await new Promise((res) => setTimeout(res, Math.min(20_000, backoffMs(failures))));
      }
    })();
  });
  if (!run) return;
  debugLog("telegram:request", `${text.length}자`);
  // 이 요청의 중단(/stop·새 대화)과 연결 끊기: 실행과 결과 보내기(가림·나눠 보내기·재시도)를 함께 멈춘다.
  const sendCtl = new AbortController();
  sendAbort = sendCtl;
  const out = AbortSignal.any([conn, run.signal, sendCtl.signal]);
  sending++;
  void (async () => {
    const at = Date.now();
    let status: TelegramRecent["status"] = "failed";
    try {
      const recorded = await update((st) => ({ ...st, recent: [{ at, preview: text.slice(0, 40), status: "running" as const }, ...st.recent].slice(0, RECENT) }), s.epoch);
      // 그 사이 연결이 바뀌었으면(끊기·토큰 바꾸기) 실행하지 않는다.
      if (!recorded || out.aborted) {
        runner.stop();
        await run.end;
        status = "stopped";
        return;
      }
      void tgCall(s.token, "sendChatAction", { chat_id: s.chatId, action: "typing" }, out).catch(() => {});
      run.start();
      const end = await run.end;
      if (end.status === "stopped" || out.aborted) {
        status = "stopped";
        return;
      }
      if (end.status === "failed") {
        debugLog("telegram:run_error", end.error instanceof Error ? end.error.message : String(end.error), "warn");
        await sendText(s, remoteErrorText(undefined), out);
        return;
      }
      if (end.result.outcome === "error") {
        await sendText(s, remoteErrorText(end.result.action), out);
        return;
      }
      await sendMasked(s, end.result.finalText || "끝났습니다(답할 내용이 없습니다).", out);
      // 보낸 뒤에 기록한다(보내다 멈췄으면 멈춤, 보내기가 실패하면 catch에서 실패로 남는다).
      status = out.aborted ? "stopped" : "done";
    } catch (err) {
      debugLog("telegram:send_error", err instanceof Error ? err.message : String(err), "warn");
      // 시작하기 전에 실패했으면(요청 기록 저장 등) 잡아 둔 슬롯을 놓는다.
      runner.stop();
    } finally {
      sending--;
      if (sendAbort === sendCtl) sendAbort = null;
      await update((st) => ({ ...st, recent: st.recent.map((r) => (r.at === at && r.status === "running" ? { ...r, status } : r)) }), s.epoch).catch(() => {});
    }
  })();
}

// ---- 알람·복구 ----

async function ensureAlarm(): Promise<void> {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  void recovered.then(async () => {
    const s = await load();
    if (!s.token || (s.chatId === null && !s.pairing)) {
      await chrome.alarms.clear(ALARM).catch(() => false);
      return;
    }
    // 실패가 이어지면 알람 몇 번을 건너뛴다(1분 단위 백오프).
    if (s.failures > 1 && Math.random() * (backoffMs(s.failures) / 60_000) > 1) return;
    await receive(0);
  });
});

// 서비스 워커가 다시 뜨면: 진행 중이던 요청은 중단된 것으로 기록하고 알린다(자동으로 다시 실행하지 않는다).
const recovered = (async () => {
  try {
    const s = await load();
    if (s.recent.some((r) => r.status === "running")) {
      const next = await update((cur) => ({ ...cur, recent: cur.recent.map((r) => (r.status === "running" ? { ...r, status: "interrupted" as const } : r)) }));
      if (next && next.chatId !== null) await sendText(next, "브라우저가 다시 시작되어 진행 중이던 요청이 중단되었습니다. 필요하면 다시 보내 주세요.").catch(() => {});
    }
    if (s.token && (s.chatId !== null || s.pairing)) await ensureAlarm();
  } catch (err) {
    debugLog("telegram:recover", err instanceof Error ? err.message : String(err), "warn");
  }
})();

// 반복 작업 알림(설정에서 켰을 때만): 제목만 보내고 확인 결과의 이유·할 일은 보내지 않는다.
onRepeatTriggered(async (t) => {
  // 이 알림이 속한 연결(그 사이 끊거나 토큰을 바꾸면 보내지 않는다).
  const conn = connAbort.signal;
  const s = await load();
  if (conn.aborted || !s.notifyRepeat || s.chatId === null || s.status !== "idle") return;
  await sendMasked(s, `반복 작업 ‘${t.title}’의 조건이 맞았습니다. 패널에서 ‘이어서 진행’을 누르세요.`, conn).catch(() => {});
});

// 하네스(tests/harness/scenarios/telegram.mjs)가 알람을 기다리지 않고 받기를 부르는 진입점. 서비스 워커 안에서만 보인다.
(globalThis as { __sbpTelegram?: unknown }).__sbpTelegram = { poll: () => receive(0) };
