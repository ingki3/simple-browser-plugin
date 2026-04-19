const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export function isDownloadSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!ALLOWED_SCHEMES.has(url.protocol)) return false;
    if (/[\u0000-\u001f\u007f]/.test(raw)) return false;
    return true;
  } catch {
    return false;
  }
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
