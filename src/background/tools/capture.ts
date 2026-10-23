import {
  CAPTURE_LIMITS,
  captureBlockReason,
  captureFileName,
  nextTileY,
  planStitch,
  pngSize,
  type CaptureMetrics,
  type CaptureScrolled,
  type StitchJob,
  type StitchReleaseJob,
  type StitchResult,
} from "@/lib/pageCapture";
import type { BgToContent } from "@/lib/messages";
import { waitForNavigationSettle } from "../navigation";
import { runOffscreenJob } from "../offscreen";
import { callContentTool, isMissingReceiver, queryContent, resolveTurnTab, type TurnTab } from "./handlers";
import { runDownloads, type DownloadRunResult } from "./downloads";

// 보고 있는 페이지 캡처(capture_page, #49). 보이는 화면은 chrome.tabs.captureVisibleTab 한 번, 전체 페이지는
// 맨 위부터 화면 높이씩 스크롤하며 찍어 offscreen 문서의 캔버스로 이어 붙인다(chrome.debugger는 쓰지 않는다).
// 결과는 chrome.downloads로 PNG 저장만 한다 — 이미지를 모델에 보내지 않는다. 모델로 가는 결과에는 고정 문구,
// 확장이 정한 이름(사이트·시각), 크기 숫자만 싣는다.

export interface CaptureTarget {
  tabId: number;
  windowId: number;
  url: string;
}

// 캡처할 수 있는 탭인지(주소 형태)와 지금 그 창에서 보이는 탭인지 확인한다. captureVisibleTab은 창의 활성 탭을
// 찍으므로, 턴 탭이 앞에 있지 않으면 다른 탭을 찍지 않게 멈춘다.
export async function captureTarget(turnTab: TurnTab): Promise<CaptureTarget> {
  const tabId = await resolveTurnTab(turnTab, { allowInternal: true });
  await waitForNavigationSettle(tabId, 10_000);
  const tab = await chrome.tabs.get(tabId);
  const why = captureBlockReason(tab.url);
  if (why) throw new Error(`캡처하지 않았습니다: ${why}.`);
  const target = { tabId, windowId: tab.windowId, url: tab.url ?? "" };
  await assertVisible(target);
  return target;
}

async function assertVisible(t: CaptureTarget): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(t.tabId);
  } catch {
    throw new Error("캡처할 탭이 닫혔습니다.");
  }
  if (tab.url !== t.url) throw new Error("캡처하는 동안 탭의 주소가 바뀌어 멈췄습니다.");
  if (!tab.active) {
    throw new Error("캡처할 탭이 그 창의 앞에 보이는 탭이 아니라 캡처하지 않았습니다. 그 탭을 앞으로 띄운 뒤 다시 요청하세요.");
  }
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (win?.state === "minimized") throw new Error("창이 최소화되어 있어 캡처하지 않았습니다.");
}

// captureVisibleTab 호출 한도(초당 2회)에 맞춰 호출 사이를 띄운다(대화·호출과 관계없이 서비스 워커 전체에서).
let lastCaptureAt = 0;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("중단되어 캡처를 멈췄습니다.");
}

// 지금 보이는 화면 한 장(PNG data: 주소). 앞뒤로 그 탭이 보이는 탭인지 확인한다(찍는 사이 다른 탭으로 바뀌면 버린다).
async function grab(t: CaptureTarget, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + CAPTURE_LIMITS.captureGapMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    checkAbort(signal);
    await assertVisible(t);
    lastCaptureAt = Date.now();
    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
    } catch (err) {
      // 브라우저 오류 문구는 모델에 싣지 않고 디버그 콘솔에만 남긴다. 한 번 더 해 보고(호출 한도 등) 안 되면 알린다.
      console.warn("[capture_page] captureVisibleTab failed", err);
      if (attempt >= 1) {
        throw new Error("브라우저가 이 탭의 화면 캡처를 허용하지 않았습니다(보호된 페이지이거나 파일 주소 접근이 꺼져 있을 수 있음).");
      }
      await sleep(1_000, signal);
      continue;
    }
    await assertVisible(t);
    return dataUrl;
  }
}

