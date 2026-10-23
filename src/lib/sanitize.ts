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

// 설정에도 호출에도 저장 폴더가 없을 때 쓰는 폴더.
export const DEFAULT_DOWNLOAD_FOLDER = "downloads";

export function sanitizeFilenameSegment(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim() || "file";
}
