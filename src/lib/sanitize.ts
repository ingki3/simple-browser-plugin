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

// 반복해도 같은 값이 되게(고정점까지) 정리한다(#192 — 미리보기에서 정한 폴더를 실행이 다시 정리해도 바뀌지 않게).
// 예: " .reports"는 한 번 정리하면 ".reports"였지만 이제 바로 "reports".
export function sanitizeFilenameSegment(raw: string): string {
  let cur = raw;
  // 바뀌면 길이가 줄어드는 정리라 몇 번 안에 멈춘다(상한은 안전장치).
  for (let i = 0; i < 200; i++) {
    const next =
      cur
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/\.\.+/g, "_")
        .replace(/^\.+/, "")
        .slice(0, 80)
        .trim() || "file";
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}
