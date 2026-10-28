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

// 실패가 이어질 때 기다릴 시간: 1·2·4…초, 최대 5분.
export function backoffMs(failures: number): number {
  return Math.min(300_000, 1000 * 2 ** Math.max(0, failures - 1));
}
