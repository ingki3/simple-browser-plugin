import type { BgToContent, ContentResponse, ToolName } from "@/lib/messages";
import { navigationError, waitForNavigationSettle } from "../navigation";
import { describeNavigationError } from "@/lib/navError";
import { debugLog, timeSpan } from "../debug";
import { isBrowserInternalUrl } from "@/lib/siteTrust";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS: Partial<Record<ToolName, number>> = {
  translate_page: 180_000,
  download_images: 60_000,
  download_files: 60_000,
  // capture_page의 시작 단계(문서 재기 — 큰 문서는 요소를 훑는 데 시간이 걸린다).
  capture_page: 15_000,
};

export const INTERNAL_PAGE_ERROR =
  "브라우저 내부 페이지(새 탭·설정 등)라 페이지를 읽거나 조작할 수 없습니다. navigate_to_url로 웹 페이지로 먼저 이동하세요.";

// 턴을 시작한 순간의 탭. 모델이 생각하는 동안 사용자가 다른 탭(예: 메일)으로 옮겨도
// 도구가 그 탭을 건드리지 않도록 턴 내내 이 탭에만 작업한다.
// 새 탭·설정 같은 내부 페이지여도 탭을 잡아 두고(internal), 그 탭에서 웹 주소로의 이동만 허용한다(#54).
// popups: 우리 클릭으로 이 탭(또는 따라간 팝업)이 연 팝업 창(창 종류 popup)을 연 순서대로 쌓은 것. 비어 있지 않으면
// 도구는 맨 위 팝업 창에서 동작하고, 그 창이 닫히면 아래(결국 원래 탭)로 돌아간다. tabId는 늘 원래 탭이다.
// originDocumentId: 첫 팝업을 따라가기 시작할 때 원래 탭의 최상위 문서. 다음 턴은 원래 탭이 아직 이 문서일 때만
// 팝업을 이어 따라간다(사용자가 원래 탭을 다른 페이지로 옮겼으면 새 페이지에서 시작한다, #72).
// tabNote: 팝업이 닫혀 돌아간 것처럼 다음 도구 결과에 붙여 모델에 알릴 문구(한 번 읽으면 지운다).
// kind "tab": 팝업을 요청한 window.open이 브라우저 사정(macOS 전체 화면 등)으로 일반 창의 탭으로 열린 것. 브라우저가
// 그 탭을 앞에 띄웠을 때만 따라가고, 도구를 실행할 때마다 그 탭이 아직 그 창의 앞에 보이는지 확인한다(아니면 멈춘다).
// documentId는 따라가기 시작할 때의 문서 — 첫 도구 전에 문서가 바뀌었으면 쓰지 않는다(checked가 되면 그 뒤로는 탭 안 이동 허용).
export interface FollowedPopup {
  tabId: number;
  windowId: number;
  kind?: "tab";
  documentId?: string;
  checked?: boolean;
}
export type TurnTab =
  | { tabId: number; internal: boolean; popups?: FollowedPopup[]; originDocumentId?: string; tabNote?: string }
  | { error: string };

// 따라가는 팝업 창 깊이 한도(팝업이 또 팝업을 여는 경우).
export const MAX_FOLLOWED_POPUPS = 3;

