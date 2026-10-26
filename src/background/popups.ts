// 클릭이 연(열려 한) 팝업 창 관찰. 달력·주소 찾기처럼 window.open으로 작은 창을 띄워 고르게 하고, 고른 값을
// 원래 페이지(window.opener)에 써 넣고 닫히는 사이트가 있다(SRT 출발일 등).
// - window.open 관찰: 클릭하는 동안만 페이지(MAIN world)의 window.open을 감싸, 불린 주소와 브라우저가 막았는지
//   (null을 돌려줌)를 센다. 클릭이 끝나면 원래 함수로 되돌린다. 페이지가 이 기록을 꾸밀 수는 있지만, 결과에는
//   고정 문구와 줄인 주소(popupWhere)만 실으므로 페이지 글이 모델 지시문으로 들어가지 않는다.
// - 열린 팝업 창: 클릭하는 동안 이 탭의 문서가 연 탐색 대상(onCreatedNavigationTarget, 보조로 openerTabId) 중 창 종류가 popup인 것. 사용자가 따로 연 창이나
//   일반 새 탭(target=_blank 링크 등)은 브라우저가 같은 창의 앞에 띄운 하나뿐일 때만 따라간다(newTabIneligible).

import { popupWhere, type PopupEffect } from "@/lib/actionTarget";
import {
  ABORTED,
  blockedOpens,
  bounded,
  OPEN_CALLS_MAX,
  OPEN_FEATURES_MAX,
  OPEN_URL_MAX,
  newTabIneligible,
  popupTabIneligible,
  reusedTargets,
  type OpenCallRecord,
} from "@/lib/popupMatch";
import { sameSiteAs } from "@/lib/siteTrust";
import { debugLog } from "./debug";
import { followPopup, isKnownPopup, type TurnTab } from "./tools/handlers";

type OpenCall = OpenCallRecord;

// 클릭 동안의 window.open 기록. complete: 감싼 모든 프레임의 기록을 한도 안에서 빠짐없이 읽었는지
// (넣기·읽기 실패, 시간 초과, 프레임 기록 유실, 호출 수 한도 초과면 false).
export interface OpenRecord {
  calls: OpenCall[];
  complete: boolean;
}

// 페이지에 넣는 함수들은 chrome.scripting이 직렬화해 MAIN world에서 실행한다(바깥 변수를 쓰지 않는다).
// 한도 값은 인자로 받는다. 기록: 주소(urlMax에서 자름, 잘렸는지), null 반환 여부, 창 옵션 원문(featuresMax 넘거나 읽지
// 못하면 null), 전체 호출 수(total — 한도를 넘었는지 보려고).
function installOpenHook(key: string, maxCalls: number, urlMax: number, featuresMax: number): boolean {
  const w = window as unknown as Record<string, unknown> & { open: typeof window.open };
  if (w[key]) return true;
  const orig = w.open;
  const calls: Array<{ url: string; blocked: boolean; urlClipped: boolean; features: string | null }> = [];
  const state = { total: 0 };
  const hooked = function (this: unknown, ...args: Parameters<typeof window.open>) {
    const r = orig.apply(this as Window, args);
    try {
      state.total++;
      let url = "";
      try {
        // 주소 없이(또는 빈 주소로) 부르면 빈 창(about:blank)이 열린다.
        const raw = args[0] == null ? "" : String(args[0]);
        url = raw === "" ? "about:blank" : new URL(raw, document.baseURI).href;
      } catch {
        url = "";
      }
      let features: string | null = null;
      try {
        // window.open은 세 번째 인자를 문자열로 바꿔 쓴다(없으면 빈 문자열).
        const f = args[2] === undefined ? "" : String(args[2]);
        features = f.length > featuresMax ? null : f;
      } catch {
        features = null;
      }
      if (calls.length < maxCalls) {
        calls.push({ url: url.slice(0, urlMax), blocked: r == null, urlClipped: url.length > urlMax, features });
      }
    } catch {
      /* 기록 실패는 무시 */
    }
    return r;
  };
  const restore = () => {
    if (w.open === hooked) w.open = orig;
    try {
      delete w[key];
    } catch {
      /* ignore */
    }
  };
  w.open = hooked as typeof window.open;
  Object.defineProperty(w, key, { value: { calls, state, restore }, configurable: true, enumerable: false });
  // 기록을 읽어 가지 못해도(페이지 이동·오류) 오래 남지 않게 스스로 되돌린다.
  setTimeout(restore, 15_000);
  return true;
}

