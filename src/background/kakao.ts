// 카카오톡 "나에게 보내기"(#310): 패널 요청 결과를 로그인한 사용자 자신의 카카오톡 "나와의 채팅"으로 보낸다.
// - 앱은 사용자가 만든 Kakao Developers 앱이다(REST API 키·클라이언트 시크릿·메시지 링크 주소를 설정에 넣는다, 내장 키 없음).
// - 연결은 카카오 로그인(talk_message 동의)을 chrome.identity.launchWebAuthFlow(선택 권한 identity)로 한다. 로그인 창과 코드 교환·
//   토큰 갱신은 저장 큐 밖에서 기다리고(그동안 끊기·다른 연결이 막히지 않게), 결과 저장은 큐 안에서 시도·세대가 같을 때만 한다.
// - 키·시크릿·토큰은 설정 화면·패널·도구 결과·오류·debugLog 어디에도 돌려주지 않는다. 오류는 고정 문구와 오류 코드(KOE…)만.
// 순수 판단은 lib/kakao.ts.
import {
  checkRedirect,
  classifyMemo,
  KAKAO_API_ORIGIN,
  KAKAO_MEMO_URL,
  KAKAO_SCOPE,
  KAKAO_TEST_TEXT,
  KAKAO_TOKEN_URL,
  kakaoAuthorizeUrl,
  kakaoErrorCode,
  memoBody,
  kakaoUserOk,
  needsRefresh,
  parseRefreshResponse,
  parseTokenResponse,
  prepareKakaoSend,
  refreshExpired,
  runKakaoSend,
  scopeAgreement,
  sendKakaoParts,
  validAppKey,
  validLinkUrl,
  type KakaoPartDeps,
  type KakaoQueuedRead,
  type KakaoTokenRead,
  type MemoResult,
} from "@/lib/kakao";
import { createSerial } from "@/lib/async";
import { setKakaoSender } from "./kakaoSender";
import { maskStringForModel } from "./loginSecrets";
import { debugLog } from "./debug";
import { beginKeepalive, endKeepalive } from "./keepalive";
import { AUTH_FETCH_LIMIT_MS, fetchLimited } from "./auth/http";
import { expectedRedirectUri, identityApi } from "./auth/identity";

// 콘솔에 등록할 리다이렉트 URI는 공용 인증 층(auth/identity.ts)에 있다. 이 모듈에서 내보내던 이름은 그대로 둔다.
export { expectedRedirectUri };

const STORE_KEY = "kakao";

interface KakaoState {
  restKey: string;
  clientSecret: string;
  linkUrl: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  connectedAt: number;
  // 연결 세대(연결·끊기·키 바꾸기마다 +1). 승인·늦게 끝난 로그인·갱신 결과는 이 세대에 묶는다.
  epoch: number;
  // 갱신 실패·두 번째 401이면 needs_login(다시 연결해야 한다).
  status: "idle" | "needs_login";
}

const EMPTY: KakaoState = {
  restKey: "",
  clientSecret: "",
  linkUrl: "",
  accessToken: "",
  accessExpiresAt: 0,
  refreshToken: "",
  refreshExpiresAt: 0,
  connectedAt: 0,
  epoch: 0,
  status: "idle",
};

const NO_TOKENS = { accessToken: "", accessExpiresAt: 0, refreshToken: "", refreshExpiresAt: 0, connectedAt: 0, status: "idle" as const };

// ---- 저장(한 줄로) ----

const serial = createSerial();

async function load(): Promise<KakaoState> {
  const raw = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  return raw && typeof raw === "object" ? { ...EMPTY, ...(raw as Partial<KakaoState>) } : { ...EMPTY };
}

// fn이 null을 돌려주면 바꾸지 않는다. epoch를 주면 그 연결 세대일 때만 바꾼다.
function update(fn: (s: KakaoState) => KakaoState | null, epoch?: number): Promise<KakaoState | null> {
  return serial(async () => {
    const cur = await load();
    if (epoch !== undefined && cur.epoch !== epoch) return null;
    const next = fn(cur);
    if (!next) return null;
    await chrome.storage.local.set({ [STORE_KEY]: next });
    return next;
  });
}