export async function captureTurnTab(): Promise<TurnTab> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { error: "활성 탭을 찾을 수 없습니다." };
    return { tabId: tab.id, internal: isBrowserInternalUrl(tab.url) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// 탭의 최상위 문서 id. 못 읽으면 null.
export async function topDocumentId(tabId: number): Promise<string | null> {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return frame?.documentId ?? null;
  } catch {
    return null;
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

// 닫힌 팝업 창을 맨 위부터 걷어 낸다. 걷어 냈으면 돌아간 곳을 다음 도구 결과에 붙일 문구로 남기고 그 곳을 돌려준다.
export async function pruneClosedPopups(turnTab: TurnTab): Promise<"original" | "popup" | null> {
  if ("error" in turnTab || !turnTab.popups?.length) return null;
  let closed = false;
  while (turnTab.popups.length && !(await tabExists(turnTab.popups[turnTab.popups.length - 1].tabId))) {
    turnTab.popups.pop();
    closed = true;
  }
  if (!closed) return null;
  const back = turnTab.popups.length ? "popup" : "original";
  if (back === "original") turnTab.originDocumentId = undefined;
  turnTab.tabNote =
    back === "original"
      ? "팝업 창이 닫혀 원래 탭으로 돌아왔습니다. 이제 도구는 원래 탭에서 동작합니다(팝업에서 찾은 id는 쓸 수 없으니 다시 찾으세요)."
      : "팝업 창이 닫혀 그 창을 연 팝업 창으로 돌아왔습니다(닫힌 창에서 찾은 id는 쓸 수 없으니 다시 찾으세요).";
  return back;
}

// 지금 도구가 동작할 탭. 따라가는 팝업 창이 살아 있으면 그 창, 아니면 원래 탭. asTab: 탭으로 열린 팝업.
export async function currentToolTab(
  turnTab: TurnTab,
): Promise<{ tabId: number; popup: boolean; asTab?: boolean } | null> {
  if ("error" in turnTab) return null;
  await pruneClosedPopups(turnTab);
  const top = turnTab.popups?.[turnTab.popups.length - 1];
  return top ? { tabId: top.tabId, popup: true, ...(top.kind === "tab" ? { asTab: true } : {}) } : { tabId: turnTab.tabId, popup: false };
}

// 따라가는 팝업 중에 탭으로 열린 것이 있는지(동기, 상태만 본다). 있으면 원래 탭은 그 탭 뒤에 가려 있다
// (O → 탭 팝업 A → 팝업 창 B처럼 맨 위가 창이어도 A가 원래 탭을 가린다).
export function followingTabPopup(turnTab: TurnTab): boolean {
  return "tabId" in turnTab && !!turnTab.popups?.some((p) => p.kind === "tab");
}

export const TAB_POPUP_HIDDEN_ERROR =
  "팝업으로 열린 탭이 지금 화면 앞에 있지 않아(사용자가 다른 탭·창으로 옮겼거나 창을 내림) 작업하지 않았습니다. 사용자에게 그 탭을 다시 앞에 띄워 달라고 하거나, 그 탭을 닫으면 원래 탭에서 이어 간다고 안내하세요.";
const TAB_POPUP_CHANGED_ERROR =
  "팝업으로 열린 탭이 따라가기 시작한 뒤 다른 문서로 바뀌어 작업하지 않았습니다. 사용자에게 그 탭을 닫고 다시 시도해 달라고 안내하세요.";

// 탭으로 열린 팝업에서 도구를 실행해도 되는지: 그 탭이 따라가기 시작한 창에 있고 그 창의 활성 탭이며 창이 내려가
// 있지 않아야 한다. 첫 도구 전에는 문서도 따라가기 시작할 때와 같아야 한다. 아니면 오류(따라가기는 그대로 둔다 —
// 사용자가 다시 앞에 띄우면 이어 간다). 확인한 지금 문서 id를 돌려준다(보낼 메시지를 그 문서에 고정).
// 확인만 하고 checked는 바꾸지 않는다 — 메시지를 실제로 그 문서에 보낸 뒤 markTabPopupUsed가 표시한다.
async function assertTabPopupVisible(top: FollowedPopup, tab: chrome.tabs.Tab): Promise<string> {
  if (!tab.active || tab.windowId !== top.windowId) throw new Error(TAB_POPUP_HIDDEN_ERROR);
  let win: chrome.windows.Window;
  try {
    win = await chrome.windows.get(tab.windowId);
  } catch {
    throw new Error(TAB_POPUP_HIDDEN_ERROR);
  }
  if (win.state === "minimized") throw new Error(TAB_POPUP_HIDDEN_ERROR);
  // 사용자가 다른 Chrome 창으로 옮겼으면 그 창의 탭은 계속 활성이어도 보고 있지 않다. 마지막으로 포커스를 받은 Chrome
  // 창이 이 창이어야 한다(Chrome 밖의 다른 앱으로 잠깐 옮긴 것은 막지 않는다 — 원래 탭 작업과 같게).
  let lastFocused: chrome.windows.Window | null = null;
  try {
    lastFocused = await chrome.windows.getLastFocused();
  } catch {
    lastFocused = null;
  }
  if (!lastFocused || lastFocused.id !== tab.windowId) throw new Error(TAB_POPUP_HIDDEN_ERROR);
  const doc = await topDocumentId(tab.id as number);
  if (!doc) throw new Error(TAB_POPUP_HIDDEN_ERROR);
  if (!top.checked && doc !== top.documentId) throw new Error(TAB_POPUP_CHANGED_ERROR);
  return doc;
}

// 내용 스크립트에 보내기 직전(탐색 대기·주입 재시도 뒤 포함)에 부른다. tabId가 지금 따라가는 탭 팝업이면 가시성·문서를
// 다시 확인하고 그 문서 id를 돌려준다(보낼 메시지를 그 문서에 고정). 탭 팝업이 아니면 null(고정 없음).
export async function recheckTabPopup(turnTab: TurnTab, tabId: number): Promise<string | null> {
  if ("error" in turnTab) return null;
  const top = turnTab.popups?.[turnTab.popups.length - 1];
  if (!top || top.kind !== "tab" || top.tabId !== tabId) return null;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await pruneClosedPopups(turnTab);
    throw new Error("따라가던 팝업 창이 방금 닫혔습니다. 다시 관측하세요.");
  }
  return assertTabPopupVisible(top, tab);
}

// 탭 팝업의 확인한 문서에 첫 메시지를 보냈다(그 뒤로는 탭 안 이동을 허용 — 달력의 다음 달 등).
function markTabPopupUsed(turnTab: TurnTab, tabId: number): void {
  if ("error" in turnTab) return;
  const top = turnTab.popups?.[turnTab.popups.length - 1];
  if (top && top.kind === "tab" && top.tabId === tabId) top.checked = true;
}

// 지금 팝업 창을 따라가는 중인지(동기, 상태만 본다 — 닫혔는지는 currentToolTab이 확인한다).
export function followingPopup(turnTab: TurnTab): boolean {
  return "tabId" in turnTab && !!turnTab.popups?.length;
}

// 원래 탭마다 우리 클릭으로 열려 따라간 적 있는 팝업 창(탭 id). 따라가기를 끝낸 뒤(navigate_to_url 등)에도 열린 채
// 남은 창을 페이지가 같은 이름으로 다시 쓰면(window.open(url, "calendar")) 새 탭 없이 그 창이 이동하므로, 그 창을
// 이 탭의 팝업으로 알아보는 데 쓴다. 닫힌 탭은 알아볼 때 지운다.
const knownPopupTabs = new Map<number, Set<number>>();

export function isKnownPopup(turnTab: TurnTab, tabId: number): boolean {
  if ("error" in turnTab) return false;
  return knownPopupTabs.get(turnTab.tabId)?.has(tabId) ?? false;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  knownPopupTabs.delete(tabId);
  for (const set of knownPopupTabs.values()) set.delete(tabId);
});

