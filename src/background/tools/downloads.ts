import { DEFAULT_DOWNLOAD_FOLDER, deriveFilenameFromUrl, sanitizeDownloadUrls, sanitizeFilenameSegment } from "@/lib/sanitize";

export interface StartDownloadsResult {
  startedCount: number;
  skippedCount: number;
}

// prepared가 있으면(이번 대화 허락 경로, grantImages.ts) 주소 대신 쿠키 없이 미리 받은 바이트(data: 주소)를 저장한다.
// 파일 이름은 원래 주소에서 정한다.
export async function startImageDownloads(
  urls: string[],
  folderPrefix: string,
  prepared?: ReadonlyMap<string, string>,
): Promise<StartDownloadsResult> {
  const safe = sanitizeDownloadUrls(urls);
  const folder = sanitizeFilenameSegment(folderPrefix || DEFAULT_DOWNLOAD_FOLDER);
  let started = 0;

  for (let i = 0; i < safe.length; i += 1) {
    const url = safe[i];
    const filename = `${folder}/${deriveFilenameFromUrl(url, i)}`;
    const source = prepared ? prepared.get(url) : url;
    if (!source) continue;
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

  return { startedCount: started, skippedCount: urls.length - started };
}
