import {
  CAPTURE_LIMITS,
  captureBlockReason,
  captureFileName,
  nextTileY,
  planStitch,
  pngSize,
  scrollMoved,
  tileLeavesGap,
  tileSizeMatches,
  viewportChanged,
  type CaptureMetrics,
  type CaptureScrolled,
  type CaptureMeasured,
  type StitchJob,
  type StitchReleaseJob,
  type StitchResult,
} from "@/lib/pageCapture";
import type { BgToContent, ContentResponse } from "@/lib/messages";
import { withTimeout } from "@/lib/async";
import { waitForNavigationSettle } from "../navigation";
import { runOffscreenJob } from "../offscreen";
import { callContentTool, isMissingReceiver, resolveTurnTab, type TurnTab } from "./handlers";
import { runDownloads, type DownloadRunResult } from "./downloads";

// 보고 있는 페이지 캡처(capture_page, #49). 보이는 화면은 chrome.tabs.captureVisibleTab 한 번, 전체 페이지는
// 맨 위부터 화면 높이씩 스크롤하며 찍어 offscreen 문서의 캔버스로 이어 붙인다(chrome.debugger는 쓰지 않는다).
// 결과는 chrome.downloads로 PNG 저장만 한다 — 이미지를 모델에 보내지 않는다. 모델로 가는 결과에는 고정 문구,
// 확장이 정한 이름(사이트·시각), 크기 숫자만 싣는다.

// 승인 카드에 보인 캡처 대상: 탭·주소·최상위 문서(documentId). 실행은 이것과 같은 문서일 때만 찍는다.
export interface CaptureTarget {
  tabId: number;
  windowId: number;
  url: string;
  documentId: string;
}

async function topDocumentId(tabId: number): Promise<string | null> {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return frame?.documentId ?? null;
  } catch {
    return null;
  }
}

// 캡처할 수 있는 탭인지(주소 형태)와 지금 그 창에서 보이는 탭인지 확인한다. captureVisibleTab은 창의 활성 탭을
// 찍으므로, 턴 탭이 앞에 있지 않으면 다른 탭을 찍지 않게 멈춘다. approved(카드에서 승인한 대상)가 있으면 지금 탭의
// 문서가 그것과 같을 때만 돌려준다(카드가 열린 사이 다른 페이지로 이동했으면 찍지 않는다).
export async function captureTarget(turnTab: TurnTab, approved?: CaptureTarget): Promise<CaptureTarget> {
  const tabId = await resolveTurnTab(turnTab, { allowInternal: true });
  await waitForNavigationSettle(tabId, 10_000);
  const tab = await chrome.tabs.get(tabId);
  const why = captureBlockReason(tab.url);
  if (why) throw new Error(`캡처하지 않았습니다: ${why}.`);
  const documentId = await topDocumentId(tabId);
  if (!documentId) throw new Error("캡처하지 않았습니다: 탭의 문서를 확인할 수 없음.");
  const target = { tabId, windowId: tab.windowId, url: tab.url ?? "", documentId };
  if (approved && (approved.tabId !== target.tabId || approved.url !== target.url || approved.documentId !== target.documentId)) {
    throw new Error("승인한 뒤 탭의 페이지가 바뀌어 캡처하지 않았습니다. 다시 요청하세요.");
  }
  if (approved && approved.windowId !== target.windowId) {
    throw new Error("승인한 뒤 탭이 다른 창으로 옮겨져 캡처하지 않았습니다. 다시 요청하세요.");
  }
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
  if (tab.url !== t.url || (await topDocumentId(t.tabId)) !== t.documentId) {
    throw new Error("캡처하는 동안 탭의 페이지가 바뀌어 멈췄습니다.");
  }
  // captureVisibleTab은 창 id로 그 창의 활성 탭을 찍는다. 탭이 고정한 창에 그대로 있고 그 창의 활성 탭일 때만 찍는다.
  if (tab.windowId !== t.windowId) throw new Error(MOVED);
  const [active] = await chrome.tabs.query({ windowId: t.windowId, active: true }).catch(() => []);
  if (!tab.active || active?.id !== t.tabId) {
    throw new Error("캡처할 탭이 그 창의 앞에 보이는 탭이 아니라 캡처하지 않았습니다. 그 탭을 앞으로 띄운 뒤 다시 요청하세요.");
  }
  const win = await chrome.windows.get(t.windowId).catch(() => null);
  if (!win || win.state === "minimized") throw new Error("창이 최소화되어 있어 캡처하지 않았습니다.");
}

