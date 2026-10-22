import { GRANT_IMAGE_LIMITS, grantImageCountBlock, grantImageResponseBlock } from "@/lib/chatGrant";

// 이번 대화 허락(#53)으로 카드 없이 이미지를 저장하는 경로. chrome.downloads.download에 주소를 넘기면 그 호스트의
// 쿠키를 싣고 리다이렉트를 따라가므로(로그인 사이트의 GET 상태 변경 주소로 리다이렉트하는 "이미지"가 승인 없이
// 인증된 요청이 된다), 허락 경로에서는 쿠키 없이(credentials: omit) 리다이렉트를 따르지 않고 받은 이미지 바이트만
// data: 주소로 저장한다. 하나라도 받지 못하면 허락을 쓰지 않고 카드로 묻는다(카드로 승인하면 기존 다운로드 경로).
// 받은 바이트는 그 호출(callId)에만 쓰고, 실행에서 꺼내 가거나 취소되면 버린다.

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PREPARED_CALLS = 4;

const prepared = new Map<string, Map<string, string>>();

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchImage(url: string, signal?: AbortSignal): Promise<{ dataUrl: string; bytes: number } | string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, {
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const lengthHeader = res.headers.get("content-length");
  const declared = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  const contentType = res.headers.get("content-type") ?? "";
  const why = grantImageResponseBlock({
    status: res.status,
    redirected: res.type === "opaqueredirect" || res.redirected,
    contentType,
    bytes: declared,
  });
  if (why) {
    await res.body?.cancel().catch(() => undefined);
    return why;
  }
  // Content-Length가 없거나 틀려도 상한을 넘으면 읽기를 멈춘다.
  const reader = res.body?.getReader();
  if (!reader) return "이미지를 받지 못함";
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > GRANT_IMAGE_LIMITS.maxBytes) {
      await reader.cancel().catch(() => undefined);
      return "너무 큰 이미지";
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  const type = contentType.split(";")[0].trim().toLowerCase();
  return { dataUrl: `data:${type};base64,${toBase64(bytes)}`, bytes: total };
}

// 허락으로 저장할 이미지를 미리 받아 둔다. 저장할 수 없으면 그 이유(카드로 묻는다), 다 받았으면 null.
export async function prepareGrantImages(callId: string, urls: string[], signal?: AbortSignal): Promise<string | null> {
  const unique = [...new Set(urls)];
  const countWhy = grantImageCountBlock(unique.length);
  if (countWhy) return countWhy;
  const out = new Map<string, string>();
  let total = 0;
  for (const url of unique) {
    let got: Awaited<ReturnType<typeof fetchImage>>;
    try {
      got = await fetchImage(url, signal);
    } catch {
      // 리다이렉트를 따르지 않는 요청의 네트워크 오류·시간 초과.
      return "쿠키 없이 이미지를 받지 못함";
    }
    if (typeof got === "string") return got;
    total += got.bytes;
    if (total > GRANT_IMAGE_LIMITS.maxTotalBytes) return "이미지 전체 크기가 너무 큼";
    out.set(url, got.dataUrl);
  }
  prepared.set(callId, out);
  while (prepared.size > MAX_PREPARED_CALLS) {
    const oldest = prepared.keys().next().value;
    if (oldest === undefined) break;
    prepared.delete(oldest);
  }
  return null;
}

// 실행에서 이 호출의 미리 받은 이미지(주소 → data: 주소)를 꺼낸다. 없으면 null(카드로 승인한 일반 경로).
export function takeGrantImages(callId: string): Map<string, string> | null {
  const m = prepared.get(callId) ?? null;
  prepared.delete(callId);
  return m;
}

export function discardGrantImages(callId: string): void {
  prepared.delete(callId);
}
