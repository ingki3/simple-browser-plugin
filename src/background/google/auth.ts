import { GOOGLE_AUTH_VERSION_KEY } from "@/lib/googleAuthKey";
import { debugLog } from "../debug";
import { identityApi } from "../auth/identity";
import { AUTH_FETCH_LIMIT_MS, fetchLimited } from "../auth/http";

function getManifestClientId(): string {
  const mf = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    oauth2?: { client_id?: string; scopes?: string[] };
  };
  return mf.oauth2?.client_id ?? "";
}

// 빌드 시 GOOGLE_OAUTH_CLIENT_ID가 없으면 Google 도구를 모델에 노출하지 않는다.
export function isGoogleConfigured(): boolean {
  return !!getManifestClientId() && !!identityApi();
}

function requireOauthConfigured(): void {
  if (!getManifestClientId()) {
    throw new Error(
      "Google 연동은 직접 빌드한 확장에서만 쓸 수 있습니다(이 빌드에는 OAuth 클라이언트 ID가 없습니다). 설치 안내(docs/install.md)의 \"Google 연동\"대로 GOOGLE_OAUTH_CLIENT_ID를 넣어 다시 빌드해 주세요. 클라이언트 유형은 'Chrome 확장 프로그램'입니다.",
    );
  }
  if (!identityApi()) {
    throw new Error(
      "chrome.identity API가 없습니다. 확장에 'identity' 권한이 아직 적용되지 않았다는 뜻입니다. chrome://extensions 에서 이 확장을 삭제 후 다시 '압축해제된 확장 프로그램 로드'로 재설치해 주세요.",
    );
  }
}

function callGetAuthToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        const lastErr = chrome.runtime.lastError?.message;
        if (lastErr) {
          reject(new Error(lastErr));
          return;
        }
        // Chromium sometimes returns { token: "..." } object form instead of string
        const t =
          typeof token === "string"
            ? token
            : (token as unknown as { token?: string } | undefined)?.token;
        if (!t) {
          reject(new Error("액세스 토큰이 비어 있습니다."));
          return;
        }
        resolve(t);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function callRemoveCachedAuthToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    } catch {
      resolve();
    }
  });
}

// 연결·해제를 다른 설정 화면에 알린다(#127 — 연결 상태는 chrome.identity에만 있어 저장소 알림이 없다). 값은 바뀐 시각.
function bumpAuthVersion(): void {
  void chrome.storage.local.set({ [GOOGLE_AUTH_VERSION_KEY]: Date.now() }).catch(() => {});
}

export async function connectGoogle(): Promise<{ ok: true }> {
  requireOauthConfigured();
  debugLog("google:auth:start", "interactive");
  // 이 연결 시도와 겹친 요청은 401이어도 다시 보내지 않는다(로그인 창에서 다른 계정을 골랐을 수 있다).
  authChangeSeq += 1;
  authChanging += 1;
  try {
    await callGetAuthToken(true);
  } finally {
    authChanging -= 1;
    bumpAuthVersion();
  }
  debugLog("google:auth:ok");
  return { ok: true };
}

export async function getGoogleToken(): Promise<string> {
  requireOauthConfigured();
  try {
    return await callGetAuthToken(false);
  } catch (silentErr) {
    const msg = silentErr instanceof Error ? silentErr.message : String(silentErr);
    throw new Error(
      `Google 토큰을 가져올 수 없습니다. 설정에서 'Google 연결' 버튼을 눌러 재인증해 주세요. (원인: ${msg})`,
    );
  }
}

// 설정의 연결·끊기와 진행 중인 요청의 401 재시도가 엇갈리지 않게 하는 메모리 값(#319). 서비스 워커가 다시 뜨면 진행 중이던 요청도
// 사라지므로 저장하지 않는다. 연결도 넣는 이유: 로그인 창(동의 화면)에서 다른 계정을 고르면 Chrome이 그 계정을 이 확장의 계정으로
// 바꾸는데, 두 계정의 로그인 상태는 그대로라 로그인 상태 변화로는 잡히지 않는다.
// - authChangeSeq: 연결·끊기가 시작될 때마다 1 오른다. 요청이 시작된 뒤에 시작한 연결·끊기를 잡는다.
// - authChanging: 진행 중인 연결·끊기의 수(로그인 창·폐기 응답을 기다리는 동안에도 올라가 있다. 여러 설정 탭에서 겹쳐도 맞다).
//   요청이 시작될 때 이미 진행 중이던 연결·끊기를 잡는다.
let authChangeSeq = 0;
let authChanging = 0;

