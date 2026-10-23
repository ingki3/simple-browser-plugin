import { DEFAULT_DOWNLOAD_FOLDER, sanitizeFilenameSegment } from "@/lib/sanitize";
import { DownloadNameHints } from "@/lib/downloadNames";
import { downloadOutcome, imageSavedLocation, saveFileName, savedLocation, urlFileName, type DownloadKind } from "@/lib/downloadPick";

// 이미지·첨부 파일 저장(#48). 사용자가 카드에서 고른 고정 후보만 넘어온다(downloadChoices.ts).
// 항목마다 내려받기를 시작하고 끝날 때까지(한도 안에서) 기다려 성공·실패(이유)와 저장 위치를 돌려준다.

export interface DownloadRequest {
  // 원래 주소(페이지의 이미지·링크). 결과와 이름은 이 주소로 정한다.
  url: string;
  label?: string;
  // 실제로 내려받을 출처. 일반 경로는 원래 주소, 이번 대화 허락 경로의 이미지는 쿠키 없이 미리 받은 바이트(data: 주소).
  source: string;
  // 확장이 정한 저장 이름(이미지만, 페이지 캡처 #49 — 사이트·시각). 없으면 주소의 이름으로 정한다.
  name?: string;
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

// 시작부터 끝나기까지 기다리는 최대 시간(큰 파일·느린 서버는 받는 중으로 알린다).
const WAIT_MS = 45_000;

// ── 첨부 파일 이름 정하기 ──
// 첨부 파일은 브라우저가 이름을 정하게 두고(Content-Disposition → 주소 → 형식), onDeterminingFilename에서 고른 폴더와
// 정리한 이름(saveFileName)으로 바꾼다. 같은 이름은 uniquify. 힌트는 실행마다 소유하고 다운로드 id로 묶는다
// (src/lib/downloadNames.ts — 같은 주소를 두 실행이 다른 폴더로 받아도 섞이지 않는다). 이 확장이 시작한 내려받기 중
// 힌트가 있는 것만 바꾸고, 다른 내려받기(사용자가 직접 받은 것 포함)는 그대로 둔다. 리스너는 첨부를 받는 실행이 있거나
// 아직 쓰지 않은 힌트가 남아 있는 동안에만 등록한다(실행이 시간 초과로 먼저 끝나도 늦게 오는 이름 정하기를 맞춘다).
const nameHints = new DownloadNameHints();
let namingRuns = 0;
let listening = false;
let runSeq = 0;

function onDeterminingFilename(
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void,
): void {
  const hint = item.byExtensionId === chrome.runtime.id ? nameHints.claim(item.id, item.url) : null;
  if (!hint) {
    suggest();
  } else {
    const name = saveFileName({ kind: "file", suggested: item.filename, url: item.finalUrl || item.url, mime: item.mime, index: hint.index });
    suggest({ filename: `${hint.folder}/${name}`, conflictAction: "uniquify" });
  }
  syncNamingListener();
}

function syncNamingListener(): void {
  const want = namingRuns > 0 || nameHints.size > 0;
  if (want && !listening) chrome.downloads.onDeterminingFilename.addListener(onDeterminingFilename);
  if (!want && listening) chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
  listening = want;
}

// 같은 주소의 download() 호출은 한 번에 하나씩 한다(실행이 달라도). download()는 응답 헤더가 온 뒤에야 id를 돌려주고
// 이름 정하기 이벤트가 그보다 먼저 올 수 있어, 그 주소의 "시작 중"이 하나뿐이어야 주소로 그 시작을 알아볼 수 있다.
// 다른 주소끼리는 막지 않는다(느린 서버 하나가 다른 내려받기를 붙잡지 않게).
const startLocks = new Map<string, Promise<unknown>>();
function oneStartPerUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const prev = startLocks.get(url) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  startLocks.set(url, tail);
  void tail.then(() => {
    if (startLocks.get(url) === tail) startLocks.delete(url);
  });
  return run;
}

// 중단되면(이미 중단돼 있었으면 바로) 끝나는 기다림.
function untilAbort(signal: AbortSignal | undefined): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve("aborted");
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

function untilDeadline(deadline: number): { promise: Promise<"timeout">; clear(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
  });
  return { promise, clear: () => clearTimeout(timer) };
}

