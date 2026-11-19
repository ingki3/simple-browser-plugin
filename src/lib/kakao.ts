// 카카오톡 "나에게 보내기"(#310)의 순수 함수: 인증 주소·돌아온 주소 검사, 토큰 응답 해석·갱신 판단, 글 나누기, 메시지 본문,
// 조각 보내기(401이면 한 번 갱신 뒤 다시), 미리보기 준비·실행 판단. 네트워크·저장·연결 신호는 src/background/kakao.ts.
// npm test(Node 타입 제거 실행)로 시험하므로 다른 모듈을 불러오지 않는다.
// 받는 곳은 로그인한 사용자 자신(나와의 채팅)으로 고정이다(인자로 바꿀 수 없다). 승인은 미리보기 때의 연결 세대에 묶고, 실행 때 원문을
// 다시 가려 승인한 글과 같을 때만 보낸다(send_to_telegram #210과 같은 흐름).

export const KAKAO_AUTH_ORIGIN = "https://kauth.kakao.com";
export const KAKAO_API_ORIGIN = "https://kapi.kakao.com";
export const KAKAO_AUTHORIZE_URL = `${KAKAO_AUTH_ORIGIN}/oauth/authorize`;
export const KAKAO_TOKEN_URL = `${KAKAO_AUTH_ORIGIN}/oauth/token`;
// 기본 텍스트 템플릿으로 나에게 보내기. 받는 곳·주소는 이 고정 값뿐이다.
export const KAKAO_MEMO_URL = `${KAKAO_API_ORIGIN}/v2/api/talk/memo/default/send`;
export const KAKAO_SCOPE = "talk_message";

// 기본 텍스트 템플릿의 text 상한(200자)과 한 번에 보낼 메시지 수. 가린 뒤 글의 상한(모델 인자 상한 — lib/kakaoSendArgs.ts — 과 같은 값).
export const KAKAO_MAX_TEXT = 200;
export const KAKAO_MAX_PARTS = 5;
export const SEND_TO_KAKAO_MAX = KAKAO_MAX_TEXT * KAKAO_MAX_PARTS;
// 한 요청(턴)에서 부를 수 있는 횟수(텔레그램과 따로 센다).
export const MAX_KAKAO_SENDS_PER_TURN = 3;
// 이 시간 안에 만료되는 액세스 토큰은 보내기 전에 갱신한다.
export const KAKAO_REFRESH_MARGIN_MS = 60_000;
// 설정의 "시험 메시지 보내기"가 보내는 고정 글(옵션 페이지가 글을 넘기지 않는다).
export const KAKAO_TEST_TEXT = "간편 브라우저 도우미 연결 시험";

// ---- 인증 ----

export function kakaoAuthorizeUrl(restKey: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: restKey, redirect_uri: redirectUri, response_type: "code", scope: KAKAO_SCOPE, state });
  return `${KAKAO_AUTHORIZE_URL}?${q.toString()}`;
}

export type RedirectCheck = { ok: true; code: string } | { ok: false; why: "bad_url" | "origin" | "state" | "error" | "no_code" };

// 로그인 창이 돌려준 주소 검사: 출처·경로가 리다이렉트 URI와 같고, state가 같고, error가 없고, code가 있어야 한다.
export function checkRedirect(returned: string, redirectUri: string, state: string): RedirectCheck {
  let u: URL;
  let want: URL;
  try {
    u = new URL(returned);
    want = new URL(redirectUri);
  } catch {
    return { ok: false, why: "bad_url" };
  }
  if (u.origin !== want.origin || u.pathname !== want.pathname) return { ok: false, why: "origin" };
  if (!state || u.searchParams.get("state") !== state) return { ok: false, why: "state" };
  if (u.searchParams.has("error")) return { ok: false, why: "error" };
  const code = u.searchParams.get("code");
  if (!code) return { ok: false, why: "no_code" };
  return { ok: true, code };
}

