import { deriveFilenameFromUrl, sanitizeDownloadUrls, sanitizeFilenameSegment } from "@/lib/sanitize";

export interface StartDownloadsResult {
  startedCount: number;
  skippedCount: number;
}

export async function startImageDownloads(
  urls: string[],
  folderPrefix: string,
): Promise<StartDownloadsResult> {
  const safe = sanitizeDownloadUrls(urls);
  const folder = sanitizeFilenameSegment(folderPrefix || "downloads");
  let started = 0;

  for (let i = 0; i < safe.length; i += 1) {
    const url = safe[i];
    const filename = `${folder}/${deriveFilenameFromUrl(url, i)}`;
    try {
      await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
      started += 1;
    } catch (err) {
      console.warn("[download_images] failed", url, err);
    }
  }

  return { startedCount: started, skippedCount: urls.length - started };
}
