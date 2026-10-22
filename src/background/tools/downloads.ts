import { DEFAULT_DOWNLOAD_FOLDER, deriveFilenameFromUrl, isDownloadSafeUrl, sanitizeFilenameSegment } from "@/lib/sanitize";

export interface StartDownloadsResult {
  startedCount: number;
  skippedCount: number;
}

// items: 원래 주소와 실제로 내려받을 출처(imageDownloadSources). 일반 경로는 원래 주소, 이번 대화 허락 경로는
// 쿠키 없이 미리 받은 바이트(data: 주소). 파일 이름은 원래 주소에서 정한다.
export async function startImageDownloads(
  items: ReadonlyArray<{ url: string; source: string }>,
  folderPrefix: string,
): Promise<StartDownloadsResult> {
  const seen = new Set<string>();
  const safe = items.filter((it) => isDownloadSafeUrl(it.url) && !seen.has(it.url) && seen.add(it.url));
  const folder = sanitizeFilenameSegment(folderPrefix || DEFAULT_DOWNLOAD_FOLDER);
  let started = 0;

  for (let i = 0; i < safe.length; i += 1) {
    const { url, source } = safe[i];
    const filename = `${folder}/${deriveFilenameFromUrl(url, i)}`;
    try {
      await chrome.downloads.download({
        url: source,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      started += 1;
    } catch (err) {
      console.warn("[download_images] failed", url, err);
    }
  }

  return { startedCount: started, skippedCount: items.length - started };
}