export interface KakaoTokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

const isToken = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/\s/.test(v);
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

// 코드 교환 응답 해석. 토큰 형식이 틀리면 format, 동의 범위(scope)가 있는데 talk_message가 없으면 scope(저장하지 않는다).
// scope는 응답의 필수 항목이 아니라(카카오 문서) 없으면 scopeKnown=false — 부르는 쪽이 동의 내역 조회(/v2/user/scopes)로 확인한다.
export function parseTokenResponse(body: unknown, now: number): { ok: true; tokens: KakaoTokens; scopeKnown: boolean } | { ok: false; why: "format" | "scope" } {
  if (!body || typeof body !== "object") return { ok: false, why: "format" };
  const b = body as Record<string, unknown>;
  if (!isToken(b.access_token) || !isSeconds(b.expires_in) || !isToken(b.refresh_token) || !isSeconds(b.refresh_token_expires_in)) return { ok: false, why: "format" };
  const scopeKnown = typeof b.scope === "string";
  if (scopeKnown && !(b.scope as string).split(/\s+/).includes(KAKAO_SCOPE)) return { ok: false, why: "scope" };
  return {
    ok: true,
    scopeKnown,
    tokens: {
      accessToken: b.access_token,
      accessExpiresAt: now + b.expires_in * 1000,
      refreshToken: b.refresh_token,
      refreshExpiresAt: now + b.refresh_token_expires_in * 1000,
    },
  };
}

// 동의 내역 조회(GET /v2/user/scopes) 응답에서 그 항목에 동의했는지.
export function scopeAgreed(body: unknown, id: string): boolean {
  const list = body && typeof body === "object" ? (body as { scopes?: unknown }).scopes : undefined;
  return Array.isArray(list) && list.some((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === id && (x as { agreed?: unknown }).agreed === true);
}

// 사용자 정보 조회(GET /v2/user/me) 응답이 연결된 사용자인지(회원번호 id만 본다 — 다른 정보는 쓰지도 저장하지도 않는다).
// 자동 연결 앱은 첫 로그인 뒤 24시간 안에 사용자 정보 조회를 부르지 않으면 카카오가 연결을 해제한다(가입 미완료 정리).
export function kakaoUserOk(body: unknown): boolean {
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
  return typeof id === "number" && Number.isFinite(id);
}

// 갱신 응답 해석. 새 리프레시 토큰이 오면(만료가 가까울 때) 그것으로 바꾸고, 없으면 지금 것을 그대로 둔다.
export function parseRefreshResponse(body: unknown, now: number, cur: Pick<KakaoTokens, "refreshToken" | "refreshExpiresAt">): KakaoTokens | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!isToken(b.access_token) || !isSeconds(b.expires_in)) return null;
  const rotated = isToken(b.refresh_token) && isSeconds(b.refresh_token_expires_in);
  return {
    accessToken: b.access_token,
    accessExpiresAt: now + b.expires_in * 1000,
    refreshToken: rotated ? (b.refresh_token as string) : cur.refreshToken,
    refreshExpiresAt: rotated ? now + (b.refresh_token_expires_in as number) * 1000 : cur.refreshExpiresAt,
  };
}

// 보내기 전에 액세스 토큰을 갱신해야 하는지(만료 60초 전부터).
export function needsRefresh(s: Pick<KakaoTokens, "accessExpiresAt">, now: number): boolean {
  return s.accessExpiresAt - KAKAO_REFRESH_MARGIN_MS < now;
}

// 리프레시 토큰도 만료됐는지(그러면 다시 로그인해야 한다).
export function refreshExpired(s: Pick<KakaoTokens, "refreshToken" | "refreshExpiresAt">, now: number): boolean {
  return !s.refreshToken || s.refreshExpiresAt <= now;
}

