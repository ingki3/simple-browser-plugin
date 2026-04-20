import { GOOGLE_SCOPES } from "@/lib/messages";
import { getSettings } from "../storage";
import { debugLog } from "../debug";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  clientId: string;
  scopes: string;
}

const TOKEN_KEY = "googleToken";
let cache: CachedToken | null = null;

async function readCache(): Promise<CachedToken | null> {
  if (cache) return cache;
  const obj = await chrome.storage.local.get(TOKEN_KEY);
  const raw = obj[TOKEN_KEY] as CachedToken | undefined;
  if (!raw) return null;
  cache = raw;
  return raw;
}

async function writeCache(t: CachedToken): Promise<void> {
  cache = t;
  await chrome.storage.local.set({ [TOKEN_KEY]: t });
}

export async function clearGoogleToken(): Promise<void> {
  cache = null;
  await chrome.storage.local.remove(TOKEN_KEY);
}

async function startAuthFlow(
  clientId: string,
  interactive: boolean,
): Promise<CachedToken> {
  const redirectUri = chrome.identity.getRedirectURL();
  const state = crypto.randomUUID();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("include_granted_scopes", "true");
  if (interactive) url.searchParams.set("prompt", "consent");

  const resultUrl = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive,
  });

  if (!resultUrl) {
    throw new Error("Google 인증이 취소되었습니다.");
  }

  const parsed = new URL(resultUrl);
  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const params = new URLSearchParams(fragment);
  const err = params.get("error");
  if (err) {
    throw new Error(`Google OAuth 오류: ${err} ${params.get("error_description") ?? ""}`);
  }
  const accessToken = params.get("access_token");
  const expiresIn = Number(params.get("expires_in") ?? "3600");
  const returnedState = params.get("state");
  if (!accessToken) throw new Error("Google에서 access_token이 반환되지 않았습니다.");
  if (returnedState !== state) {
    throw new Error("OAuth state 불일치 (CSRF 가능성). 다시 시도해 주세요.");
  }

  const token: CachedToken = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000 - 60_000,
    clientId,
    scopes: GOOGLE_SCOPES.join(" "),
  };
  await writeCache(token);
  return token;
}

export async function connectGoogle(): Promise<{ ok: true }> {
  const { googleClientId } = await getSettings();
  if (!googleClientId) {
    throw new Error(
      "Google OAuth 클라이언트 ID가 설정되지 않았습니다. 설정에서 입력해 주세요.",
    );
  }
  debugLog("google:auth:start", "interactive");
  const t = await startAuthFlow(googleClientId, true);
  debugLog("google:auth:ok", `expires in ${Math.round((t.expiresAt - Date.now()) / 1000)}s`);
  return { ok: true };
}

export async function getGoogleToken(): Promise<string> {
  const { googleClientId } = await getSettings();
  if (!googleClientId) {
    throw new Error(
      "Google OAuth 클라이언트 ID가 설정되지 않았습니다. 설정에서 입력한 뒤 'Google 연결' 버튼을 눌러 주세요.",
    );
  }

  const cached = await readCache();
  if (
    cached &&
    cached.clientId === googleClientId &&
    cached.scopes === GOOGLE_SCOPES.join(" ") &&
    Date.now() < cached.expiresAt
  ) {
    return cached.accessToken;
  }

  // Try silent refresh first.
  try {
    const t = await startAuthFlow(googleClientId, false);
    return t.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Google 토큰을 새로 받아야 합니다. 설정에서 'Google 연결' 버튼을 눌러 재인증해 주세요. (원인: ${msg})`,
    );
  }
}

export interface GoogleConnectionState {
  configured: boolean;
  connected: boolean;
  expiresAt: number | null;
  clientId: string;
}

export async function getGoogleConnectionState(): Promise<GoogleConnectionState> {
  const { googleClientId } = await getSettings();
  const cached = await readCache();
  const connected =
    !!cached &&
    cached.clientId === googleClientId &&
    Date.now() < cached.expiresAt;
  return {
    configured: !!googleClientId,
    connected,
    expiresAt: cached?.expiresAt ?? null,
    clientId: googleClientId,
  };
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res;
}