// 우리 클릭으로 열린 팝업 창을 따라간다. 따라갔으면 true(한도를 넘으면 false).
// 첫 팝업이면 원래 탭의 지금 문서를 originDocumentId로 남긴다(못 읽으면 비워 두어 다음 턴이 잇지 않는다).
export async function followPopup(turnTab: TurnTab, popup: FollowedPopup): Promise<boolean> {
  if ("error" in turnTab) return false;
  const stack = (turnTab.popups ??= []);
  if (stack.length >= MAX_FOLLOWED_POPUPS || stack.some((p) => p.tabId === popup.tabId)) return false;
  const first = stack.length === 0;
  stack.push(popup);
  let known = knownPopupTabs.get(turnTab.tabId);
  if (!known) knownPopupTabs.set(turnTab.tabId, (known = new Set()));
  known.add(popup.tabId);
  if (first) {
    turnTab.originDocumentId = undefined;
    const doc = await topDocumentId(turnTab.tabId);
    // 문서를 읽는 사이 따라가기가 끝나고 다시 시작됐으면(같은 스택 맨 아래가 이 창이 아니면) 덮어쓰지 않는다.
    if (doc && turnTab.popups?.[0] === popup) turnTab.originDocumentId = doc;
  }
  return true;
}

// 팝업 따라가기를 끝내고 원래 탭으로 돌아간다(원래 탭을 이동할 때). 따라가던 창이 있었으면 true.
export function stopFollowingPopups(turnTab: TurnTab): boolean {
  if ("error" in turnTab || !turnTab.popups?.length) return false;
  turnTab.popups = [];
  turnTab.originDocumentId = undefined;
  return true;
}