// 연결 세대마다 하나. 연결·끊기·키 바꾸기에서 끊어, 진행 중인 보내기와 카드 대기 중인 승인을 멈춘다.
let connAbort = new AbortController();
function newConnection(): void {
  connAbort.abort();
  connAbort = new AbortController();
}

// 마지막 연결 시도 번호(메모리). 늦게 끝난 옛 로그인이 새 시도·새 상태를 덮지 않게 저장할 때 대조한다.
let attemptSeq = 0;

// 저장 큐를 거쳐 읽는다: 읽기 전에 연결 신호를 붙잡고, 앞선 저장(끊기·키 바꾸기)이 끝난 뒤의 상태와 붙잡은 신호가 아직 지금
// 연결인지를 함께 돌려준다(끊기·키 바꾸기·새 연결은 큐 안에서 신호를 바꾸고 저장한다).
async function readQueued(): Promise<KakaoQueuedRead<KakaoState>> {
  const conn = connAbort.signal;
  const s = await serial(() => load());
  return { s, conn, alive: !conn.aborted && conn === connAbort.signal };
}

// ---- 설정 화면 ----

export interface KakaoStatus {
  hasKey: boolean;
  linkSet: boolean;
  connected: boolean;
  needsLogin: boolean;
  connectedAt: number;
}

// 허용한 필드만(키·시크릿·토큰·링크 주소는 돌려주지 않는다).
function statusOf(s: KakaoState): KakaoStatus {
  const login = !!s.accessToken && !!s.refreshToken;
  const needsLogin = s.status === "needs_login" || (login && refreshExpired(s, Date.now()));
  return { hasKey: !!s.restKey, linkSet: !!s.linkUrl, connected: login && !needsLogin, needsLogin, connectedAt: login ? s.connectedAt : 0 };
}

export async function kakaoStatus(): Promise<KakaoStatus> {
  return statusOf(await serial(() => load()));
}

// 키·시크릿·링크를 저장한다. 저장하면 토큰을 지우고 세대를 올린다(다시 연결해야 한다).
export async function kakaoSaveKeys(input: { restKey: string; clientSecret: string; linkUrl: string }): Promise<KakaoStatus> {
  const restKey = input.restKey.trim();
  const clientSecret = input.clientSecret.trim();
  if (!validAppKey(restKey)) throw new Error("REST API 키 모양이 아닙니다. 카카오 개발자 콘솔의 앱 키에서 REST API 키를 그대로 붙여 넣으세요.");
  if (clientSecret && !validAppKey(clientSecret)) throw new Error("클라이언트 시크릿 모양이 아닙니다. 콘솔에서 시크릿을 쓰지 않으면 비워 두세요.");
  const linkUrl = validLinkUrl(input.linkUrl);
  if (!linkUrl) throw new Error("메시지 링크 주소는 https로 시작하는 주소여야 합니다(콘솔의 웹 도메인에 등록한 주소).");
  const s = await update((cur) => {
    newConnection();
    return { ...EMPTY, epoch: cur.epoch + 1, restKey, clientSecret, linkUrl };
  });
  debugLog("kakao:keys", "저장");
  return statusOf(s ?? (await load()));
}

// 연결 끊기: 토큰을 지우고 세대를 올린다. 카카오 쪽 연결 해제는 하지 않는다(카카오 계정 → 연결된 서비스에서 끊을 수 있다).
export async function kakaoDisconnect(): Promise<KakaoStatus> {
  const s = await update((cur) => {
    newConnection();
    return { ...cur, ...NO_TOKENS, epoch: cur.epoch + 1 };
  });
  debugLog("kakao:disconnect");
  return statusOf(s ?? (await load()));
}

