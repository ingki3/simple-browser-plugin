const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function parseSafeHttpUrl(raw: string): URL | null {
  if (CONTROL_CHARACTERS.test(raw)) return null;
  try {
    const url = new URL(raw);
    return ALLOWED_SCHEMES.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function isDownloadSafeUrl(raw: string): boolean {
  return parseSafeHttpUrl(raw) !== null;
}

export function isNavigationSafeUrl(raw: string): boolean {
  const url = parseSafeHttpUrl(raw);
  return url !== null && url.username === "" && url.password === "";
}

export function normalizeNavigationUrl(raw: string): string {
  const url = parseSafeHttpUrl(raw);
  if (!url || url.username || url.password) {
    throw new Error("이동 주소는 사용자 정보가 없는 유효한 http/https URL이어야 합니다.");
  }
  return url.href;
}

export function sanitizeDownloadUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!isDownloadSafeUrl(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export function sanitizeFilenameSegment(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim() || "file";
}

export function deriveFilenameFromUrl(rawUrl: string, fallbackIndex: number): string {
  try {
    const u = new URL(rawUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const cleaned = sanitizeFilenameSegment(decodeURIComponent(last));
    if (cleaned && cleaned !== "file") return cleaned;
  } catch {
    // fall through
  }
  return `image-${fallbackIndex + 1}`;
}
