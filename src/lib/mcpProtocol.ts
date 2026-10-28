// MCP 다리(mcp/sbp-mcp.mjs)와 확장 사이의 로컬 프로토콜(#140). 같은 계산이 다리에도 있다(tests/mcpProtocol.test.mjs가 서로 맞춰 본다).
// - 비밀(32바이트)에서 HKDF로 키 셋을 만든다: 확장→다리 암호화, 다리→확장 암호화, 확장 요청 서명.
// - 확장의 요청은 머리(X-SBP: 버전·시각·nonce)와 서명(X-SBP-Mac)으로 인증하고, 모든 본문은 AES-GCM으로 암호화한다
//   (AAD = 메서드·경로·머리). 포트를 가로챈 다른 로컬 프로그램은 요청을 꾸미지도, 결과를 읽지도 못한다.
// Web Crypto만 쓴다(npm test에서도 그대로 돈다). 다른 모듈을 불러오지 않는다.

export const MCP_PROTOCOL_VERSION = 1;
export const MCP_DEFAULT_PORT = 47615;
// 요청 시각 허용 범위.
export const MCP_CLOCK_SKEW_MS = 60_000;

export interface McpKeys {
  extEnc: CryptoKey;
  bridgeEnc: CryptoKey;
  extMac: CryptoKey;
}

export interface McpHeader {
  v: number;
  ts: number;
  nonce: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("잘못된 base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function newSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveKeys(secret: string): Promise<McpKeys> {
  const raw = fromB64url(secret);
  if (raw.length !== 32) throw new Error("비밀은 32바이트여야 합니다.");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const hkdf = (info: string) => ({ name: "HKDF", hash: "SHA-256", salt: enc.encode("sbp-mcp-v1"), info: enc.encode(info) });
  const aes = (info: string) => crypto.subtle.deriveKey(hkdf(info), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    extEnc: await aes("ext->bridge"),
    bridgeEnc: await aes("bridge->ext"),
    extMac: await crypto.subtle.deriveKey(hkdf("ext-mac"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]),
  };
}

export function makeHeader(now: number): string {
  const h: McpHeader = { v: MCP_PROTOCOL_VERSION, ts: now, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) };
  return b64url(enc.encode(JSON.stringify(h)));
}

export function parseHeader(text: string): McpHeader | null {
  try {
    const h = JSON.parse(dec.decode(fromB64url(text))) as Partial<McpHeader>;
    if (h.v !== MCP_PROTOCOL_VERSION || typeof h.ts !== "number" || typeof h.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(h.nonce)) return null;
    return { v: h.v, ts: h.ts, nonce: h.nonce };
  } catch {
    return null;
  }
}

const macInput = (method: string, path: string, header: string) => enc.encode(`${method} ${path}\n${header}`);

export async function signRequest(keys: McpKeys, method: string, path: string, header: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", keys.extMac, macInput(method, path, header))));
}

export async function verifyRequest(keys: McpKeys, method: string, path: string, header: string, mac: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", keys.extMac, fromB64url(mac), macInput(method, path, header));
  } catch {
    return false;
  }
}

// 본문 봉인: base64url(iv 12바이트 | 암호문). aad는 메서드·경로·머리(응답도 그 요청의 머리에 묶는다).
export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

export async function open<T = unknown>(key: CryptoKey, aad: string, body: string): Promise<T> {
  const bytes = fromB64url(body.trim());
  if (bytes.length < 12 + 16) throw new Error("본문이 너무 짧습니다.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, key, bytes.slice(12));
  return JSON.parse(dec.decode(pt)) as T;
}

export const aadOf = (method: string, path: string, header: string) => `${method} ${path}\n${header}`;

// 다리의 /v1/next 응답(복호화한 값).
export interface McpNext {
  bridgeId: string;
  version: string;
  job?: { jobId: string; request: string; deadline: number };
  cancel?: string[];
}

export function parseNext(v: unknown): McpNext | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.bridgeId !== "string" || !o.bridgeId || typeof o.version !== "string") return null;
  const out: McpNext = { bridgeId: o.bridgeId, version: o.version };
  if (o.job !== undefined) {
    const j = o.job as Record<string, unknown> | null;
    if (!j || typeof j.jobId !== "string" || typeof j.request !== "string" || typeof j.deadline !== "number") return null;
    if (!j.request.trim() || j.request.length > 4000) return null;
    out.job = { jobId: j.jobId, request: j.request, deadline: j.deadline };
  }
  if (o.cancel !== undefined) {
    if (!Array.isArray(o.cancel) || !o.cancel.every((x) => typeof x === "string")) return null;
    out.cancel = o.cancel as string[];
  }
  return out;
}
