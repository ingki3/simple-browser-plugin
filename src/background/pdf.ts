const MAX_PDF_BYTES = 20 * 1024 * 1024; // Keep extension messaging/request payloads bounded.

export interface PdfTabInfo {
  isPdf: boolean;
  url: string;
}

export async function detectPdfAtActiveTab(): Promise<PdfTabInfo | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return null;
  const url = tab.url;

  if (/^chrome-extension:\/\/[a-z]+\/.*\.pdf/i.test(url)) return { isPdf: true, url };
  if (/\.pdf(\?|#|$)/i.test(url)) return { isPdf: true, url };

  return { isPdf: false, url };
}

export interface PdfPayload {
  data: string;
  bytes: number;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(
      String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk))),
    );
  }
  return btoa(parts.join(""));
}

export async function fetchPdfAsBase64(url: string): Promise<PdfPayload> {
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new Error(`PDF URL 파싱 실패: ${url}`);
  }

  if (scheme === "file:") {
    throw new Error(
      "로컬 파일(file://) PDF는 확장의 서비스 워커에서 직접 읽을 수 없습니다. Chrome 정책상 파일 URL 액세스 옵션과 무관하게 차단됩니다. 파일을 HTTPS로 호스팅한 뒤 그 URL로 열거나, 가능한 경우 텍스트를 직접 붙여넣어 주세요.",
    );
  }
  if (scheme === "chrome-extension:") {
    throw new Error(
      "Chrome 내장 PDF 뷰어 내부 리소스는 확장에서 접근할 수 없습니다. 원본 PDF URL(https://)을 주소창에서 직접 열어 주세요.",
    );
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(`지원하지 않는 URL 스킴: ${scheme}`);
  }

  let res: Response;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PDF fetch 네트워크 오류: ${msg}. 원인 후보: (a) PDF가 로그인 세션·쿠키로 보호됨, (b) 서버가 확장 origin을 CORS로 차단, (c) 네트워크 단절. 브라우저 주소창에서 해당 URL이 직접 열리는지 확인 후, 열리는데도 실패하면 페이지를 새로고침 하거나 다른 호스팅된 URL로 시도해 주세요.`,
    );
  }
  if (!res.ok) {
    throw new Error(`PDF 가져오기 실패: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new Error("PDF가 비어 있습니다.");
  }
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `PDF가 너무 큽니다 (${Math.round(buf.byteLength / 1024 / 1024)}MB). 20MB 이하만 지원합니다.`,
    );
  }
  return { data: arrayBufferToBase64(buf), bytes: buf.byteLength };
}