// 카카오 오류 응답의 오류 코드만(KOE006 같은 모양일 때). 원문(error_description)은 보이지 않는다.
export function kakaoErrorCode(body: unknown): string {
  const c = body && typeof body === "object" ? (body as { error_code?: unknown }).error_code : undefined;
  return typeof c === "string" && /^KOE\d{3}$/.test(c) ? c : "";
}

// ---- 설정 값 ----

// 메시지 링크 주소: https만, 계정 정보 없이. 맞으면 정규화한 주소, 아니면 null.
export function validLinkUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return u.href;
}

// REST API 키·클라이언트 시크릿 모양(콘솔에서 복사한 영숫자). 값은 어디에도 돌려주지 않는다.
export function validAppKey(raw: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(raw);
}

// ---- 글 나누기·메시지 본문 ----

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

// 잘림 없이 200자 조각 5개 안에 나눈다: 이으면 원문, 조각마다 200자 이하, 공백·줄바꿈만 있는 조각 없음, 서로게이트 쌍을 가르지 않음.
// 담을 수 있는 나누기가 하나라도 있으면 찾는다(뒤에서부터 "여기서 시작하면 최소 몇 조각"을 계산한 뒤 앞에서 고른다). 고를 때는
// 남은 조각에 담기는 경계 중 줄바꿈 바로 뒤(조각이 절반 이상일 때)를 먼저, 없으면 가장 긴 조각을 고른다. 담을 수 없으면 null.
// (텔레그램 splitWhole과 같은 계약이지만 한도가 짧아 줄바꿈·공백·이모지 경계 때문에 조각이 모자라지 않게 따로 둔다 — #310 리뷰.)
export function splitKakao(text: string, max = KAKAO_MAX_TEXT, maxParts = KAKAO_MAX_PARTS): string[] | null {
  const n = text.length;
  if (!text.trim() || n > max * maxParts) return null;
  // nextSolid[i]: i 이상에서 처음 나오는 공백 아닌 글자 위치(없으면 n).
  const nextSolid = new Array<number>(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) nextSolid[i] = /\s/.test(text[i]) ? nextSolid[i + 1] : i;
  const okCut = (j: number) => j === n || !(isHigh(text.charCodeAt(j - 1)) && isLow(text.charCodeAt(j)));
  // need[i]: text[i:]를 담는 최소 조각 수(못 담으면 Infinity).
  const need = new Array<number>(n + 1).fill(Infinity);
  need[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = Math.min(n, i + max); j > i; j--) {
      if (nextSolid[i] >= j || !okCut(j)) continue;
      if (need[j] + 1 < need[i]) need[i] = need[j] + 1;
    }
  }
  if (need[0] > maxParts) return null;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const left = maxParts - out.length - 1;
    let pick = -1;
    let breakPick = -1;
    for (let j = Math.min(n, i + max); j > i; j--) {
      if (nextSolid[i] >= j || !okCut(j) || need[j] > left) continue;
      if (pick < 0) pick = j;
      if (breakPick < 0 && text[j - 1] === "\n" && j - i >= max / 2) breakPick = j;
    }
    const j = breakPick >= 0 ? breakPick : pick;
    if (j < 0) return null;
    out.push(text.slice(i, j));
    i = j;
  }
  return out;
}

// 나에게 보내기 요청 본문(application/x-www-form-urlencoded). 버튼 글자는 넣지 않는다(링크는 필수라 저장한 주소).
export function memoBody(part: string, linkUrl: string): string {
  const template = { object_type: "text", text: part, link: { web_url: linkUrl, mobile_web_url: linkUrl } };
  return new URLSearchParams({ template_object: JSON.stringify(template) }).toString();
}

export type MemoResult = "ok" | "unauthorized" | "consent" | "quota" | "failed";

