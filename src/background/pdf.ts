const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB inlineData limit

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
  const res = await fetch(url);
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
