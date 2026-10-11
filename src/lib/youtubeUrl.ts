// YouTube 영상 페이지(watch, shorts, live)면 영상 ID, 아니면 null.
export function youtubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v") || null;
  return url.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/)?.[1] ?? null;
}