// 나에게 보내기 응답 판정: 200이고 result_code 0만 성공. 401(또는 code -401)은 토큰 무효, code -402는 동의 철회(talk_message —
// 다시 로그인해 동의해야 함), 429(또는 code -10)는 쿼터 초과.
export function classifyMemo(status: number, body: unknown): MemoResult {
  const b = body && typeof body === "object" ? (body as { result_code?: unknown; code?: unknown }) : {};
  if (status === 200 && b.result_code === 0) return "ok";
  if (status === 401 || b.code === -401) return "unauthorized";
  if (b.code === -402) return "consent";
  if (status === 429 || b.code === -10) return "quota";
  return "failed";
}

// ---- 조각 보내기 ----

export type KakaoTokenRead = { ok: true; token: string; linkUrl: string } | { ok: false; why: "needs_login" | "connection_changed" | "send_failed" };

export interface KakaoPartDeps {
  // 조각마다 보내기 직전에 지금 토큰을 읽는다(같은 연결 세대일 때만, 만료가 가까우면 갱신한 뒤).
  token(): Promise<KakaoTokenRead>;
  // 401 뒤 강제 갱신. needs_login이면 갱신이 거절됐다(다시 로그인).
  refresh(): Promise<"ok" | "needs_login" | "failed">;
  // 두 번째 401: 다시 로그인해야 한다고 기록한다(같은 세대일 때만).
  markNeedsLogin(): Promise<void>;
  post(token: string, linkUrl: string, part: string, signal: AbortSignal): Promise<MemoResult>;
}

// uncertain: 요청을 보냈는데 응답을 받지 못했다(그 조각이 갔는지 알 수 없다 — 다시 보내면 겹칠 수 있다).
export type KakaoPartsOutcome = "done" | "needs_login" | "connection_changed" | "send_failed" | "aborted" | "uncertain";

// 조각을 차례로 보낸다. 401이면 그 조각만 한 보내기 안에서 한 번 갱신해 다시 보내고, 다시 401이거나 갱신이 거절되면 needs_login.
// 쿼터 초과는 다시 보내지 않는다. 신호가 끊기면 aborted(보내는 중 끊겨 생긴 예외 포함). 실패 사유를 합치지 않고 돌려준다.
export async function sendKakaoParts(parts: readonly string[], signal: AbortSignal, deps: KakaoPartDeps): Promise<{ sent: number; outcome: KakaoPartsOutcome }> {
  let sent = 0;
  let refreshed = false;
  // 지금 조각의 요청을 보낸 뒤 응답을 기다리는 중인지(그때 난 예외는 도착 여부를 알 수 없다).
  let inFlight = false;
  const post = async (token: string, linkUrl: string, part: string): Promise<MemoResult> => {
    inFlight = true;
    const r = await deps.post(token, linkUrl, part, signal);
    inFlight = false;
    return r;
  };
  for (const part of parts) {
    if (signal.aborted) return { sent, outcome: "aborted" };
    try {
      let t = await deps.token();
      if (!t.ok) return { sent, outcome: t.why };
      if (signal.aborted) return { sent, outcome: "aborted" };
      let r = await post(t.token, t.linkUrl, part);
      if (r === "unauthorized") {
        if (refreshed) {
          await deps.markNeedsLogin();
          return { sent, outcome: "needs_login" };
        }
        refreshed = true;
        const g = await deps.refresh();
        if (g !== "ok") return { sent, outcome: g === "needs_login" ? "needs_login" : "send_failed" };
        if (signal.aborted) return { sent, outcome: "aborted" };
        t = await deps.token();
        if (!t.ok) return { sent, outcome: t.why };
        r = await post(t.token, t.linkUrl, part);
        if (r === "unauthorized") {
          await deps.markNeedsLogin();
          return { sent, outcome: "needs_login" };
        }
      }
      // 동의를 철회했으면 갱신으로 고칠 수 없다 — 다시 로그인(동의)해야 한다.
      if (r === "consent") {
        await deps.markNeedsLogin();
        return { sent, outcome: "needs_login" };
      }
      if (r !== "ok") return { sent, outcome: signal.aborted ? "aborted" : "send_failed" };
    } catch {
      return { sent, outcome: inFlight ? "uncertain" : signal.aborted ? "aborted" : "send_failed" };
    }
    sent++;
  }
  return { sent, outcome: "done" };
}

