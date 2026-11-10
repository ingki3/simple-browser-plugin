// 텔레그램 연동(#139)의 순수 함수: 받은 업데이트 해석, 확인 코드 대조, 보낼 글 나누기, 재시도 간격.
// 네트워크·저장·대화 객체는 src/background/telegram.ts. npm test(Node 타입 제거 실행)로 시험하므로 다른 모듈을 불러오지 않는다.
// 명령(/new 등)은 정확한 글자 비교이며 승인과 관계없다.

export const TELEGRAM_MAX_TEXT = 4096;
export const TELEGRAM_MAX_PARTS = 4;
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_TRIES = 5;

export interface Pairing {
  code: string;
  expiresAt: number;
  tries: number;
}

export type TelegramCommand = "new" | "stop" | "help";

export type UpdateAction =
  | { kind: "pair"; chatId: number; label: string; code: string; at: number }
  | { kind: "command"; command: TelegramCommand; at: number }
  | { kind: "text"; text: string; at: number }
  | { kind: "callback"; queryId: string; data: string }
  | { kind: "ignore" };

interface RawChat {
  id?: unknown;
  type?: unknown;
  username?: unknown;
  first_name?: unknown;
}

// 업데이트 하나를 해석한다. chatId가 없으면(연결 전) 개인 대화의 글만 확인 코드 후보로 본다. 연결된 뒤에는 그 채팅의
// 개인 대화에서 온 글·버튼만 받는다. 그 밖은 모두 버린다(답하지 않는다).
export function parseUpdate(u: unknown, chatId: number | null): UpdateAction {
  if (!u || typeof u !== "object") return { kind: "ignore" };
  const upd = u as { message?: unknown; callback_query?: unknown };
  if (upd.callback_query && typeof upd.callback_query === "object") {
    const q = upd.callback_query as { id?: unknown; data?: unknown; from?: { id?: unknown }; message?: { chat?: RawChat } };
    if (chatId === null) return { kind: "ignore" };
    const chat = q.message?.chat;
    if (typeof q.id !== "string" || typeof q.data !== "string") return { kind: "ignore" };
    if (q.from?.id !== chatId || chat?.id !== chatId || chat?.type !== "private") return { kind: "ignore" };
    return { kind: "callback", queryId: q.id, data: q.data };
  }
  if (!upd.message || typeof upd.message !== "object") return { kind: "ignore" };
  const m = upd.message as { chat?: RawChat; from?: { id?: unknown; is_bot?: unknown }; text?: unknown; date?: unknown };
  const chat = m.chat;
  if (!chat || typeof chat.id !== "number" || chat.type !== "private") return { kind: "ignore" };
  if (m.from?.is_bot === true || m.from?.id !== chat.id) return { kind: "ignore" };
  if (typeof m.text !== "string") return { kind: "ignore" };
  const text = m.text.trim();
  // 보낸 시각(텔레그램은 초 단위). 없으면 0(오래된 것으로 본다).
  const at = typeof m.date === "number" ? m.date * 1000 : 0;
  if (chatId === null) {
    const code = pairingCodeOf(text);
    if (!code) return { kind: "ignore" };
    const label = typeof chat.username === "string" ? `@${chat.username}` : typeof chat.first_name === "string" ? chat.first_name : "";
    return { kind: "pair", chatId: chat.id, label: label.slice(0, 40), code, at };
  }
  if (chat.id !== chatId) return { kind: "ignore" };
  const cmd = /^\/(new|stop|help|start)(?:@\w+)?$/.exec(text);
  if (cmd) return { kind: "command", command: cmd[1] === "start" ? "help" : (cmd[1] as TelegramCommand), at };
  if (!text) return { kind: "ignore" };
  return { kind: "text", text: text.slice(0, 4000), at };
}

// "123456" 또는 "/start 123456"에서 여섯 자리 숫자.
function pairingCodeOf(text: string): string | null {
  const m = /^(?:\/start(?:@\w+)?\s+)?(\d{6})$/.exec(text);
  return m ? m[1] : null;
}