const MOVED = "캡처하는 동안 탭이 다른 창으로 옮겨져 멈췄습니다(저장하지 않음).";

// 찍기 전 확인부터 찍은 뒤 확인까지 그 창의 활성 탭·탭의 창·탭의 문서가 한 번이라도 바뀌었는지 이벤트로 지켜본다.
// 앞뒤 확인만으로는 찍는 순간 잠깐 다른 탭이 앞에 왔다가 돌아온 경우를 알 수 없다(창 포커스는 찍는 대상과 무관하다).
function watchDisturbance(t: CaptureTarget): { disturbed(): boolean; stop(): void } {
  let hit = false;
  const onActivated = (info: chrome.tabs.TabActiveInfo) => {
    if (info.windowId === t.windowId || info.tabId === t.tabId) hit = true;
  };
  const onTabMoved = (tabId: number) => {
    if (tabId === t.tabId) hit = true;
  };
  const onRemoved = (tabId: number) => {
    if (tabId === t.tabId) hit = true;
  };
  const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    if (d.tabId === t.tabId && d.frameId === 0) hit = true;
  };
  chrome.tabs.onActivated.addListener(onActivated);
  chrome.tabs.onDetached.addListener(onTabMoved);
  chrome.tabs.onAttached.addListener(onTabMoved);
  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.webNavigation.onCommitted.addListener(onCommitted);
  return {
    disturbed: () => hit,
    stop: () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onDetached.removeListener(onTabMoved);
      chrome.tabs.onAttached.removeListener(onTabMoved);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
    },
  };
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

const CAPTURE_CALL_TIMEOUT_MS = 10_000;