// Chrome 프로필의 로그인 상태가 바뀐 횟수(메모리). getAuthToken은 계정을 지정하지 않으면 Chrome 프로필의 계정(동기화 계정, 없으면 첫
// Google 웹 계정)을 쓰므로, 401 뒤 다시 받은 토큰이 처음 요청과 같은 계정의 것인지 토큰만으로는 알 수 없다. 요청이 도는 사이
// 프로필의 계정 로그인·로그아웃이 한 번도 없었을 때만 같은 계정으로 보고 다시 보낸다(다른 계정의 권한으로 조회·쓰기가 실행되지 않게).
let signInSeq = 0;
let watchedIdentity: object | null = null;
// 로그인 상태 변화 감시를 건다(요청을 보내기 전에 부른다). 걸지 못하면 false — 그러면 같은 계정인지 확인할 수 없어 다시 보내지 않는다.
// 모듈 최상위에서 걸지 않는다: 값은 진행 중인 요청과 수명이 같고(워커가 내려가면 요청도 사라진다), identity는 부를 때 읽는다.
function watchSignIn(): boolean {
  const id = identityApi();
  const ev = id?.onSignInChanged;
  if (!id || !ev || typeof ev.addListener !== "function") return false;
  if (watchedIdentity !== id) {
    try {
      ev.addListener(() => {
        signInSeq += 1;
      });
    } catch {
      return false;
    }
    watchedIdentity = id;
  }
  return true;
}

const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export async function clearGoogleToken(): Promise<void> {
  if (!identityApi()) return;
  authChangeSeq += 1;
  authChanging += 1;
  try {
    await clearGoogleTokenInner();
  } finally {
    authChanging -= 1;
    bumpAuthVersion();
  }
}

async function clearGoogleTokenInner(): Promise<void> {
  try {
    const token = await callGetAuthToken(false);
    await callRemoveCachedAuthToken(token);
    // 토큰은 주소(쿼리)가 아니라 본문에 싣는다 — 주소는 로그·기록에 남기 쉽다. 응답 본문은 읽지 않고, 실패(연결 실패·시간 초과)는 삼킨다.
    // 성공 응답을 받았을 때만 폐기됐다고 기록한다(그 밖에는 로컬 캐시만 지운 것이고 원격 폐기 여부는 모른다).
    const revoked = await fetchLimited(
      REVOKE_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      },
      { timeoutMs: fetchLimitMs },
      async (res) => {
        void res.body?.cancel().catch(() => {});
        return res.ok;
      },
    ).catch(() => false);
    if (revoked) debugLog("google:disconnect:revoked");
    else debugLog("google:disconnect:revoke_unconfirmed", undefined, "warn");
  } catch {
    debugLog("google:disconnect:no_token");
  }
}

export interface GoogleConnectionState {
  configured: boolean;
  connected: boolean;
  clientId: string;
}

export async function getGoogleConnectionState(): Promise<GoogleConnectionState> {
  const clientId = getManifestClientId();
  const configured = isGoogleConfigured();
  let connected = false;
  if (configured) {
    try {
      await callGetAuthToken(false);
      connected = true;
    } catch {
      connected = false;
    }
  }
  return { configured, connected, clientId };
}

// 요청 하나의 시간 제한(헤더와 본문 읽기까지). 시험이 줄일 수 있게 변수로 둔다.
let fetchLimitMs = AUTH_FETCH_LIMIT_MS;
// 시험 전용: 시간 제한을 바꾼다(인자 없이 부르면 기본값으로 되돌린다).
export function setGoogleFetchLimitForTest(ms: number = AUTH_FETCH_LIMIT_MS): void {
  fetchLimitMs = ms;
}

// 오류에는 고정 문구와 HTTP 상태 번호만 넣는다(#319). Google이 보낸 본문·statusText, fetch가 던진 글은 넣지 않는다 — 도구 실패는
// 모델·패널·로그로 가고, 응답 본문에는 문서 내용이나 요청에 넣은 값이 섞여 있을 수 있다.
const NO_RESPONSE = "Google 응답을 받지 못했습니다. 쓰기 요청이었다면 반영됐는지 확인한 뒤 다시 시도하세요.";
const UNREADABLE = "Google 응답을 읽지 못했습니다. 쓰기 요청이었다면 반영됐는지 확인한 뒤 다시 시도하세요.";
const REAUTH = "Google 인증이 만료됐습니다. 설정에서 'Google 연결'을 다시 눌러 주세요.";
const CONNECTION_CHANGED = "Google 연결이 바뀌어 멈췄습니다. 다시 시도하세요.";
const ABORTED_BEFORE_SEND = "중단되어 보내지 않았습니다.";
const ABORTED_BEFORE_RETRY = "중단되어 다시 보내지 않았습니다.";

// 상태 번호로만 고르는 안내(본문은 보지 않는다).
function statusHint(status: number): string {
  if (status === 400) return " 요청 값(ID·범위)을 확인하세요.";
  // 403은 권한 부족일 수도, 사용 한도 초과일 수도 있다(본문을 보지 않으므로 원인을 단정하지 않는다).
  if (status === 403) return " Google이 요청을 거부했습니다. 접근 권한이나 사용 한도를 확인하세요.";
  if (status === 404) return " 파일이나 시트를 찾지 못했습니다.";
  if (status === 429) return " 요청이 많습니다. 잠시 뒤 다시 시도하세요.";
  return "";
}