// ---- 미리보기 준비·실행 ----

// 보내기 판단에 쓰는 연결 상태(background/kakao.ts의 KakaoState 일부).
export interface KakaoSendState {
  restKey: string;
  linkUrl: string;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: number;
  status: string;
  epoch: number;
}

// 저장 큐를 거쳐 읽은 상태와, 읽기 전에 붙잡은 연결 신호·그 신호가 읽은 뒤에도 지금 연결인지(background/kakao.ts readQueued).
export interface KakaoQueuedRead<S> {
  s: S;
  conn: AbortSignal;
  alive: boolean;
}

// 미리보기가 만든 준비 정보. 백그라운드 메모리에만 두고(패널·기록·모델에 싣지 않음) 카드·패널에는 safeText만 보인다.
export interface PreparedKakaoSend {
  raw: string;
  safeText: string;
  epoch: number;
  conn: AbortSignal;
}

export type KakaoSendWhy = "not_connected" | "needs_login" | "mask_failed" | "mask_changed" | "too_long" | "connection_changed" | "send_failed" | "aborted" | "uncertain";

function hasLogin(s: KakaoSendState): boolean {
  return !!s.restKey && !!s.linkUrl && !!s.accessToken && !!s.refreshToken;
}

// 미리보기 때 연결 상태 판정: 로그인이 없으면 not_connected, 다시 로그인해야 하면 needs_login.
export function kakaoConnState(s: KakaoSendState, now: number): "ok" | "not_connected" | "needs_login" {
  if (s.status === "needs_login") return "needs_login";
  if (!hasLogin(s)) return "not_connected";
  if (refreshExpired(s, now)) return "needs_login";
  return s.status === "idle" ? "ok" : "not_connected";
}

// 실행 때 보내도 되는지: 준비 때와 같은 연결 세대·정상 상태이고, 준비 때 붙잡은 신호가 지금 연결이며 살아 있다.
export function kakaoSendAllowed(p: Pick<PreparedKakaoSend, "epoch" | "conn">, r: KakaoQueuedRead<KakaoSendState>): boolean {
  return r.alive && !r.conn.aborted && r.conn === p.conn && !p.conn.aborted && hasLogin(r.s) && r.s.status === "idle" && r.s.epoch === p.epoch;
}

export interface KakaoPrepareDeps<S extends KakaoSendState> {
  read(): Promise<KakaoQueuedRead<S>>;
  // 자동 로그인 값 가리기. 목록을 못 읽으면 던진다.
  mask(text: string): Promise<string>;
  now(): number;
}

// 미리보기: 저장 큐를 거쳐 연결을 확인하고, 글을 가려 상한·나누기를 확인한다. 실패면 카드 없이 고정 문구로 끝낸다(보내지 않음).
export async function prepareKakaoSend<S extends KakaoSendState>(
  deps: KakaoPrepareDeps<S>,
  text: string,
): Promise<{ ok: true; prepared: PreparedKakaoSend; parts: number } | { ok: false; why: KakaoSendWhy }> {
  const r = await deps.read();
  if (!r.alive || r.conn.aborted) return { ok: false, why: "not_connected" };
  const st = kakaoConnState(r.s, deps.now());
  if (st !== "ok") return { ok: false, why: st };
  const raw = text.trim();
  let safeText: string;
  try {
    safeText = await deps.mask(raw);
  } catch {
    return { ok: false, why: "mask_failed" };
  }
  // 가리는 사이 연결을 끊었거나 바꿨으면 카드를 띄우지 않는다.
  if (r.conn.aborted) return { ok: false, why: "not_connected" };
  const parts = splitKakao(safeText);
  if (!parts) return { ok: false, why: "too_long" };
  return { ok: true, prepared: { raw, safeText, epoch: r.s.epoch, conn: r.conn }, parts: parts.length };
}