function readOpenHook(
  key: string,
  maxCalls: number,
  urlMax: number,
  featuresMax: number,
): { calls: Array<{ url: string; blocked: boolean; urlClipped: boolean; features: string | null }>; overflow: boolean } | null {
  const w = window as unknown as Record<string, unknown>;
  const rec = w[key] as { calls?: unknown; state?: unknown; restore?: unknown } | undefined;
  if (!rec || typeof rec !== "object") return null;
  try {
    if (typeof rec.restore === "function") (rec.restore as () => void)();
  } catch {
    /* ignore */
  }
  const calls = Array.isArray(rec.calls) ? rec.calls : [];
  const total = (rec.state as { total?: unknown } | undefined)?.total;
  // 페이지가 바꿔 놓았을 수 있어 꼴만 맞춰 원시 값으로 돌려준다. 꼴이 틀린 값은 완전하지 않은 기록으로 본다.
  let malformed = typeof total !== "number" || calls.length > maxCalls;
  const out = calls.slice(0, maxCalls).map((c) => {
    const o = (c ?? {}) as { url?: unknown; blocked?: unknown; urlClipped?: unknown; features?: unknown };
    if (typeof o.url !== "string" || typeof o.blocked !== "boolean") malformed = true;
    const url = typeof o.url === "string" ? o.url : "";
    return {
      url: url.slice(0, urlMax),
      blocked: o.blocked === true,
      urlClipped: o.urlClipped === true || url.length > urlMax,
      features: typeof o.features === "string" && o.features.length <= featuresMax ? o.features : null,
    };
  });
  return { calls: out, overflow: malformed || (total as number) > calls.length };
}

// 관찰(부가 기능)을 기다리는 한도. 넣기·읽기가 이보다 오래 걸리면(알림창이 페이지 스크립트를 멈춘 경우 등) 관찰 없이 간다.
const HOOK_TIMEOUT_MS = 1_500;

export class ClickAbortedError extends Error {
  constructor() {
    super("사용자가 중단해 클릭하지 않았습니다.");
  }
}


// 클릭 직전에 그 탭 모든 프레임의 window.open을 감싼다. 돌려준 함수를 부르면 기록을 읽고 되돌린다. 넣지 못하거나
// 한도 안에 넣지 못하면(권한 없는 페이지·멈춘 페이지) 빈 기록 — 관찰은 부가 기능이라 클릭을 막지 않는다. 다만 기다리는
// 동안 사용자가 중단했으면 ClickAbortedError를 던진다(승인한 클릭이 중단 뒤에 실행되지 않게).
// 읽기도 한도와 중단 신호를 지켜, 클릭 처리기가 띄운 알림창이 페이지 스크립트를 멈춰도 클릭 결과를 막지 않는다
// (그때 감싼 함수는 페이지가 다시 움직이면 스스로 되돌린다).
export async function watchWindowOpen(
  tabId: number,
  signal?: AbortSignal,
): Promise<() => Promise<OpenRecord>> {
  const key = `__sbpOpen_${crypto.randomUUID().replace(/-/g, "")}`;
  const limits: [number, number, number] = [OPEN_CALLS_MAX, OPEN_URL_MAX, OPEN_FEATURES_MAX];
  // 감싸기를 넣은 프레임 수. 읽을 때 이보다 적은 프레임에서 기록이 나오면(프레임 이동 등) 완전하지 않다.
  let installedFrames = 0;
  const read = async (): Promise<OpenRecord> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: readOpenHook,
      args: [key, ...limits],
    });
    const calls: OpenCall[] = [];
    let found = 0;
    let complete = true;
    for (const r of results) {
      const rec = r.result as { calls: OpenCall[]; overflow: boolean } | null | undefined;
      if (!rec || !Array.isArray(rec.calls)) continue;
      found++;
      if (rec.overflow) complete = false;
      calls.push(...rec.calls);
    }
    if (found < installedFrames) complete = false;
    return { calls, complete };
  };
  const readBounded = async (): Promise<OpenRecord> => {
    // 클릭 결과는 중단돼도 정리 단계에서 부르므로, 중단이면 기다리지 않고 빈 기록(되돌리기는 페이지에 맡김).
    const empty: OpenRecord = { calls: [], complete: false };
    const r = await bounded(read(), HOOK_TIMEOUT_MS, empty, signal);
    return r === ABORTED ? empty : r;
  };
  const installed = await bounded(
    chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: installOpenHook, args: [key, ...limits] })
      .then((results) => {
        installedFrames = results.filter((r) => r.result === true).length;
        return true;
      })
      .catch((err) => {
        debugLog("popup:hook_fail", err instanceof Error ? err.message : String(err), "warn");
        return false;
      }),
    HOOK_TIMEOUT_MS,
    false,
    signal,
  );
  if (installed === ABORTED) {
    // 늦게 들어간 감싸기도 되돌린다(못 읽으면 페이지에서 스스로 되돌린다).
    void read().catch(() => null);
    throw new ClickAbortedError();
  }
  if (!installed) {
    debugLog("popup:hook_skip", "window.open 관찰 없이 클릭", "warn");
    void read().catch(() => null);
    return async () => ({ calls: [], complete: false });
  }
  return readBounded;
}