// 다음 도구 결과에 붙일 문구를 꺼낸다(한 번만).
export function takeTabNote(turnTab: TurnTab): string | null {
  if ("error" in turnTab || !turnTab.tabNote) return null;
  const note = turnTab.tabNote;
  turnTab.tabNote = undefined;
  return note;
}

// 같은 원래 탭으로 시작한 다음 턴이 앞 턴에서 따라가던(아직 열린) 팝업 창을 이어 따라간다. 사용자가 팝업을 보며
// "15일로 골라 줘"처럼 이어 요청하는 경우. 우리 클릭으로 열린 창만 목록에 있으므로 그 밖의 창으로 넓어지지 않는다.
// 원래 탭이 따라가기를 시작할 때의 문서가 아니면(사용자가 다른 페이지로 옮겼거나 새로 고침) 잇지 않는다 — 팝업 창은
// 그대로 두고 이번 턴은 원래 탭에서 시작한다(#72).
// 탭으로 열린 팝업이 스택에 있으면 사용자가 보고 있는 활성 탭이 그 탭(스택의 마지막 탭 팝업)일 때만 잇고, 원래 탭을
// 이 대화가 기록한 원래 탭으로 되돌린다(다음 턴은 활성 탭을 잡으므로). 원래 탭이나 다른 탭이 활성이면 잇지 않는다
// (보이지 않는 탭 팝업으로 조용히 따라가지 않음). 복원은 기록한 상태로만 하고 주소·opener로 추측하지 않는다.
export async function inheritPopups(prev: TurnTab, next: TurnTab): Promise<boolean> {
  if ("error" in prev || "error" in next || !prev.popups?.length) return false;
  const origin = prev.originDocumentId;
  if (!origin) return false;
  // 닫힌 창은 건너뛰고 살아 있는 창을 순서대로 남긴다(원래 탭 → A → B에서 A만 닫혀도 지금 턴처럼 B에서 이어 간다 —
  // pruneClosedPopups도 맨 위가 살아 있으면 그 창을 쓴다).
  const alive: FollowedPopup[] = [];
  for (const p of prev.popups) {
    if (await tabExists(p.tabId)) alive.push(p);
  }
  if (!alive.length) return false;
  // 닫힌 항목을 걷어 낸 뒤의 마지막 탭 팝업으로 본다(O → A → B에서 B가 닫혔으면 A가 앞에 있을 때 잇는다).
  const lastTabPopup = [...alive].reverse().find((p) => p.kind === "tab");
  if (lastTabPopup ? next.tabId !== lastTabPopup.tabId : next.tabId !== prev.tabId) return false;
  if ((await topDocumentId(prev.tabId)) !== origin) return false;
  if (lastTabPopup) {
    let internal = false;
    try {
      internal = isBrowserInternalUrl((await chrome.tabs.get(prev.tabId)).url);
    } catch {
      return false;
    }
    next.tabId = prev.tabId;
    next.internal = internal;
  }
  next.popups = alive;
  next.originDocumentId = origin;
  return true;
}

const POPUP_BLANK_ERROR =
  "팝업 창이 아직 페이지를 불러오지 않았거나(빈 창) 브라우저 내부 페이지라 읽거나 조작할 수 없습니다. 잠시 뒤 다시 관측하세요.";