export function newPairing(now: number, random: () => number): Pairing {
  const code = String(Math.floor(random() * 1_000_000)).padStart(6, "0");
  return { code, expiresAt: now + PAIRING_TTL_MS, tries: 0 };
}

// 확인 코드 대조. 만료·틀린 횟수 초과면 폐기(null), 틀리면 횟수를 올린 코드.
export function checkPairing(p: Pairing | null, code: string, now: number): { ok: true } | { ok: false; next: Pairing | null } {
  if (!p || now > p.expiresAt) return { ok: false, next: null };
  if (timingSafeEqual(p.code, code)) return { ok: true };
  const tries = p.tries + 1;
  return { ok: false, next: tries >= PAIRING_MAX_TRIES ? null : { ...p, tries } };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// 이 시각보다 오래된 메시지는 실행하지 않는다(브라우저가 꺼져 있던 동안 쌓인 요청이 늦게 실행되지 않게).
export const TELEGRAM_MAX_AGE_MS = 10 * 60_000;

// 실행하지 않을 오래된 메시지인지: 연결하기 전에 보냈거나 10분보다 오래됐다.
export function staleMessage(at: number, connectedAt: number, now: number): boolean {
  return at < connectedAt - 5_000 || now - at > TELEGRAM_MAX_AGE_MS;
}

// 텔레그램으로 보낼 오류 문구. 제공자·도구의 원문을 보내지 않도록 오류의 다음 행동(구조)으로만 고른다.
export function remoteErrorText(action: "settings" | "usage" | undefined): string {
  if (action === "settings") return "요청을 처리하지 못했습니다. 패널 설정에서 AI 서비스의 API 키와 모델을 확인해 주세요.";
  if (action === "usage") return "요청을 처리하지 못했습니다. AI 서비스의 사용량·잔액을 확인해 주세요.";
  return "요청을 처리하지 못했습니다. 잠시 뒤 다시 보내 주세요.";
}

// 보낼 글을 텔레그램 한도로 나눈다. 줄바꿈에서 자르고, 넘치면 마지막 조각 끝에 잘렸다고 적는다.
export function splitMessage(text: string, max = TELEGRAM_MAX_TEXT, parts = TELEGRAM_MAX_PARTS): string[] {
  const t = text.trim() || "(빈 답)";
  const out: string[] = [];
  let rest = t;
  while (rest.length && out.length < parts) {
    if (rest.length <= max) {
      out.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    // 서로게이트 쌍(이모지 등) 가운데서 자르지 않는다.
    if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length) {
    const note = "\n…(길어서 잘렸습니다)";
    const last = out[out.length - 1];
    let keep = Math.min(last.length, max - note.length);
    if (isHighSurrogate(last.charCodeAt(keep - 1))) keep -= 1;
    out[out.length - 1] = last.slice(0, keep) + note;
  }
  return out;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

// 자동 로그인 가림 목록을 못 읽었을 때 내용 대신 보내는 글.
export const MASK_FAILED_TEXT = "결과를 안전하게 보내지 못했습니다. 패널에서 확인해 주세요.";

// ---- 반복 작업 알림(#139, 요약 #209) ----

export const REPEAT_SUMMARY_MAX = 1000;
export const REPEAT_SUMMARY_CUT = "…(길어서 잘렸습니다)";

// 알림 글. summary가 없거나 빈 글이면 작업 이름만(요약 기능 전과 같은 글). 요약은 상한에서 자르고(서로게이트 쌍을 가르지 않음) 잘림 표시를 붙인다.
export function repeatNoticeText(title: string, summary: string | null): string {
  const base = `반복 작업 ‘${title}’의 조건이 맞았습니다. 패널에서 ‘이어서 진행’을 누르세요.`;
  const s = summary?.trim() ?? "";
  if (!s) return base;
  let body = s;
  if (s.length > REPEAT_SUMMARY_MAX) {
    let keep = REPEAT_SUMMARY_MAX;
    if (isHighSurrogate(s.charCodeAt(keep - 1))) keep -= 1;
    body = s.slice(0, keep) + REPEAT_SUMMARY_CUT;
  }
  return `${base}\n\n확인 결과: ${body}`;
}

// 알림 판단에 쓰는 연결 상태(background/telegram.ts의 TelegramState 일부).
export interface RepeatNoticeState {
  notifyRepeat: boolean;
  notifyRepeatSummary: boolean;
  chatId: number | null;
  status: string;
  epoch: number;
}

// 저장 큐를 거쳐 읽은 상태와, 읽기 전에 붙잡은 연결 신호·그 신호가 읽은 뒤에도 지금 연결인지.
export interface RepeatNoticeRead<S extends RepeatNoticeState = RepeatNoticeState> {
  s: S;
  conn: AbortSignal;
  alive: boolean;
}

export type RepeatNoticeKind = "none" | "name" | "summary";

export function repeatNoticeWants(s: RepeatNoticeState): RepeatNoticeKind {
  if (!s.notifyRepeat || s.chatId === null || s.status !== "idle") return "none";
  return s.notifyRepeatSummary ? "summary" : "name";
}

// 보내기 직전 판단: 처음 읽은 뒤 연결(신호·세대)이 바뀌었거나 알림을 껐으면 보내지 않는다. 요약은 처음과 지금 모두 켜져 있고
// 준비한 요약(hasSummary)이 있을 때만, 아니면 이름만.
export function repeatNoticePlan(before: RepeatNoticeRead, after: RepeatNoticeRead, hasSummary: boolean): RepeatNoticeKind {
  if (!before.alive || !after.alive || after.conn !== before.conn || after.s.epoch !== before.s.epoch) return "none";
  const now = repeatNoticeWants(after.s);
  if (now === "none") return "none";
  return now === "summary" && repeatNoticeWants(before.s) === "summary" && hasSummary ? "summary" : "name";
}

export interface RepeatNoticeDeps<S extends RepeatNoticeState> {
  // 저장 큐를 거쳐 읽는다(앞선 철회·끊기 저장이 끝난 뒤의 상태).
  read(): Promise<RepeatNoticeRead<S>>;
  // 자동 로그인 값 가리기. 목록을 못 읽으면 던진다.
  mask(text: string): Promise<string>;
  // 조각 하나를 보낸다. 429(기다릴 시간이 짧을 때)면 보내지 않고 기다릴 시간을 돌려준다. 그 밖의 실패는 던진다.
  send(s: S, part: string, signal: AbortSignal): Promise<RepeatSendResult>;
  // 429 대기. 신호가 끊기면 바로 끝난다.
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export type RepeatSendResult = "ok" | { retryAfterMs: number };

// 반복 작업 알림 하나(조건이 맞은 회차). reason은 repeatTasks가 이미 가려 저장한 이유(가림 실패면 빈 글).
// 처음 읽기 → (요약 켜짐이면) 요약 가림, 실패면 이름만 → 전체 글 가림(이름만 글이 실패하면 대체 문구) → 보내기 직전 다시 읽기 → 보내기.
// 보내기는 조각마다 하고 429면 한 번 기다려 다시 보내는데, 다시 보내기 직전에도 상태를 다시 읽어 같은 판정을 한다(#209 리뷰 P2):
// 알림을 껐거나 연결이 바뀌었으면 보내지 않고, 요약만 껐으면(아직 앞 조각을 보내지 않았을 때) 이름만 글로 바꾼다.
export async function runRepeatNotice<S extends RepeatNoticeState>(deps: RepeatNoticeDeps<S>, t: { title: string; reason: string }): Promise<{ kind: RepeatNoticeKind; text: string | null }> {
  const none = { kind: "none" as const, text: null };
  const first = await deps.read();
  const want = first.alive ? repeatNoticeWants(first.s) : "none";
  if (want === "none") return none;
  let summary: string | null = null;
  if (want === "summary" && t.reason.trim()) {
    // 저장 뒤 가림 목록이 늘었을 수 있어 한 번 더 가린다. 실패하면 요약 없이(대체 문구로 바꾸지 않는다).
    try {
      summary = await deps.mask(t.reason);
    } catch {
      summary = null;
    }
  }
  let nameText: string;
  try {
    nameText = await deps.mask(repeatNoticeText(t.title, null));
  } catch {
    nameText = MASK_FAILED_TEXT;
  }
  let fullText: string | null = null;
  if (summary?.trim()) {
    try {
      fullText = await deps.mask(repeatNoticeText(t.title, summary));
    } catch {
      fullText = null;
    }
  }
  const second = await deps.read();
  let kind = repeatNoticePlan(first, second, fullText !== null);
  if (kind === "none" || first.conn.aborted) return none;
  const pick = (k: RepeatNoticeKind) => (k === "summary" && fullText !== null ? fullText : nameText);
  let text = pick(kind);
  let s = second.s;
  let parts = splitMessage(text);
  let i = 0;
  let retried = false;
  while (i < parts.length) {
    if (first.conn.aborted) break;
    const r = await deps.send(s, parts[i], first.conn);
    if (r === "ok") {
      i++;
      retried = false;
      continue;
    }
    // 조각마다 한 번만 기다린다(두 번째 429면 그만 — sendText와 같다).
    if (retried) break;
    retried = true;
    await deps.wait(r.retryAfterMs, first.conn);
    // 기다리는 사이 연결을 끊었거나 바꿨으면 다시 보내지 않는다.
    if (first.conn.aborted) return i > 0 ? { kind, text } : none;
    const again = await deps.read();
    const k = repeatNoticePlan(first, again, fullText !== null);
    if (k === "none") return none;
    if (k !== kind) {
      // 앞 조각이 이미 갔으면 글을 바꿔 이어 붙이지 않고 그만둔다.
      if (i > 0) break;
      kind = k;
      text = pick(k);
      parts = splitMessage(text);
    }
    s = again.s;
  }
  return { kind, text };
}

// 실패가 이어질 때 기다릴 시간: 1·2·4…초, 최대 5분.
export function backoffMs(failures: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.max(0, failures - 1));
}

// ---- 원격 승인 버튼(#185) ----

// 질문 하나의 id(16바이트 난수의 b64url, 22자). callback_data는 "a:<id>:y|n"(64바이트 이내).
const ASK_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const TELEGRAM_ASK_TTL_MS = 10 * 60_000;

export function newAskId(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function askCallbackData(askId: string, approve: boolean): string {
  return `a:${askId}:${approve ? "y" : "n"}`;
}

// 버튼 데이터를 푼다. 모양이 틀리면 null(승인으로 보지 않는다).
export function parseAskCallback(data: string): { askId: string; approve: boolean } | null {
  const m = /^a:([^:]+):([yn])$/.exec(data);
  if (!m || !ASK_ID_RE.test(m[1])) return null;
  return { askId: m[1], approve: m[2] === "y" };
}

// 답할 수 있는 남은 시간 글. 1분 이상이면 내림한 분(실제보다 길게 안내하지 않게), 그보다 짧으면 내림한 초(#224).
export function askTtlText(ms: number): string {
  const left = Math.max(0, ms);
  return left >= 60_000 ? `${Math.floor(left / 60_000)}분` : `${Math.max(1, Math.floor(left / 1000))}초`;
}

// 질문 메시지 글. 질문 글(원격 질문, 자르지 않음) 뒤에 버튼 안내. ttlMs: 실제 만료까지 남은 시간(위임 질문은 MCP 작업 기한에 맞춰 짧다).
export function askMessageText(question: string, ttlMs: number = TELEGRAM_ASK_TTL_MS): string {
  return `${question}\n\n아래 버튼으로 답해 주세요. ${askTtlText(ttlMs)} 안에 누르지 않으면 하지 않습니다.`;
}

// 답한 뒤 메시지 끝에 붙일 결과.
export function askResultLine(result: "approved" | "denied" | "expired" | "withdrawn"): string {
  return result === "approved" ? "→ 승인함" : result === "denied" ? "→ 거절함" : result === "expired" ? "→ 응답이 없어 하지 않음" : "→ 취소됨";
}