export interface GoogleFetchOptions {
  // 도구 중단 신호. 보내기 직전(토큰을 받은 뒤)과 401 뒤 다시 보내기 직전에 본다(중단됐으면 보내지 않는다). 진행 중인 요청을 끊지는 않는다.
  signal?: AbortSignal;
}

type Attempt = { ok: true; res: Response } | { ok: false; status: number };

// 한 번 보낸다. 성공 응답은 본문을 끝까지 받아(시간 제한 안에서) 새 Response로 돌려준다 — 호출자가 읽을 때 더 기다리지 않는다.
// 실패 응답은 본문을 읽지 않고 상태 번호만 돌려준다. 응답을 받지 못했거나 본문을 다 받지 못하면 고정 문구로 던진다.
async function sendOnce(url: string, init: RequestInit, token: string): Promise<Attempt> {
  const { signal, ...rest } = init;
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  try {
    return await fetchLimited<Attempt>(url, { ...rest, headers }, { timeoutMs: fetchLimitMs, signal: signal ?? undefined }, async (res) => {
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        return { ok: false, status: res.status };
      }
      const buf = await res.arrayBuffer();
      return { ok: true, res: new Response(buf.byteLength ? buf : null, { status: res.status, statusText: res.statusText, headers: res.headers }) };
    });
  } catch {
    throw new Error(NO_RESPONSE);
  }
}

// Google API 요청. 401이면 캐시에서 그 토큰을 지우고 조용히(로그인 창 없이) 다시 받아 한 번만 다시 보낸다.
// 다시 보내지 않는 경우: 그 사이 설정에서 연결·끊기를 시작했거나 요청을 시작할 때 연결·끊기가 진행 중이었음(늦은 재발급이 새 연결이나
// 다른 계정의 토큰을 얻어, 그 전에 시작한 쓰기가 그 권한으로 실행되지 않게), 그 사이 Chrome 프로필의 로그인 상태가 바뀜(다시 받은 토큰이 다른 계정의 것일 수 있다),
// 중단됨(opts.signal), 본문을 다시 쓸 수 없음. 401이 아닌 실패·응답 없음·본문 읽기 실패는
// 다시 보내지 않는다(쓰기가 이미 반영됐을 수 있다).
export async function googleFetch(
  path: string,
  init: RequestInit = {},
  opts: GoogleFetchOptions = {},
): Promise<Response> {
  const startedSeq = authChangeSeq;
  const startedDuringChange = authChanging > 0;
  const signInWatched = watchSignIn();
  const startedSignIn = signInSeq;
  const url = path.startsWith("https://")
    ? path
    : `https://www.googleapis.com${path}`;
  const token = await getGoogleToken();
  // 토큰을 기다리는 사이 중단됐으면 처음부터 보내지 않는다.
  if (opts.signal?.aborted) throw new Error(ABORTED_BEFORE_SEND);
  let attempt = await sendOnce(url, init, token);
  if (!attempt.ok && attempt.status === 401) {
    await callRemoveCachedAuthToken(token);
    if (startedDuringChange || authChangeSeq !== startedSeq || signInSeq !== startedSignIn) throw new Error(CONNECTION_CHANGED);
    // 로그인 상태 변화를 볼 수 없으면 다시 받은 토큰이 같은 계정의 것인지 확인할 수 없다 — 다시 보내지 않는다.
    if (!signInWatched) throw new Error(REAUTH);
    if (opts.signal?.aborted) throw new Error(ABORTED_BEFORE_RETRY);
    // 다시 보낼 수 있는 본문은 없음(조회)·문자열(쓰기)뿐이다.
    if (init.body != null && typeof init.body !== "string") throw new Error(REAUTH);
    let next: string;
    try {
      next = await callGetAuthToken(false);
    } catch {
      throw new Error(REAUTH);
    }
    // 재발급을 기다리는 사이에 끊었거나 Chrome 프로필의 로그인 상태가 바뀌었거나 중단했는지 다시 본다.
    if (authChangeSeq !== startedSeq || signInSeq !== startedSignIn) throw new Error(CONNECTION_CHANGED);
    if (opts.signal?.aborted) throw new Error(ABORTED_BEFORE_RETRY);
    debugLog("google:fetch:retry_401");
    attempt = await sendOnce(url, init, next);
    if (!attempt.ok && attempt.status === 401) {
      await callRemoveCachedAuthToken(next);
      throw new Error(REAUTH);
    }
  }
  if (!attempt.ok) throw new Error(`Google API 오류 ${attempt.status}.${statusHint(attempt.status)}`);
  return attempt.res;
}

// googleFetch 뒤 JSON으로 읽는다. JSON이 아니면 고정 문구로 던진다(파싱 오류의 글에는 본문 앞부분이 들어갈 수 있다).
export async function googleJson<T>(path: string, init: RequestInit = {}, opts: GoogleFetchOptions = {}): Promise<T> {
  const res = await googleFetch(path, init, opts);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(UNREADABLE);
  }
}