export type KakaoSendOutcome = { ok: true; parts: number } | { ok: false; why: KakaoSendWhy; sent: number };

// 실행: 저장 큐를 거쳐 다시 읽어 연결 세대를 확인하고, 원문을 다시 가려 승인한 글과 글자 그대로 같을 때만 그 글을 나눠 보낸다.
// 조각마다 보내기 직전에 토큰을 다시 읽는다(앞 조각에서 갱신한 토큰을 남은 조각도 쓴다). 전부 보냈을 때만 성공.
export async function runKakaoSend<S extends KakaoSendState>(
  deps: Pick<KakaoPrepareDeps<S>, "read" | "mask"> & { parts: KakaoPartDeps },
  p: PreparedKakaoSend,
  signal: AbortSignal,
): Promise<KakaoSendOutcome> {
  const fail = (why: KakaoSendWhy, sent = 0): KakaoSendOutcome => ({ ok: false, why, sent });
  if (signal.aborted) return fail("aborted");
  if (!kakaoSendAllowed(p, await deps.read())) return fail("connection_changed");
  let again: string;
  try {
    again = await deps.mask(p.raw);
  } catch {
    return fail("mask_failed");
  }
  if (again !== p.safeText) return fail("mask_changed");
  const parts = splitKakao(p.safeText);
  if (!parts) return fail("too_long");
  const r = await deps.read();
  if (!kakaoSendAllowed(p, r)) return fail("connection_changed");
  const out = AbortSignal.any([r.conn, signal]);
  const res = await sendKakaoParts(parts, out, deps.parts);
  if (res.outcome === "done") return { ok: true, parts: parts.length };
  return fail(res.outcome, res.sent);
}

// 도구 결과(모델·패널)에 싣는 고정 문구. 보낸 글·카카오 응답 원문·토큰·키는 싣지 않는다.
export function kakaoSendErrorText(why: KakaoSendWhy, sent: number): string {
  const already = sent > 0 ? ` 앞의 ${sent}개 메시지는 이미 갔습니다.` : "";
  switch (why) {
    case "not_connected":
      return "카카오톡이 연결돼 있지 않습니다. 설정 → 모델·연결 → 카카오톡 나에게 보내기에서 연결하세요.";
    case "needs_login":
      return `카카오 로그인이 끝났습니다. 설정에서 다시 연결하세요.${already}`;
    case "mask_failed":
      return "자동 로그인 값을 가리지 못해 보내지 않았습니다. 잠시 뒤 다시 요청하세요.";
    case "mask_changed":
      return "승인한 뒤 가릴 값 목록이 바뀌어 보내지 않았습니다. 다시 요청하세요.";
    case "too_long":
      return `카카오톡은 한 메시지 ${KAKAO_MAX_TEXT}자, ${KAKAO_MAX_PARTS}개(${SEND_TO_KAKAO_MAX}자)까지입니다. 요약해서 다시 보내세요.`;
    case "connection_changed":
      return sent > 0
        ? `보내는 사이 카카오 연결이 바뀌어(연결 끊기·다시 연결·키 바꾸기) 멈췄습니다.${already} 남은 부분만 다시 요청하세요.`
        : "승인한 뒤 카카오 연결이 바뀌어(연결 끊기·다시 연결·키 바꾸기) 보내지 않았습니다. 다시 요청하세요.";
    case "send_failed":
      return `카카오톡으로 보내지 못했습니다.${already}`;
    case "aborted":
      return `중단되어 보내기를 멈췄습니다.${already}`;
    case "uncertain":
      return `카카오톡 응답을 받지 못해 ${sent + 1}번째 메시지가 갔는지 알 수 없습니다.${already} 카카오톡을 확인한 뒤 필요하면 남은 부분만 다시 요청하세요.`;
  }
}