interface CreatedTab {
  tabId: number;
  url: string;
  // 새로 만들어지지 않고 이동만 시작된 다른 탭(이름 있는 창을 다시 쓴 window.open 후보). 새 탭이 아니다.
  reused?: boolean;
  // 처음 본 시각(Date.now). 오래 지켜보는 손 넘기기에서 사용자의 클릭 즈음에 열린 것만 고르는 데 쓴다(#81).
  at?: number;
}

// 이 탭이 연 새 탭·창(target=_blank, window.open)을 지켜본다. stop()을 부르면 관찰을 끝내고 만들어진 탭들을 준다.
// 주된 관계는 webNavigation.onCreatedNavigationTarget(이 탭의 문서가 연 새 탐색 대상 — 따로 뜬 팝업 창이나
// noopener 창처럼 탭 줄의 opener가 없는 경우도 잡힌다)이고, tabs.onCreated의 openerTabId는 보조 신호다.
export function watchNewTabs(tabId: number): { stop(): CreatedTab[] } {
  const created = new Map<number, CreatedTab>();
  const add = (id: number, url: string) => {
    const prev = created.get(id);
    created.set(id, { tabId: id, url: url || prev?.url || "", at: prev?.at ?? Date.now() });
  };
  const onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId === tabId && tab.id !== undefined) add(tab.id, tab.pendingUrl || tab.url || "");
  };
  const onTarget = (d: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
    if (d.sourceTabId === tabId) add(d.tabId, d.url);
  };
  // 이미 열린 이름 있는 창을 다시 쓰면 새 탭 없이 그 창의 최상위 문서만 이동한다. 클릭 동안 다른 탭에서 시작된 이동을
  // 후보로 모으고, 어느 것을 따라갈지는 settlePopups가 window.open 기록·창 종류·관계로 정한다.
  const navigated: CreatedTab[] = [];
  const onBefore = (d: chrome.webNavigation.WebNavigationParentedCallbackDetails) => {
    if (d.frameId !== 0 || d.tabId === tabId || navigated.length >= 10) return;
    navigated.push({ tabId: d.tabId, url: d.url, reused: true, at: Date.now() });
  };
  chrome.tabs.onCreated.addListener(onCreated);
  chrome.webNavigation.onCreatedNavigationTarget.addListener(onTarget);
  chrome.webNavigation.onBeforeNavigate.addListener(onBefore);
  return {
    stop: () => {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.webNavigation.onCreatedNavigationTarget.removeListener(onTarget);
      chrome.webNavigation.onBeforeNavigate.removeListener(onBefore);
      // 새로 만들어진 탭의 첫 이동은 다시 쓴 창이 아니다.
      return [...created.values(), ...navigated.filter((n) => !created.has(n.tabId))];
    },
  };
}

// 따라가지 않은 후보와 그 이유(디버그 로그). 주소·창 이름·features·페이지 글자는 싣지 않고 탭 id와 고정 문구만 남긴다.
function skipLog(tabId: number, why: string): void {
  debugLog("popup:skip", `tab ${tabId} · ${why}`);
}