function dataUrlPngSize(dataUrl: string): { width: number; height: number } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  try {
    const head = atob(dataUrl.slice(comma + 1, comma + 1 + 44));
    return pngSize(Uint8Array.from(head, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

export interface CapturedImage {
  ok: boolean;
  savedAs?: string;
  reason?: string;
  note?: string;
  width: number;
  height: number;
  bytes?: number;
}

export interface CaptureResult {
  mode: "visible" | "fullPage";
  savedCount: number;
  images: CapturedImage[];
  location: string;
  // 전체 캡처: 담은 높이와 페이지 높이(CSS px), 배율(devicePixelRatio), 화면 장수, 잘림 여부.
  capturedHeight?: number;
  pageHeight?: number;
  scale?: number;
  screens?: number;
  truncated?: boolean;
  notes: string[];
  // 이미지는 이 기기에만 저장하고 모델 제공자로 보내지 않는다.
  sentToModel: false;
}

function toImages(res: DownloadRunResult, sizes: Array<{ width: number; height: number }>): CapturedImage[] {
  return res.results.map((r, i) => ({
    ok: r.ok,
    ...(r.savedAs ? { savedAs: r.savedAs } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.note ? { note: r.note } : {}),
    width: sizes[i]?.width ?? 0,
    height: sizes[i]?.height ?? 0,
    ...(r.bytes ? { bytes: r.bytes } : {}),
  }));
}

export async function captureVisible(
  turnTab: TurnTab,
  folder: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const t = await captureTarget(turnTab);
  const dataUrl = await grab(t, signal);
  checkAbort(signal);
  const size = dataUrlPngSize(dataUrl) ?? { width: 0, height: 0 };
  const name = captureFileName(t.url, new Date(), { fullPage: false });
  const res = await runDownloads("image", [{ url: "capture:1", label: "보이는 화면", source: dataUrl, name }], folder, signal);
  return {
    mode: "visible",
    savedCount: res.savedCount,
    images: toImages(res, [size]),
    location: `브라우저 다운로드 폴더 아래 '${res.folder}/'`,
    notes: [],
    sentToModel: false,
  };
}

async function step<T>(t: CaptureTarget, msg: BgToContent, timeoutMs: number): Promise<T> {
  try {
    return await queryContent<T>(t.tabId, msg, timeoutMs, "캡처 단계");
  } catch (err) {
    console.warn("[capture_page] step failed", err);
    if (isMissingReceiver(err)) throw new Error("캡처하는 동안 페이지가 바뀌어 멈췄습니다.");
    throw new Error("페이지가 캡처 단계에 응답하지 않아 멈췄습니다.");
  }
}

export async function captureFullPage(
  turnTab: TurnTab,
  callId: string,
  folder: string,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const t = await captureTarget(turnTab);
  let m: CaptureMetrics;
  try {
    m = await callContentTool<CaptureMetrics>("capture_page", { fullPage: true }, callId, turnTab);
  } catch (err) {
    console.warn("[capture_page] begin failed", err);
    throw new Error("이 페이지에는 확장 스크립트를 넣을 수 없어 페이지 전체를 캡처할 수 없습니다(보이는 화면 캡처는 될 수 있음).");
  }
  if (m.pdf) {
    throw new Error("PDF 뷰어는 스크롤해 전체를 캡처할 수 없습니다. 보이는 화면 캡처(fullPage 없이)만 할 수 있습니다.");
  }
  const notes: string[] = [];
  const tiles: Array<{ y: number; blob: Blob }> = [];
  const vh = m.viewportHeight;
  let pageHeight = m.pageHeight;
  let covered = 0;
  let stalled = false;
  let tooMany = false;
  let hidden = 0;
  try {
    for (;;) {
      checkAbort(signal);
      const target = tiles.length === 0 ? 0 : nextTileY({ coveredBottom: covered, pageHeight, viewportHeight: vh });
      if (target === null) break;
      if (tiles.length >= CAPTURE_LIMITS.maxTiles) {
        tooMany = true;
        break;
      }
      const at = await step<CaptureScrolled>(t, { kind: "capture_step", token: m.token, step: "scroll", y: target }, 8_000);
      pageHeight = at.pageHeight;
      // 페이지가 더 내려가지 않으면(스크롤을 막거나 높이가 줄어듦) 여기까지 담는다.
      if (tiles.length > 0 && at.y + vh <= covered) {
        stalled = true;
        break;
      }
      // 고정 요소는 첫 화면에만 담는다(그 뒤 화면에서는 숨김 — 스크롤하며 새로 고정된 것도).
      if (tiles.length > 0) hidden += await step<number>(t, { kind: "capture_step", token: m.token, step: "hide_fixed" }, 5_000);
      const dataUrl = await grab(t, signal);
      const blob = await (await fetch(dataUrl)).blob();
      tiles.push({ y: at.y, blob });
      covered = Math.max(covered, at.y + vh);
    }
  } finally {
    // 오류·중단에도 원래 스크롤 위치와 스타일로 되돌린다(문서가 바뀌었으면 되돌릴 것이 없다).
    await queryContent(t.tabId, { kind: "capture_step", token: m.token, step: "end" }, 3_000, "캡처 복원").catch(() => undefined);
  }
  checkAbort(signal);
  // 배율이 소수(1.5 등)면 스크롤 위치가 장치 px에 맞춰져 끝에서 1px 안쪽에 멈출 수 있다. 그만큼은 끝까지 담은 것으로 본다.
  const reached = covered >= pageHeight - 1 ? pageHeight : covered;
  const capturedHeight = Math.round(Math.min(reached, CAPTURE_LIMITS.maxPageHeight));
  const truncated = pageHeight > capturedHeight + 1;
  if (truncated) {
    notes.push(
      capturedHeight >= CAPTURE_LIMITS.maxPageHeight
        ? `페이지가 높이 상한(${CAPTURE_LIMITS.maxPageHeight.toLocaleString("en-US")}px)보다 길어 위에서부터 상한까지만 담았습니다(무한 스크롤 페이지일 수 있음).`
        : stalled
          ? "페이지가 더 스크롤되지 않아 거기까지만 담았습니다."
          : tooMany
            ? `화면 ${CAPTURE_LIMITS.maxTiles}장까지만 찍어 거기까지만 담았습니다.`
            : "페이지가 캡처하는 동안 길어져 끝까지 담지 못했습니다.",
    );
  }
  if (m.innerScroll) {
    notes.push("문서가 아니라 페이지 안쪽 영역이 스크롤되는 페이지라 보이는 화면만큼만 담겼습니다(안쪽 스크롤 영역 캡처는 아직 지원하지 않음).");
  }
  if (m.pageWidth > m.viewportWidth + 1) notes.push("가로로 넓은 페이지라 왼쪽부터 화면 폭만 담았습니다.");
  if (hidden > 0) notes.push("고정 요소(머리글·떠 있는 버튼 등)는 첫 화면에만 담았습니다.");
  const plan = planStitch({
    tiles: tiles.map((x) => x.y),
    viewportWidth: m.viewportWidth,
    viewportHeight: vh,
    totalHeight: capturedHeight,
    scale: m.scale,
  });
  if (!plan) throw new Error("페이지 폭이 너무 넓어 이어 붙인 이미지를 만들 수 없습니다.");
  const job: StitchJob = {
    kind: "capture_stitch",
    tiles: tiles.map((x) => x.blob),
    plan,
    viewportWidth: m.viewportWidth,
    windowWidth: m.windowWidth,
  };
  const stitched = await runOffscreenJob<StitchResult>(job, [], {
    signal,
    guardMs: 60_000,
    cancelled: { ok: false, kind: "cancelled" },
    timedOut: { ok: false, kind: "timeout" },
    closed: { ok: false, kind: "closed" },
  });
  if (!stitched.ok) {
    if (stitched.kind === "cancelled") throw new Error("중단되어 캡처를 멈췄습니다.");
    throw new Error("찍은 화면을 이어 붙이지 못했습니다(이미지가 너무 크거나 메모리가 부족할 수 있음).");
  }
  if (stitched.parts.length > 1) notes.push(`이미지가 너무 길어 ${stitched.parts.length}장으로 나눠 저장했습니다.`);
  const at = new Date();
  const n = stitched.parts.length;
  let res: DownloadRunResult;
  try {
    res = await runDownloads(
      "image",
      stitched.parts.map((p, i) => ({
        url: `capture:${i + 1}`,
        label: n > 1 ? `페이지 전체 ${i + 1}/${n}` : "페이지 전체",
        source: p.url,
        name: captureFileName(t.url, at, { fullPage: true, part: i + 1, parts: n }),
      })),
      folder,
      signal,
    );
  } finally {
    const release: StitchReleaseJob = { kind: "capture_release", urls: stitched.parts.map((p) => p.url) };
    void runOffscreenJob(release, [], { guardMs: 10_000, cancelled: null, timedOut: null, closed: null }).catch(() => undefined);
  }
  return {
    mode: "fullPage",
    savedCount: res.savedCount,
    images: toImages(res, stitched.parts),
    location: `브라우저 다운로드 폴더 아래 '${res.folder}/'`,
    capturedHeight,
    pageHeight,
    scale: m.scale,
    screens: tiles.length,
    truncated,
    notes,
    sentToModel: false,
  };
}
