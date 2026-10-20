// 받아 온 HTML의 문자 인코딩: Content-Type의 charset → 문서 앞부분의 <meta charset> / http-equiv → null(UTF-8로 시도).
// 앞부분은 latin1로 읽어 ASCII인 meta 선언만 찾는다.
const META_SCAN_BYTES = 4096;

function cleanLabel(v: string | undefined): string | null {
  const s = (v ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  return /^[a-z0-9._:-]{2,40}$/.test(s) ? s : null;
}

export function htmlCharset(contentType: string | null, bytes: Uint8Array): string | null {
  const fromHeader = /charset\s*=\s*("?)([^";\s]+)\1/i.exec(contentType ?? "");
  const header = cleanLabel(fromHeader?.[2]);
  if (header) return header;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, META_SCAN_BYTES));
  const meta = /<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head);
  return cleanLabel(meta?.[1]);
}

export function decodeHtml(contentType: string | null, bytes: Uint8Array): string {
  const label = htmlCharset(contentType, bytes);
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* 모르는 이름이면 아래로 */
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}