// 새 탭의 첫 문서가 확정되기를 잠깐 기다린 뒤 그 탭의 상태를 읽는다. 확정된 최상위 문서 주소가 expectUrl과 같고 더
// 이동 중이 아니면 바로 돌려주고, 시간이 지나면 그때 상태를 돌려준다(주소가 다르거나 이동 중이면 따라가지 않는다).
async function settledTabState(
  tabId: number,
  expectUrl: string,
  timeoutMs = 3_000,
): Promise<{ windowId: number; active: boolean; committedUrl: string | null; pending: boolean; documentId: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    let frame: chrome.webNavigation.GetFrameResultDetails | null = null;
    try {
      frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    } catch {
      frame = null;
    }
    const state = {
      windowId: tab.windowId,
      active: tab.active,
      committedUrl: frame?.url ?? null,
      pending: !!tab.pendingUrl || tab.status === "loading" && frame?.url !== expectUrl,
      documentId: frame?.documentId ?? null,
    };
    if ((state.committedUrl === expectUrl && !tab.pendingUrl) || Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 새 탭의 첫 웹 문서가 확정되기를 잠깐 기다린다(열린 직후는 about:blank이거나 이동 중). 주소를 미리 모르는 링크
// 새 탭용: 이동 중이 아니고 로딩이 끝났고(로딩 중 스크립트로 넘어가는 중간 문서를 고정하지 않게) 확정된 최상위 문서가
// http(s)면 바로, 시간이 지나면 그때 상태를 돌려준다(로딩 중이면 pending — 따라가지 않는다).
async function settledNewTab(
  tabId: number,
  timeoutMs = 5_000,
): Promise<{ windowId: number; active: boolean; committedUrl: string | null; pending: boolean; documentId: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
    let frame: chrome.webNavigation.GetFrameResultDetails | null = null;
    try {
      frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    } catch {
      frame = null;
    }
    const committedUrl = frame?.url ?? null;
    const state = {
      windowId: tab.windowId,
      active: tab.active,
      committedUrl,
      pending: !!tab.pendingUrl || tab.status === "loading",
      documentId: frame?.documentId ?? null,
    };
    if ((!state.pending && committedUrl && /^https?:/i.test(committedUrl)) || Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 클릭이 끝난 뒤: 막힌 window.open과 열린 팝업 창을 정리하고, 열린 팝업 창(첫 번째)은 따라간다.
// 팝업을 요청한 window.open이 브라우저 사정(macOS 전체 화면 등)으로 같은 창의 탭으로 열렸으면, 브라우저가 그 탭을
// 앞에 띄웠고 기록이 모호하지 않을 때만(popupTabIneligible) 그 탭을 팝업처럼 따라간다(kind "tab").
// pageUrl은 클릭한 페이지 주소(다른 사이트 창인지 알리는 데만 쓴다 — 승인 판정은 openrouter가 지금 창 주소로 한다).
// sourceWindowId는 클릭 직전 클릭한 탭이 있던 창.
export async function settlePopups(
  turnTab: TurnTab,
  pageUrl: string,
  created: CreatedTab[],
  record: OpenRecord,
  clickedTabId: number,
  sourceWindowId: number | null,
): Promise<PopupEffect | null> {
  const opens = record.calls;
  const effect: PopupEffect = {};
  const fresh = created.filter((t) => !t.reused);
  // window.open은 noopener면 창이 열려도 null을 돌려준다. null을 돌려준 호출 중 같은 주소로 만들어진 탭·창이 없는
  // 것만 막힌 것으로 본다(성공한 호출·주소가 다른 새 탭은 막힌 호출을 가리지 않는다, src/lib/popupMatch.ts).
  const blocked = blockedOpens(opens, fresh.map((t) => t.url));
  if (blocked.length) effect.blocked = { count: blocked.length, where: popupWhere(blocked[0].url) };
  // 다시 쓴 이름 있는 창: 이 클릭의 window.open이 창을 돌려줬고 주소가 같으며, 우리 클릭으로 열린 적 있는 이 탭의
  // 팝업이거나 opener가 클릭한 탭인 것만(사용자가 따로 연 창은 아니다). 창 종류 popup·깊이 한도는 아래에서 같게 본다.
  const navigated = created.filter((t) => t.reused);
  const matched = reusedTargets(opens, navigated);
  // 클릭 동안 다른 탭에서 시작된 이동 중 이 클릭의 window.open 주소와 짝지어지지 않은 것(대개 무관한 탭)은 수만 남긴다.
  if (navigated.length > matched.length) {
    debugLog("popup:skip", `다른 탭 이동 ${navigated.length - matched.length}개 — 이 클릭의 window.open 주소와 다름`);
  }
  const reused: CreatedTab[] = [];
  for (const n of matched) {
    let openerOk = isKnownPopup(turnTab, n.tabId);
    if (!openerOk) {
      try {
        openerOk = (await chrome.tabs.get(n.tabId)).openerTabId === clickedTabId;
      } catch {
        openerOk = false;
      }
    }
    if (openerOk) reused.push(n);
    else skipLog(n.tabId, "다시 쓴 창 후보 — 이 탭의 팝업도, 이 탭이 연 창도 아님");
  }
  const candidates = [...fresh, ...reused];
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    let tab: chrome.tabs.Tab | null = null;
    try {
      tab = await chrome.tabs.get(t.tabId);
    } catch {
      // 열렸다가 바로 닫힌 창
      skipLog(t.tabId, "탭이 이미 닫힘");
      continue;
    }
    let win: chrome.windows.Window | null = null;
    try {
      win = await chrome.windows.get(tab.windowId);
    } catch {
      win = null;
    }
    if (!win) {
      skipLog(t.tabId, "창을 조회하지 못함");
      continue;
    }
    let asTab: { documentId: string; url: string } | null = null;
    let newTab = false;
    if (win.type !== "popup") {
      // 일반 창의 탭: 팝업을 요청한 window.open이 탭으로 열린 경우만(다시 쓴 창은 대상이 아니다).
      const call = opens.filter((c) => !c.blocked);
      const why =
        t.reused || win.type !== "normal" || sourceWindowId === null
          ? `창 종류 ${win.type}${t.reused ? " (다시 쓴 창)" : ""}`
          : await (async () => {
              const pre = popupTabIneligible({
                opensComplete: record.complete,
                opens,
                freshCount: fresh.length,
                sourceWindowId,
                tab: { windowId: tab.windowId, windowType: win.type ?? "", active: true, committedUrl: "", pending: false },
              });
              // 주소·활성 상태 외의 조건이 먼저 걸리면 문서 확정을 기다리지 않는다.
              if (pre && pre !== "탭 주소가 window.open 주소와 다름") return pre;
              const st = await settledTabState(t.tabId, call[0].url);
              if (!st) return "탭이 이미 닫힘";
              const reason = popupTabIneligible({
                opensComplete: record.complete,
                opens,
                freshCount: fresh.length,
                sourceWindowId,
                tab: { windowId: st.windowId, windowType: win.type ?? "", active: st.active, committedUrl: st.committedUrl, pending: st.pending },
              });
              if (!reason && st.documentId) asTab = { documentId: st.documentId, url: st.committedUrl as string };
              return reason ?? (st.documentId ? null : "탭의 문서를 확인할 수 없음");
            })();
      // 팝업을 탭으로 연 경우가 아니면 일반 새 탭으로 본다: 이 클릭이 연 새 탭 하나를 브라우저가 같은 창의 앞에 띄웠으면
      // 따라간다(뒤에 열린 탭이면 원래 탭에 남는다 — 사용자가 보는 탭에서 계속).
      let tabWhy = why;
      if ((why || !asTab) && !t.reused && win.type === "normal" && sourceWindowId !== null) {
        const st = await settledNewTab(t.tabId);
        const reason = st
          ? newTabIneligible({
              freshCount: fresh.length,
              sourceWindowId,
              tab: { windowId: st.windowId, windowType: win.type, active: st.active, committedUrl: st.committedUrl, pending: st.pending },
            })
          : "탭이 이미 닫힘";
        if (!reason && st?.documentId) {
          asTab = { documentId: st.documentId, url: st.committedUrl as string };
          newTab = true;
          tabWhy = null;
        } else {
          tabWhy = `팝업 탭 아님(${why ?? "탭의 문서를 확인할 수 없음"}), 새 탭 아님(${reason ?? "탭의 문서를 확인할 수 없음"})`;
        }
      }
      if (tabWhy || !asTab) {
        skipLog(t.tabId, `${tabWhy ?? "탭의 문서를 확인할 수 없음"} (일반 창 탭)`);
        continue;
      }
    }
    // 열린 직후는 about:blank에서 시작해 이동 중일 수 있다. 가려는 주소(pendingUrl)를 먼저 본다.
    const tabPopup = asTab as { documentId: string; url: string } | null;
    const url = tabPopup ? tabPopup.url : t.reused ? t.url : tab.pendingUrl || tab.url || t.url;
    const followed = await followPopup(
      turnTab,
      tabPopup
        ? { tabId: t.tabId, windowId: tab.windowId, kind: "tab", documentId: tabPopup.documentId, ...(newTab ? { newTab: true } : {}) }
        : { tabId: t.tabId, windowId: tab.windowId },
    );
    effect.opened = {
      where: popupWhere(url),
      followed,
      otherSite: /^https?:/i.test(url) && !sameSiteAs(pageUrl, url),
      ...(tabPopup ? { asTab: true } : {}),
      ...(newTab ? { newTab: true } : {}),
    };
    debugLog("popup:opened", `tab ${t.tabId}${t.reused ? " (다시 쓴 창)" : ""}${newTab ? " (새 탭)" : tabPopup ? " (탭으로 열림)" : ""}${followed ? " (따라감)" : " (따라가지 않음 — 깊이 한도 또는 이미 따라가는 창)"}`);
    if (i + 1 < candidates.length) debugLog("popup:skip", `첫 팝업 창 뒤 남은 후보 ${candidates.length - i - 1}개는 보지 않음`);
    break;
  }
  return effect.blocked || effect.opened ? effect : null;
}