// 도구가 동작할 탭의 id(팝업 창을 따라가는 중이면 그 창). 지금 내부 페이지면 allowInternal(웹 주소로의 이동)일 때만
// 돌려주고, 그 밖의 도구는 안내 오류를 낸다. originalTab이면 팝업과 관계없이 원래 탭(이동은 원래 탭에서만 한다).
export async function resolveTurnTab(
  turnTab: TurnTab,
  opts: { allowInternal?: boolean; originalTab?: boolean } = {},
): Promise<number> {
  if ("error" in turnTab) throw new Error(turnTab.error);
  const current = opts.originalTab ? { tabId: turnTab.tabId, popup: false } : await currentToolTab(turnTab);
  const tabId = current?.tabId ?? turnTab.tabId;
  const isPopup = !!current?.popup;
  const closedMsg = isPopup
    ? "따라가던 팝업 창이 방금 닫혔습니다. 다시 관측하세요."
    : "요청을 시작한 탭이 닫혀서 작업을 계속할 수 없습니다.";
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    if (isPopup) await pruneClosedPopups(turnTab);
    throw new Error(closedMsg);
  }
  if (!opts.allowInternal && isBrowserInternalUrl(tab.url)) {
    // 방금 내부 페이지에서 웹 주소로 이동을 시작했으면 탭 주소는 이동이 확정될 때까지 내부 페이지로 남는다.
    // 진행 중인 이동을 기다린 뒤 다시 본다. 막 열린 팝업 창(about:blank에서 시작)도 같다.
    await waitForNavigationSettle(tabId, 10_000);
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      if (isPopup) await pruneClosedPopups(turnTab);
      throw new Error(closedMsg);
    }
    if (isBrowserInternalUrl(tab.url)) throw new Error(isPopup ? POPUP_BLANK_ERROR : INTERNAL_PAGE_ERROR);
  }
  if (isPopup) {
    const top = turnTab.popups?.[turnTab.popups.length - 1];
    if (top?.tabId === tabId && top.kind === "tab") await assertTabPopupVisible(top, tab);
  }
  return tabId;
}

// 턴 탭이 지금 내부 페이지인지(턴 도중 이동했을 수 있어 매번 탭 주소를 본다). 탭을 못 읽으면 false.
export async function turnTabIsInternal(turnTab: TurnTab): Promise<boolean> {
  if ("error" in turnTab) return false;
  try {
    return isBrowserInternalUrl((await chrome.tabs.get(turnTab.tabId)).url);
  } catch {
    return false;
  }
}

function getContentScriptFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const entries = manifest.content_scripts ?? [];
  const files: string[] = [];
  for (const entry of entries) {
    for (const js of entry.js ?? []) files.push(js);
  }
  return files;
}

async function injectContentScript(tabId: number): Promise<void> {
  const files = getContentScriptFiles();
  if (!files.length) throw new Error("manifest에 content script가 선언되지 않았습니다.");
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files,
  });
}

// 확장을 다시 불러오기 전에 열려 있던 탭처럼 content script가 없는 문서 하나에만 주입한다. documentIds로 대상을 고정해
// 그 사이 탭이 다른 문서로 바뀌었으면 주입이 실패한다(다른 탭 읽기에서 고른 문서 밖으로 새지 않게).
export async function injectContentScriptInDocument(tabId: number, documentId: string): Promise<void> {
  const files = getContentScriptFiles();
  if (!files.length) throw new Error("manifest에 content script가 선언되지 않았습니다.");
  await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files });
}

// 주입한 content script는 로더가 본체 모듈을 동적 import한 뒤에야 리스너를 등록한다.
// 그 전에 보낸 메시지는 "Receiving end does not exist"로 실패하므로 잠깐씩 기다리며 재시도.
export const INJECT_READY_DELAYS_MS = [50, 100, 200, 400, 800, 1500];

