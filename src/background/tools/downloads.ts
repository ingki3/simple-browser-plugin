import { DEFAULT_DOWNLOAD_FOLDER, sanitizeFilenameSegment } from "@/lib/sanitize";
import { downloadOutcome, imageSavedLocation, saveFileName, savedLocation, urlFileName, type DownloadKind } from "@/lib/downloadPick";

// 이미지·첨부 파일 저장(#48). 사용자가 카드에서 고른 고정 후보만 넘어온다(downloadChoices.ts).
// 항목마다 내려받기를 시작하고 끝날 때까지(한도 안에서) 기다려 성공·실패(이유)와 저장 위치를 돌려준다.

export interface DownloadRequest {
  // 원래 주소(페이지의 이미지·링크). 결과와 이름은 이 주소로 정한다.
  url: string;
  label?: string;
  // 실제로 내려받을 출처. 일반 경로는 원래 주소, 이번 대화 허락 경로의 이미지는 쿠키 없이 미리 받은 바이트(data: 주소).
  source: string;
}

export interface DownloadItemResult {
  url: string;
  label?: string;
  ok: boolean;
  // 저장 위치: 브라우저 다운로드 폴더 아래 '폴더/파일 이름'(사용자 폴더 경로는 넣지 않는다).
  savedAs?: string;
  bytes?: number;
  reason?: string;
  note?: string;
}

export interface DownloadRunResult {
  folder: string;
  startedCount: number;
  savedCount: number;
  results: DownloadItemResult[];
}

// 끝나기를 기다리는 최대 시간(큰 파일은 받는 중으로 알린다).
const WAIT_MS = 45_000;

// ── 첨부 파일 이름 정하기 ──
// 첨부 파일은 브라우저가 이름을 정하게 두고(Content-Disposition → 주소 → 형식), onDeterminingFilename에서 고른 폴더와
// 정리한 이름(saveFileName)으로 바꾼다. 같은 이름은 uniquify. 이 확장이 시작한 내려받기 중 기다리는 주소만 바꾸고,
// 다른 내려받기(사용자가 직접 받은 것 포함)는 그대로 둔다. 리스너는 내려받는 동안에만 등록한다.
const nameHints = new Map<string, Array<{ folder: string; index: number }>>();
let activeRuns = 0;

function onDeterminingFilename(
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
): void {
  const queue = item.byExtensionId === chrome.runtime.id ? nameHints.get(item.url) : undefined;
  const hint = queue?.shift();
  if (queue && !queue.length) nameHints.delete(item.url);
  if (!hint) {
    suggest();
    return;
  }
  const name = saveFileName({ kind: "file", suggested: item.filename, url: item.finalUrl || item.url, mime: item.mime, index: hint.index });
  suggest({ filename: `${hint.folder}/${name}`, conflictAction: "uniquify" });
}

function beginNaming(): void {
  if (activeRuns++ === 0) chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
}

function endNaming(urls: string[]): void {
  for (const u of urls) nameHints.delete(u);
  if (--activeRuns === 0) {
    nameHints.clear();
    chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
  }
}