// 키·시크릿·링크·토큰을 모두 지운다.
export async function kakaoClear(): Promise<KakaoStatus> {
  const s = await update((cur) => {
    newConnection();
    return { ...EMPTY, epoch: cur.epoch + 1 };
  });
  debugLog("kakao:clear");
  return statusOf(s ?? (await load()));
}

function randomState(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  let bin = "";
  for (const b of a) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 응답 상태와 JSON만 읽는다. 헤더를 받은 뒤 본문 읽기가 실패하면(시간 제한으로 끊김·JSON 아님) 상태는 살리고 본문만 null로 본다
// — 이미 받은 401·400으로 갱신 거절·다시 로그인 판정을 할 수 있게(fetchLimited는 시간 초과를 따로 거부하지 않는다).
const statusAndJson = async (res: Response): Promise<{ status: number; body: unknown }> => ({ status: res.status, body: await res.json().catch(() => null) });

// kauth(토큰 발급·갱신)에 POST. 응답 상태와 JSON만 돌려주고, 요청 본문(키·코드·토큰)은 오류·로그에 남기지 않는다. 연결 실패면 null.
async function kauthPost(params: Record<string, string>): Promise<{ status: number; body: unknown } | null> {
  try {
    return await fetchLimited(
      KAKAO_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams(params).toString(),
      },
      { timeoutMs: AUTH_FETCH_LIMIT_MS },
      statusAndJson,
    );
  } catch {
    return null;
  }
}