export function isMissingReceiver(err: unknown): boolean {
  return (
    err instanceof Error &&
    /Could not establish connection|Receiving end does not exist/i.test(err.message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} 응답이 ${Math.round(ms / 1000)}초 안에 오지 않았습니다. 페이지가 이동했거나 스크립트가 응답하지 않을 수 있습니다.`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function callContentTool<T = unknown>(
  toolName: ToolName,
  args: unknown,
  callId: string,
  turnTab: TurnTab,
): Promise<T> {
  const endCall = timeSpan(`tool:${toolName}`);
  const tabId = await resolveTurnTab(turnTab);
  // If a navigation is in flight (e.g. just after click_element), wait for it
  // to settle so the content script in the new page has registered its listener.
  const navStart = Date.now();
  await waitForNavigationSettle(tabId, 10_000);
  const navWait = Date.now() - navStart;
  if (navWait > 50) debugLog("navigation:settled", `${navWait}ms`);
  const msg: BgToContent = { kind: "tool_exec", toolName, args, callId };
  const timeoutMs = TOOL_TIMEOUT_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;

  const send = async (): Promise<ContentResponse<T>> => {
    // 탭으로 열린 팝업이면 기다린 뒤에도 앞에 보이는지 다시 보고, 확인한 문서에만 보낸다.
    const documentId = await recheckTabPopup(turnTab, tabId);
    const res = (await withTimeout(
      chrome.tabs.sendMessage(tabId, msg, documentId ? { documentId } : { frameId: 0 }) as Promise<ContentResponse<T>>,
      timeoutMs,
      `컨텐트 스크립트(${toolName})`,
    )) as ContentResponse<T>;
    if (documentId) markTabPopupUsed(turnTab, tabId);
    return res;
  };

  let res: ContentResponse<T>;
  try {
    res = await send();
  } catch (err) {
    if (!isMissingReceiver(err)) {
      endCall("fail");
      throw err;
    }
    debugLog("tool:inject_retry", toolName, "warn");
    try {
      await injectContentScript(tabId);
    } catch (injectErr) {
      endCall("inject_fail");
      // 주소가 열리지 않아 Chrome 오류 화면이 떠 있으면 그 이유(오류 코드)를 알려, 모델이 주소를 짐작해 거듭 이동하지 않게 한다.
      const navErr = await navigationError(tabId);
      if (navErr) throw new Error(describeNavigationError(navErr));
      const baseMsg = injectErr instanceof Error ? injectErr.message : String(injectErr);
      throw new Error(`이 탭에 확장을 주입할 수 없습니다: ${baseMsg}`);
    }
    let lastErr: unknown = null;
    let delivered: ContentResponse<T> | null = null;
    for (const delay of INJECT_READY_DELAYS_MS) {
      await sleep(delay);
      try {
        delivered = await send();
        break;
      } catch (retryErr) {
        lastErr = retryErr;
        if (!isMissingReceiver(retryErr)) break;
      }
    }
    if (!delivered) {
      endCall("retry_fail");
      const baseMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new Error(`컨텐트 스크립트 호출 실패: ${baseMsg}`);
    }
    res = delivered;
  }

  if (!res?.ok) {
    endCall(`error: ${res?.error ?? "?"}`);
    throw new Error(res?.error ?? "컨텐트 스크립트 호출 실패");
  }
  endCall("ok");
  return res.data as T;
}

// 도구 실행이 아닌 짧은 내부 질의(승인 카드용 대상 확인, 클릭 결과 읽기). 주입·재시도는 하지 않는다 —
// content script가 없으면 id를 준 페이지가 이미 사라진 것이다.
export async function queryContent<T>(tabId: number, msg: BgToContent, timeoutMs: number, label: string): Promise<T> {
  const res = (await withTimeout(
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<ContentResponse<T>>,
    timeoutMs,
    label,
  )) as ContentResponse<T>;
  if (!res?.ok) {
    if (res?.diag) debugLog("content:diag", `${label} · ${res.diag}`, "warn");
    throw new Error(res?.error ?? `${label} 실패`);
  }
  return res.data as T;
}