// 시작한 내려받기들이 끝날 때까지(완료·중단) 기다린다. 마감 시각이 되거나 중단되면 그때 상태로 돌려준다.
async function waitForDownloads(
  ids: number[],
  deadline: number,
  signal?: AbortSignal,
): Promise<Map<number, chrome.downloads.DownloadItem>> {
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
        // download()·초기 search()를 기다리는 사이에 이미 중단됐으면 abort 이벤트는 다시 오지 않으므로 바로 끝낸다.
        if (signal?.aborted) return resolve();
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
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

// 중단된 실행의 내려받기는 취소한다(아직 받는 중인 것, 중단 뒤에 늦게 시작된 것).
function cancelDownload(id: number): void {
  void chrome.downloads.cancel(id).catch(() => undefined);
}

type StartOutcome = number | "failed" | "skipped";

export async function runDownloads(
  kind: DownloadKind,
  items: readonly DownloadRequest[],
  folderPrefix: string,
  signal?: AbortSignal,
): Promise<DownloadRunResult> {
  const folder = sanitizeFilenameSegment(folderPrefix || DEFAULT_DOWNLOAD_FOLDER);
  const deadline = Date.now() + WAIT_MS;
  const seen = new Set<string>();
  const unique = items.filter((it) => !seen.has(it.url) && seen.add(it.url));
  const results = new Map<string, DownloadItemResult>();
  // 이 실행이 소유한 이름 힌트(끝난 내려받기의 것만 지운다).
  const run = ++runSeq;
  if (kind === "file") {
    namingRuns += 1;
    syncNamingListener();
  }
  const started: Array<{ req: DownloadRequest; id: number; name?: string }> = [];
  // 시작이 끝난 항목(주소 → 결과). 마감·중단 때는 그때까지 끝난 것만 본다.
  const settled = new Map<string, { id: StartOutcome; name?: string }>();
  // 결과를 다 모은 뒤(마감·중단 이후)에 늦게 시작된 내려받기를 알아보려고.
  let collected = false;
  try {
    // 항목마다 시작한다(같은 주소만 직렬화). download()는 응답 헤더가 와야 끝나므로 마감·중단과 경주시킨다.
    const starts = unique.map(async (req, i) => {
      // 이미지는 주소의 이름으로 저장한다(허락 경로의 data: 주소는 받은 형식으로 확장자를 붙인다).
      const name =
        kind === "image"
          ? req.name ?? saveFileName({ kind, suggested: urlFileName(req.url), url: req.url, mime: dataMime(req.source), index: i })
          : undefined;
      let id: StartOutcome;
      try {
        id = await oneStartPerUrl(req.source, async (): Promise<StartOutcome> => {
          if (signal?.aborted || collected) return "skipped";
          if (name) {
            const got = await chrome.downloads.download({ url: req.source, filename: `${folder}/${name}`, saveAs: false, conflictAction: "uniquify" });
            nameHints.noteOther(got);
            return got;
          }
          nameHints.beginStart(req.source, { run, folder, index: i });
          syncNamingListener();
          let got: number | null = null;
          try {
            got = await chrome.downloads.download({ url: req.source, saveAs: false, conflictAction: "uniquify" });
            return got;
          } finally {
            nameHints.endStart(req.source, got);
            syncNamingListener();
          }
        });
      } catch (err) {
        // 오류 문구는 모델에 싣지 않고(고정 분류만) 디버그 콘솔에만 남긴다.
        console.warn(`[${kind === "image" ? "download_images" : "download_files"}] start failed`, req.url, err);
        id = "failed";
      }
      // 중단 뒤에 늦게 시작된 것은 취소한다(결과에는 이미 중단으로 알렸다).
      if (typeof id === "number" && collected && signal?.aborted) cancelDownload(id);
      if (!collected) settled.set(req.url, { id, ...(name ? { name } : {}) });
    });
    const timer = untilDeadline(deadline);
    await Promise.race([Promise.all(starts), timer.promise, untilAbort(signal)]);
    timer.clear();
    collected = true;
    for (const req of unique) {
      const base = { url: req.url, ...(req.label ? { label: req.label } : {}) };
      const s = settled.get(req.url);
      if (!s || s.id === "skipped") {
        results.set(
          req.url,
          signal?.aborted || s?.id === "skipped"
            ? { ...base, ok: false, reason: "중단되어 받지 않음" }
            : { ...base, ...downloadOutcome({ kind, state: "in_progress", url: req.url }) },
        );
      } else if (s.id === "failed") {
        results.set(req.url, { ...base, ...downloadOutcome({ kind, state: "not_started", url: req.url }) });
      } else {
        started.push({ req, id: s.id, ...(s.name ? { name: s.name } : {}) });
      }
    }
    const done = started.length
      ? await waitForDownloads(started.map((s) => s.id), deadline, signal)
      : new Map<number, chrome.downloads.DownloadItem>();
    const finished: number[] = [];
    for (const { req, id, name } of started) {
      const it = done.get(id);
      const base = { url: req.url, ...(req.label ? { label: req.label } : {}) };
      if (!it) {
        finished.push(id);
        results.set(req.url, { ...base, ok: false, reason: "내려받기 기록이 사라짐(지워졌거나 취소됨)" });
        continue;
      }
      if (it.state === "in_progress" && signal?.aborted) {
        cancelDownload(id);
        finished.push(id);
        results.set(req.url, { ...base, ok: false, reason: "중단되어 받기를 취소함" });
        continue;
      }
      if (it.state !== "in_progress") finished.push(id);
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
    nameHints.forget(run, finished);
  } finally {
    if (kind === "file") namingRuns -= 1;
    syncNamingListener();
  }
  const ordered = unique.map((u) => results.get(u.url)).filter((r): r is DownloadItemResult => !!r);
  return {
    folder,
    startedCount: started.length,
    savedCount: ordered.filter((r) => r.ok).length,
    results: ordered,
  };
}