// 시작한 내려받기들이 끝날 때까지(완료·중단) 기다린다. 시간이 다 되거나 중단되면 그때 상태로 돌려준다.
async function waitForDownloads(ids: number[], signal?: AbortSignal): Promise<Map<number, chrome.downloads.DownloadItem>> {
  const pending = new Set(ids);
  let wake: (() => void) | null = null;
  const onChanged = (d: chrome.downloads.DownloadDelta) => {
    const s = d.state?.current;
    if (pending.has(d.id) && (s === "complete" || s === "interrupted")) {
      pending.delete(d.id);
      if (!pending.size) wake?.();
    }
  };
  chrome.downloads.onChanged.addListener(onChanged);
  try {
    // 리스너를 걸기 전에 이미 끝난 것.
    for (const id of ids) {
      const [it] = await chrome.downloads.search({ id });
      if (!it || it.state !== "in_progress") pending.delete(id);
    }
    if (pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => wake?.();
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, WAIT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    chrome.downloads.onChanged.removeListener(onChanged);
  }
  const out = new Map<number, chrome.downloads.DownloadItem>();
  for (const id of ids) {
    const [it] = await chrome.downloads.search({ id });
    if (it) out.set(id, it);
  }
  return out;
}

function dataMime(source: string): string | null {
  return source.startsWith("data:") ? source.slice(5).split(/[;,]/)[0] || null : null;
}

export async function runDownloads(
  kind: DownloadKind,
  items: readonly DownloadRequest[],
  folderPrefix: string,
  signal?: AbortSignal,
): Promise<DownloadRunResult> {
  const folder = sanitizeFilenameSegment(folderPrefix || DEFAULT_DOWNLOAD_FOLDER);
  const seen = new Set<string>();
  const unique = items.filter((it) => !seen.has(it.url) && seen.add(it.url));
  const started: Array<{ req: DownloadRequest; id: number; name?: string }> = [];
  const results = new Map<string, DownloadItemResult>();
  const fileUrls: string[] = [];
  if (kind === "file") beginNaming();
  try {
    for (let i = 0; i < unique.length; i += 1) {
      const req = unique[i];
      const base = { url: req.url, ...(req.label ? { label: req.label } : {}) };
      if (signal?.aborted) {
        results.set(req.url, { ...base, ok: false, reason: "중단되어 받지 않음" });
        continue;
      }
      try {
        let id: number;
        let name: string | undefined;
        if (kind === "image") {
          // 이미지는 주소의 이름으로 저장한다(허락 경로의 data: 주소는 받은 형식으로 확장자를 붙인다).
          name = saveFileName({ kind, suggested: urlFileName(req.url), url: req.url, mime: dataMime(req.source), index: i });
          id = await chrome.downloads.download({ url: req.source, filename: `${folder}/${name}`, saveAs: false, conflictAction: "uniquify" });
        } else {
          const queue = nameHints.get(req.source) ?? [];
          queue.push({ folder, index: i });
          nameHints.set(req.source, queue);
          fileUrls.push(req.source);
          id = await chrome.downloads.download({ url: req.source, saveAs: false, conflictAction: "uniquify" });
        }
        started.push({ req, id, ...(name ? { name } : {}) });
      } catch (err) {
        // 오류 문구는 모델에 싣지 않고(고정 분류만) 디버그 콘솔에만 남긴다.
        console.warn(`[${kind === "image" ? "download_images" : "download_files"}] start failed`, req.url, err);
        results.set(req.url, { ...base, ...downloadOutcome({ kind, state: "not_started", url: req.url }) });
      }
    }
    const done = started.length ? await waitForDownloads(started.map((s) => s.id), signal) : new Map();
    for (const { req, id, name } of started) {
      const it = done.get(id);
      const base = { url: req.url, ...(req.label ? { label: req.label } : {}) };
      if (!it) {
        results.set(req.url, { ...base, ok: false, reason: "내려받기 기록이 사라짐(지워졌거나 취소됨)" });
        continue;
      }
      const state = it.state === "complete" || it.state === "interrupted" ? it.state : "in_progress";
      const outcome = downloadOutcome({ kind, state, error: it.error, mime: it.mime, url: req.source, finalUrl: it.finalUrl });
      // 첨부 파일(download_files, 외부 본문 보호를 켜는 도구)은 브라우저가 정한 이름(Content-Disposition 포함) 그대로,
      // 이미지(보호를 켜지 않음)는 확장이 정한 이름과 uniquify 꼬리표만 알린다.
      let savedAs = "";
      if (it.filename && kind === "image" && name) {
        const loc = imageSavedLocation(folder, name, it.filename);
        savedAs = loc.savedAs;
        if (loc.renamed) outcome.note = [outcome.note, "브라우저가 받은 형식에 맞춰 파일 이름을 바꿨을 수 있음"].filter(Boolean).join(" / ");
      } else if (it.filename) {
        savedAs = savedLocation(folder, it.filename);
      }
      results.set(req.url, {
        ...base,
        ...outcome,
        ...(savedAs && state !== "interrupted" ? { savedAs } : {}),
        ...(state === "complete" && it.fileSize > 0 ? { bytes: it.fileSize } : {}),
      });
    }
  } finally {
    if (kind === "file") endNaming(fileUrls);
  }
  const ordered = unique.map((u) => results.get(u.url)).filter((r): r is DownloadItemResult => !!r);
  return {
    folder,
    startedCount: started.length,
    savedCount: ordered.filter((r) => r.ok).length,
    results: ordered,
  };
}