// kapi GET(사용자 정보·동의 내역). 상태와 JSON만 돌려주고, 부르는 쪽은 판정에 필요한 값만 본다(저장·로그 없음). 연결 실패면 null.
async function kapiGet(pathAndQuery: string, token: string): Promise<{ status: number; body: unknown } | null> {
  try {
    return await fetchLimited(`${KAKAO_API_ORIGIN}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } }, { timeoutMs: AUTH_FETCH_LIMIT_MS }, statusAndJson);
  } catch {
    return null;
  }
}

class KakaoConnectError extends Error {
  constructor(
    readonly why: string,
    message: string,
  ) {
    super(message);
    this.name = "KakaoConnectError";
  }
}

// 카카오 로그인으로 연결한다(설정 화면의 "카카오 연결"). 실패는 고정 문구로 던진다.
export async function kakaoConnect(): Promise<KakaoStatus> {
  beginKeepalive();
  try {
    const s = await connectInner();
    debugLog("kakao:connect", "ok");
    return s;
  } catch (err) {
    const why = err instanceof KakaoConnectError ? err.why : "error";
    debugLog("kakao:connect", why, "warn");
    throw err instanceof KakaoConnectError ? new Error(err.message) : new Error("카카오에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.");
  } finally {
    endKeepalive();
  }
}

async function connectInner(): Promise<KakaoStatus> {
  const fail = (why: string, message: string): never => {
    throw new KakaoConnectError(why, message);
  };
  const id = identityApi();
  if (!id || typeof id.launchWebAuthFlow !== "function" || typeof id.getRedirectURL !== "function") {
    fail("no_identity", "권한이 없어 연결하지 않았습니다. '카카오 연결'을 누르고 권한 요청을 허용하세요.");
  }
  let redirectUri = "";
  try {
    redirectUri = id!.getRedirectURL();
  } catch {
    redirectUri = "";
  }
  if (redirectUri !== expectedRedirectUri()) fail("redirect_uri", "리다이렉트 URI가 설정에 보이는 값과 달라 연결하지 않았습니다.");
  // 큐 안에서는 이번 시도 번호·그때의 세대·설정값만 붙잡고 놓는다(로그인 창은 큐 밖에서 기다린다).
  const start = await serial(async () => {
    const cur = await load();
    return { attempt: ++attemptSeq, epoch: cur.epoch, restKey: cur.restKey, clientSecret: cur.clientSecret, linkUrl: cur.linkUrl };
  });
  if (!start.restKey || !validLinkUrl(start.linkUrl)) fail("no_keys", "먼저 REST API 키와 메시지 링크 주소(https)를 저장하세요.");
  const state = randomState();
  let returned: string | undefined;
  try {
    returned = await id!.launchWebAuthFlow({ url: kakaoAuthorizeUrl(start.restKey, redirectUri, state), interactive: true });
  } catch {
    fail("flow", "카카오 로그인을 끝내지 못했습니다. 창을 닫았거나, 콘솔의 리다이렉트 URI·REST API 키를 확인하세요.");
  }
  const chk = checkRedirect(returned ?? "", redirectUri, state);
  if (!chk.ok) {
    return fail(
      `redirect_${chk.why}`,
      chk.why === "error" ? "카카오 로그인이 끝나지 않았습니다(취소했거나 동의하지 않음)." : "카카오 로그인 응답이 올바르지 않아 연결하지 않았습니다.",
    );
  }
  // 로그인 창을 기다리는 사이 끊기·지우기·키 바꾸기·새 시도가 있었으면 코드를 교환하지 않는다(취소된 시도의 키로 카카오에 요청하지 않게).
  // 이 시도가 아직 마지막 시도이고 세대가 시작 때와 같은지(저장 큐를 거쳐 — 앞선 끊기·키 바꾸기 저장이 끝난 뒤의 상태).
  const stillCurrent = () => serial(async () => start.attempt === attemptSeq && (await load()).epoch === start.epoch);
  if (!(await stillCurrent())) fail("stale", "연결하는 사이 설정이 바뀌어(연결 끊기·다른 연결·키 바꾸기) 이 로그인은 쓰지 않았습니다.");
  const res = await kauthPost({
    grant_type: "authorization_code",
    client_id: start.restKey,
    redirect_uri: redirectUri,
    code: chk.code,
    ...(start.clientSecret ? { client_secret: start.clientSecret } : {}),
  });
  if (!res) fail("token_network", "카카오에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
  if (res!.status !== 200) {
    const code = kakaoErrorCode(res!.body);
    fail(`token_${res!.status}${code ? `_${code}` : ""}`, `카카오 토큰을 받지 못했습니다${code ? `(${code})` : ""}. REST API 키·클라이언트 시크릿·리다이렉트 URI를 확인하세요.`);
  }
  const parsed = parseTokenResponse(res!.body, Date.now());
  if (!parsed.ok) {
    return fail(
      parsed.why,
      parsed.why === "scope"
        ? "카카오톡 메시지 전송에 동의해야 합니다. 다시 연결하고 동의 화면에서 '카카오톡 메시지 전송'을 켜세요."
        : "카카오 토큰 응답이 올바르지 않아 연결하지 않았습니다.",
    );
  }
  const access = parsed.tokens.accessToken;
  // 코드 교환을 기다리는 사이 끊기·지우기·키 바꾸기·새 시도가 있었으면 뒤따르는 조회(동의 내역·사용자 정보)를 부르지 않고 멈춘다.
  if (!(await stillCurrent())) fail("stale", "연결하는 사이 설정이 바뀌어(연결 끊기·다른 연결·키 바꾸기) 이 로그인은 쓰지 않았습니다.");
  // 토큰 응답에 scope가 없으면(필수 항목이 아님) 동의 내역 조회로 talk_message 동의를 확인한다. 조회가 실패하면 다시 시도하라고 하고,
  // 올바른 응답에서 동의하지 않았을 때만 동의를 요청한다.
  if (!parsed.scopeKnown) {
    const sc = await kapiGet(`/v2/user/scopes?scopes=${encodeURIComponent(JSON.stringify([KAKAO_SCOPE]))}`, access);
    const agreement = sc && sc.status === 200 ? scopeAgreement(sc.body, KAKAO_SCOPE) : "invalid";
    if (agreement === "invalid") fail("scope_lookup", "카카오 동의 내역을 확인하지 못해 연결하지 않았습니다. 잠시 뒤 다시 시도하세요.");
    if (agreement === "not_agreed") fail("scope", "카카오톡 메시지 전송에 동의해야 합니다. 다시 연결하고 동의 화면에서 '카카오톡 메시지 전송'을 켜세요.");
    if (!(await stillCurrent())) fail("stale", "연결하는 사이 설정이 바뀌어(연결 끊기·다른 연결·키 바꾸기) 이 로그인은 쓰지 않았습니다.");
  }
  // 사용자 정보 조회로 연결을 확정한다(자동 연결 앱은 첫 로그인 뒤 24시간 안에 부르지 않으면 카카오가 연결을 해제한다). 회원번호 확인만 하고
  // 응답의 다른 정보는 쓰지도 저장하지도 않는다.
  const me = await kapiGet("/v2/user/me", access);
  if (!me || me.status !== 200 || !kakaoUserOk(me.body)) fail("user_me", "카카오 계정 연결을 확인하지 못해 연결하지 않았습니다. 잠시 뒤 다시 시도하세요.");
  // 모든 검사가 끝난 뒤에만, 이 시도가 마지막 시도이고 세대가 시작 때와 같을 때 한 번에 저장한다.
  const saved = await update((cur) => {
    if (start.attempt !== attemptSeq || cur.epoch !== start.epoch) return null;
    newConnection();
    return { ...cur, ...parsed.tokens, connectedAt: Date.now(), epoch: cur.epoch + 1, status: "idle" };
  });
  if (!saved) return fail("stale", "연결하는 사이 설정이 바뀌어(연결 끊기·다른 연결·키 바꾸기) 이 로그인은 쓰지 않았습니다.");
  return statusOf(saved);
}

// ---- 토큰 갱신 ----

// 같은 세대 안의 동시 갱신은 하나로 합친다.
let refreshing: { epoch: number; p: Promise<"ok" | "needs_login" | "failed"> } | null = null;

function refreshTokens(epoch: number): Promise<"ok" | "needs_login" | "failed"> {
  if (refreshing && refreshing.epoch === epoch) return refreshing.p;
  const p = doRefresh(epoch).finally(() => {
    if (refreshing?.p === p) refreshing = null;
  });
  refreshing = { epoch, p };
  return p;
}

async function markNeedsLogin(epoch: number): Promise<void> {
  await update((cur) => ({ ...cur, status: "needs_login" }), epoch);
}

async function doRefresh(epoch: number): Promise<"ok" | "needs_login" | "failed"> {
  const cur = await serial(() => load());
  if (cur.epoch !== epoch || !cur.restKey) return "failed";
  if (refreshExpired(cur, Date.now())) {
    await markNeedsLogin(epoch);
    return "needs_login";
  }
  // 갱신 요청은 큐 밖에서 기다린다. 결과 저장·needs_login 기록은 큐 안에서 세대가 같을 때만.
  const res = await kauthPost({
    grant_type: "refresh_token",
    client_id: cur.restKey,
    refresh_token: cur.refreshToken,
    ...(cur.clientSecret ? { client_secret: cur.clientSecret } : {}),
  });
  if (!res) return "failed";
  if (res.status === 400 || res.status === 401) {
    await markNeedsLogin(epoch);
    debugLog("kakao:refresh", `needs_login${kakaoErrorCode(res.body) ? ` · ${kakaoErrorCode(res.body)}` : ""}`, "warn");
    return "needs_login";
  }
  if (res.status !== 200) return "failed";
  const next = parseRefreshResponse(res.body, Date.now(), cur);
  if (!next) return "failed";
  // 상태(status)는 그대로 둔다: 갱신을 기다리는 사이 다른 보내기가 동의 철회(needs_login)를 기록했으면 갱신으로 되살리지 않는다.
  const saved = await update((s) => (s.refreshToken === cur.refreshToken ? { ...s, ...next } : null), epoch);
  return saved ? "ok" : "failed";
}

// ---- 보내기 ----

// 나에게 보내기 한 조각. 응답 원문·토큰은 남기지 않고 판정만 돌려준다. 연결 실패는 던진다(sendKakaoParts가 사유로 바꾼다).
async function postMemo(token: string, linkUrl: string, part: string, signal: AbortSignal): Promise<MemoResult> {
  if (signal.aborted) throw new Error("aborted");
  // 연결 신호가 끊기면 요청도 끊긴다. 본문 읽기가 실패해도 받은 상태로 판정한다(401이면 갱신, 200인데 본문이 없으면 uncertain).
  return fetchLimited(
    KAKAO_MEMO_URL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: memoBody(part, linkUrl),
    },
    { timeoutMs: AUTH_FETCH_LIMIT_MS, signal },
    async (res) => classifyMemo(res.status, await res.json().catch(() => null)),
  );
}

// 이 세대·이 연결 신호로 보내는 조각 의존성. 조각마다 큐에서 지금 토큰을 읽고(만료가 가까우면 갱신), 401이면 한 번 갱신한다.
function partDeps(epoch: number, conn: AbortSignal): KakaoPartDeps {
  const token = async (): Promise<KakaoTokenRead> => {
    for (let i = 0; i < 2; i++) {
      const r = await readQueued();
      if (!r.alive || r.conn !== conn || r.s.epoch !== epoch) return { ok: false, why: "connection_changed" };
      if (r.s.status === "needs_login" || refreshExpired(r.s, Date.now())) return { ok: false, why: "needs_login" };
      if (!r.s.accessToken || !r.s.linkUrl) return { ok: false, why: "connection_changed" };
      if (!needsRefresh(r.s, Date.now())) return { ok: true, token: r.s.accessToken, linkUrl: r.s.linkUrl };
      if (i > 0) break;
      const g = await refreshTokens(epoch);
      if (g !== "ok") return { ok: false, why: g === "needs_login" ? "needs_login" : "send_failed" };
    }
    return { ok: false, why: "send_failed" };
  };
  return {
    token,
    refresh: () => refreshTokens(epoch),
    markNeedsLogin: () => markNeedsLogin(epoch),
    post: postMemo,
  };
}

const maskForSend = async (text: string) => (await maskStringForModel(text)).text;

setKakaoSender({
  prepare: (text) => prepareKakaoSend({ read: readQueued, mask: maskForSend, now: () => Date.now() }, text),
  send: async (p, signal) => {
    const r = await runKakaoSend({ read: readQueued, mask: maskForSend, parts: partDeps(p.epoch, p.conn) }, p, signal);
    debugLog("kakao:own_send", r.ok ? `${r.parts}개` : `${r.why} · ${r.sent}개 감`, r.ok ? "info" : "warn");
    return r;
  },
});

// 설정의 "시험 메시지 보내기": 고정 문구를 고정 주소로 나에게 보낸다(설정 화면은 글을 넘기지 않는다).
export async function kakaoTestSend(): Promise<KakaoStatus> {
  const r = await readQueued();
  if (!r.alive || !r.s.accessToken || !r.s.refreshToken) throw new Error("카카오톡이 연결돼 있지 않습니다. 먼저 '카카오 연결'을 누르세요.");
  if (r.s.status === "needs_login") throw new Error("카카오 로그인이 끝났습니다. 다시 연결하세요.");
  const res = await sendKakaoParts([KAKAO_TEST_TEXT], r.conn, partDeps(r.s.epoch, r.conn));
  debugLog("kakao:test_send", res.outcome, res.outcome === "done" ? "info" : "warn");
  if (res.outcome === "needs_login") throw new Error("카카오 로그인이 끝났습니다. 다시 연결하세요.");
  if (res.outcome === "uncertain") throw new Error("카카오톡 응답을 받지 못했습니다. 시험 메시지가 왔는지 카카오톡에서 확인하세요.");
  if (res.outcome === "connection_changed" || res.outcome === "aborted") throw new Error("보내는 사이 카카오 연결이 바뀌어 멈췄습니다.");
  if (res.outcome !== "done") throw new Error("카카오톡으로 시험 메시지를 보내지 못했습니다. 콘솔의 웹 도메인에 링크 주소의 도메인을 등록했는지 확인하세요.");
  return statusOf((await readQueued()).s);
}