// 지금 보이는 화면 한 장(PNG data: 주소). 앞뒤로 그 탭이 보이는 탭인지 확인한다(찍는 사이 다른 탭으로 바뀌면 버린다).
async function grab(t: CaptureTarget, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + CAPTURE_LIMITS.captureGapMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    checkAbort(signal);
    const watch = watchDisturbance(t);
    try {
      await assertVisible(t);
      lastCaptureAt = Date.now();
      let dataUrl: string | null = null;
      try {
        // 고정한 창 id로만 찍는다.
        // 브라우저가 응답하지 않아도 무기한 기다리지 않는다(시간 제한·중단).
        dataUrl = await bounded(chrome.tabs.captureVisibleTab(t.windowId, { format: "png" }), CAPTURE_CALL_TIMEOUT_MS, signal);
      } catch (err) {
        checkAbort(signal);
        // 브라우저 오류 문구는 모델에 싣지 않고 디버그 콘솔에만 남긴다. 한 번 더 해 보고(호출 한도 등) 안 되면 알린다.
        console.warn("[capture_page] captureVisibleTab failed", err);
        if (attempt >= 1) {
          throw new Error("브라우저가 이 탭의 화면 캡처를 허용하지 않았습니다(보호된 페이지이거나 파일 주소 접근이 꺼져 있을 수 있음).");
        }
      }
      if (dataUrl !== null) {
        await assertVisible(t);
        if (watch.disturbed()) throw new Error("캡처하는 순간 그 창의 탭이 바뀌어 멈췄습니다(저장하지 않음).");
        return dataUrl;
      }
    } finally {
      watch.stop();
    }
    await sleep(1_000, signal);
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
  approved: CaptureTarget,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const t = await captureTarget(turnTab, approved);
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

// 시간 제한과 중단 신호를 함께 거는 기다림(페이지가 응답하지 않아도 도구가 무기한 붙잡히지 않게).
function bounded<T>(p: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return withTimeout(p, timeoutMs, "timeout", { signal, abortMessage: "중단되어 캡처를 멈췄습니다." });
}

// 승인한 그 문서(documentId)에만 보낸다. 문서가 바뀌었으면 받는 쪽이 없어 실패한다.
async function sendToDoc<T>(t: CaptureTarget, msg: BgToContent, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const res = await bounded(
    chrome.tabs.sendMessage(t.tabId, msg, { documentId: t.documentId }) as Promise<ContentResponse<T>>,
    timeoutMs,
    signal,
  );
  if (!res?.ok) throw new Error(res?.error ?? "failed");
  return res.data as T;
}

async function step<T>(t: CaptureTarget, msg: BgToContent, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  try {
    return await sendToDoc<T>(t, msg, timeoutMs, signal);
  } catch (err) {
    console.warn("[capture_page] step failed", err);
    checkAbort(signal);
    if (isMissingReceiver(err)) throw new Error("캡처하는 동안 페이지가 바뀌어 멈췄습니다.");
    throw new Error("페이지가 캡처 단계에 응답하지 않아 멈췄습니다.");
  }
}

// 복원 시간 제한. 지나면 페이지 쪽 자가 복원(마지막 단계 뒤 15초)에 맡긴다.
const RESTORE_TIMEOUT_MS = 2_000;
const RESTORE_LATE = "페이지가 복원 요청에 바로 응답하지 않아, 스크롤 위치와 잠시 바꾼 모습은 약 15초 안에 페이지가 스스로 되돌립니다.";

// 원래 스크롤 위치와 스타일로 되돌린다. 승인한 문서에 보내고, 시작 단계가 그 사이 바뀐 다른 문서에서 열렸을 수도 있어
// 지금 최상위 문서에도 보낸다(같은 세션 값을 가진 쪽만 되돌린다). 둘 다 시간 안에 응답하지 않으면 false.
async function restorePage(t: CaptureTarget, token: string): Promise<boolean> {
  const end: BgToContent = { kind: "capture_step", token, step: "end" };
  const answered = await Promise.all([
    sendToDoc(t, end, RESTORE_TIMEOUT_MS).then(
      () => true,
      (err: unknown) => isMissingReceiver(err),
    ),
    bounded(chrome.tabs.sendMessage(t.tabId, end, { frameId: 0 }), RESTORE_TIMEOUT_MS).then(
      () => true,
      (err: unknown) => isMissingReceiver(err),
    ),
  ]);
  // 받는 쪽이 없으면(문서가 사라짐) 되돌릴 것도 없다. 둘 다 시간 초과일 때만 늦은 것으로 본다.
  return answered.some(Boolean);
}

const SCROLLED = "캡처하는 동안 페이지의 스크롤 위치가 바뀌어 멈췄습니다(저장하지 않음). 캡처가 끝날 때까지 스크롤하지 말고 다시 요청하세요.";
const RESIZED = "캡처하는 동안 창 크기나 화면 배율이 바뀌어 멈췄습니다(저장하지 않음). 창 크기를 그대로 둔 채 다시 요청하세요.";

export async function captureFullPage(
  turnTab: TurnTab,
  callId: string,
  folder: string,
  approved: CaptureTarget,
  signal?: AbortSignal,
): Promise<CaptureResult> {
  const t = await captureTarget(turnTab, approved);
  // 세션 값은 여기서 만든다(페이지가 비보안 컨텍스트여도 되고, 시작 응답을 받지 못해도 이 값으로 복원을 보낸다).
  const token = crypto.randomUUID();
  const notes: string[] = [];
  const tiles: Array<{ y: number; blob: Blob }> = [];
  let m: CaptureMetrics | null = null;
  let vh = 0;
  let pageHeight = 0;
  let covered = 0;
  let stalled = false;
  let tooMany = false;
  let hidden = 0;
  let failure: unknown = null;
  // 시작 단계가 세션을 열고 스타일을 바꾸는 순간부터 복원 범위에 넣는다(아래 확인이 실패해도 바로 되돌린다).
  // 시작 호출은 중단·시간 초과로 기다림을 그만둬도 계속 진행돼(주입·재시도 대기) 복원 뒤에 늦게 세션을 열 수 있다(#65).
  // 끝났는지 기억해 두고, 복원할 때까지 끝나지 않았으면 끝난 뒤 같은 세션 값으로 한 번 더 되돌린다.
  let beginSettled = false;
  const begin = callContentTool<CaptureMetrics>("capture_page", { fullPage: true, token }, callId, turnTab);
  begin.then(
    () => {
      beginSettled = true;
    },
    () => {
      beginSettled = true;
    },
  );
  try {
    try {
      m = await bounded(begin, 20_000, signal);
    } catch (err) {
      console.warn("[capture_page] begin failed", err);
      checkAbort(signal);
      throw new Error("이 페이지에는 확장 스크립트를 넣을 수 없어 페이지 전체를 캡처할 수 없습니다(보이는 화면 캡처는 될 수 있음).");
    }
    vh = m.viewportHeight;
    pageHeight = m.pageHeight;
    // 시작 단계가 승인한 그 문서에서 열렸는지.
    await assertVisible(t);
    if (m.pdf) {
      throw new Error("PDF 뷰어는 스크롤해 전체를 캡처할 수 없습니다. 보이는 화면 캡처(fullPage 없이)만 할 수 있습니다.");
    }
    for (;;) {
      checkAbort(signal);
      const target = tiles.length === 0 ? 0 : nextTileY({ coveredBottom: covered, pageHeight, viewportHeight: vh });
      if (target === null) break;
      if (tiles.length >= CAPTURE_LIMITS.maxTiles) {
        tooMany = true;
        break;
      }
      const at = await step<CaptureScrolled>(t, { kind: "capture_step", token, step: "scroll", y: target }, 8_000, signal);
      pageHeight = at.pageHeight;
      // 창 크기·배율이 바뀌면 화면마다 크기가 달라 이어 붙인 이미지가 어긋난다. 그때까지만 저장하지 않고 멈춘다
      // (잘린 이미지를 성공으로 남기기보다, 창을 그대로 두고 다시 요청하게 한다).
      if (viewportChanged(m, at)) throw new Error(RESIZED);
      // 페이지가 더 내려가지 않으면(스크롤을 막거나 높이가 줄어듦) 여기까지 담는다.
      if (tiles.length > 0 && at.y + vh <= covered) {
        stalled = true;
        break;
      }
      // 기다리는 사이 페이지가 스스로 아래로 건너뛰었으면(첫 화면이 맨 위가 아니거나 앞 화면과 빈 구간) 멈춘다.
      if (tileLeavesGap({ y: at.y, first: tiles.length === 0, coveredBottom: covered })) throw new Error(SCROLLED);
      // 고정 요소는 첫 화면에만 담는다(그 뒤 화면에서는 숨김 — 스크롤하며 새로 고정된 것도).
      if (tiles.length > 0) hidden += await step<number>(t, { kind: "capture_step", token, step: "hide_fixed" }, 5_000, signal);
      const dataUrl = await grab(t, signal);
      const size = dataUrlPngSize(dataUrl);
      if (!size || !tileSizeMatches(size, m)) throw new Error(RESIZED);
      // 찍은 뒤에도 다시 재어 찍기 전(시작) 값과 같은지, 스크롤해 둔 위치 그대로인지 본다.
      const after = await step<CaptureMeasured>(t, { kind: "capture_step", token, step: "measure" }, 3_000, signal);
      if (viewportChanged(m, after)) throw new Error(RESIZED);
      // 고정 요소 숨김·호출 간격 대기 사이 사용자 스크롤·페이지 스크립트가 위치를 바꿨으면 그 장은 다른 자리를 찍은 것이다.
      // 다시 찍기보다 단순하게 멈추고 저장하지 않는다(같은 페이지가 계속 움직이면 다시 찍어도 같다).
      if (scrollMoved(at, after)) throw new Error(SCROLLED);
      const blob = await (await fetch(dataUrl)).blob();
      tiles.push({ y: at.y, blob });
      covered = Math.max(covered, at.y + vh);
    }
  } catch (err) {
    failure = err;
  }
  // 오류·중단에도 원래 스크롤 위치와 스타일로 되돌린다(시간 제한 안에서 — 응답이 없으면 페이지의 자가 복원에 맡긴다).
  // 복원을 보내기 전에 시작이 끝났는지 본다. 아직이면(복원 응답을 기다리는 사이 끝나 늦게 세션을 열 수 있음) 끝난 뒤
  // 한 번 더 되돌린다. 같은 세션 값을 가진 쪽만 되돌리므로 그 사이 새 캡처가 시작됐어도 그 세션은 건드리지 않는다.
  const beginDoneBeforeRestore = beginSettled;
  const restored = await restorePage(t, token);
  if (!beginDoneBeforeRestore) {
    void begin.then(
      () => restorePage(t, token),
      () => {},
    );
  }
  if (failure) {
    if (!restored && failure instanceof Error) throw new Error(`${failure.message} ${RESTORE_LATE}`);
    throw failure;
  }
  if (!restored) notes.push(RESTORE_LATE);
  checkAbort(signal);
  if (!m) throw new Error("이 페이지에는 확장 스크립트를 넣을 수 없어 페이지 전체를 캡처할 수 없습니다(보이는 화면 캡처는 될 수 있음).");
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
