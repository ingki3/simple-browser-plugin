import { debugLog } from "../debug";

function getManifestClientId(): string {
  const mf = chrome.runtime.getManifest() as chrome.runtime.Manifest & {
    oauth2?: { client_id?: string; scopes?: string[] };
  };
  return mf.oauth2?.client_id ?? "";
}

function requireOauthConfigured(): void {
  if (!getManifestClientId()) {
    throw new Error(
      "Google OAuth 클라이언트 ID가 manifest에 설정되지 않았습니다. manifest.config.ts 의 GOOGLE_OAUTH_CLIENT_ID 에 값을 넣고(또는 환경변수로 주입하고) 다시 빌드·재설치해 주세요. 타입은 'Chrome 확장 프로그램'으로 만들어야 합니다.",
    );
  }
  if (typeof chrome.identity === "undefined") {
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

export async function connectGoogle(): Promise<{ ok: true }> {
  requireOauthConfigured();
  debugLog("google:auth:start", "interactive");
  await callGetAuthToken(true);
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

export async function clearGoogleToken(): Promise<void> {
  if (typeof chrome.identity === "undefined") return;
  try {
    const token = await callGetAuthToken(false);
    await callRemoveCachedAuthToken(token);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
    }).catch(() => undefined);
    debugLog("google:disconnect:revoked");
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
  const configured = !!clientId && typeof chrome.identity !== "undefined";
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

export async function googleFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getGoogleToken();
  const headers = new Headers(init.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const url = path.startsWith("https://")
    ? path
    : `https://www.googleapis.com${path}`;
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // Token probably expired or scopes changed; clear cache so next call re-auths.
    try {
      await callRemoveCachedAuthToken(token);
    } catch {
      /* ignore */
    }
    throw new Error(
      "Google API 401 Unauthorized. 토큰 캐시를 지웠습니다. 설정에서 'Google 연결'을 다시 눌러 주세요.",
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res;
}
