// 클릭이 연(열려 한) 팝업 창 관찰. 달력·주소 찾기처럼 window.open으로 작은 창을 띄워 고르게 하고, 고른 값을
// 원래 페이지(window.opener)에 써 넣고 닫히는 사이트가 있다(SRT 출발일 등).
// - window.open 관찰: 클릭하는 동안만 페이지(MAIN world)의 window.open을 감싸, 불린 주소와 브라우저가 막았는지
//   (null을 돌려줌)를 센다. 클릭이 끝나면 원래 함수로 되돌린다. 페이지가 이 기록을 꾸밀 수는 있지만, 결과에는
//   고정 문구와 줄인 주소(popupWhere)만 실으므로 페이지 글이 모델 지시문으로 들어가지 않는다.
// - 열린 팝업 창: 클릭하는 동안 이 탭의 문서가 연 탐색 대상(onCreatedNavigationTarget, 보조로 openerTabId) 중 창 종류가 popup인 것. 사용자가 따로 연 창이나
//   일반 새 탭(target=_blank)은 따라가지 않는다.

import { popupWhere, type PopupEffect } from "@/lib/actionTarget";
import { ABORTED, blockedOpens, bounded } from "@/lib/popupMatch";
import { sameSiteAs } from "@/lib/siteTrust";
import { debugLog } from "./debug";
import { followPopup, type TurnTab } from "./tools/handlers";

interface OpenCall {
  url: string;
  blocked: boolean;
}

// 페이지에 넣는 함수들은 chrome.scripting이 직렬화해 MAIN world에서 실행한다(바깥 변수를 쓰지 않는다).
function installOpenHook(key: string): void {
  const w = window as unknown as Record<string, unknown> & { open: typeof window.open };
  if (w[key]) return;
  const orig = w.open;
  const calls: Array<{ url: string; blocked: boolean }> = [];
  const hooked = function (this: unknown, ...args: Parameters<typeof window.open>) {
    const r = orig.apply(this as Window, args);
    try {
      let url = "";
      try {
        // 주소 없이(또는 빈 주소로) 부르면 빈 창(about:blank)이 열린다.
        const raw = args[0] == null ? "" : String(args[0]);
        url = raw === "" ? "about:blank" : new URL(raw, document.baseURI).href;
      } catch {
        url = "";
      }
      if (calls.length < 5) calls.push({ url, blocked: r == null });
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
  Object.defineProperty(w, key, { value: { calls, restore }, configurable: true, enumerable: false });
  // 기록을 읽어 가지 못해도(페이지 이동·오류) 오래 남지 않게 스스로 되돌린다.
  setTimeout(restore, 15_000);
}

function readOpenHook(key: string): Array<{ url: string; blocked: boolean }> | null {
  const w = window as unknown as Record<string, unknown>;
  const rec = w[key] as { calls?: unknown; restore?: unknown } | undefined;
  if (!rec || typeof rec !== "object") return null;
  try {
    if (typeof rec.restore === "function") (rec.restore as () => void)();
  } catch {
    /* ignore */
  }
  const calls = Array.isArray(rec.calls) ? rec.calls : [];
  // 페이지가 바꿔 놓았을 수 있어 꼴만 맞춰 원시 값으로 돌려준다.
  return calls.slice(0, 5).map((c) => {
    const o = (c ?? {}) as { url?: unknown; blocked?: unknown };
    return { url: typeof o.url === "string" ? o.url.slice(0, 2000) : "", blocked: o.blocked === true };
  });
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
): Promise<() => Promise<OpenCall[]>> {
  const key = `__sbpOpen_${crypto.randomUUID().replace(/-/g, "")}`;
  const read = async (): Promise<OpenCall[]> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: readOpenHook,
      args: [key],
    });
    const out: OpenCall[] = [];
    for (const r of results) {
      const calls = r.result as OpenCall[] | null | undefined;
      if (Array.isArray(calls)) out.push(...calls);
    }
    return out;
  };
  const readBounded = async (): Promise<OpenCall[]> => {
    // 클릭 결과는 중단돼도 정리 단계에서 부르므로, 중단이면 기다리지 않고 빈 기록(되돌리기는 페이지에 맡김).
    const r = await bounded(read(), HOOK_TIMEOUT_MS, [] as OpenCall[], signal);
    return r === ABORTED ? [] : r;
  };
  const installed = await bounded(
    chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func: installOpenHook, args: [key] })
      .then(() => true)
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
    void read().catch(() => []);
    throw new ClickAbortedError();
  }
  if (!installed) {
    debugLog("popup:hook_skip", "window.open 관찰 없이 클릭", "warn");
    void read().catch(() => []);
    return async () => [];
  }
  return readBounded;
}

interface CreatedTab {
  tabId: number;
  url: string;
}

// 이 탭이 연 새 탭·창(target=_blank, window.open)을 지켜본다. stop()을 부르면 관찰을 끝내고 만들어진 탭들을 준다.
// 주된 관계는 webNavigation.onCreatedNavigationTarget(이 탭의 문서가 연 새 탐색 대상 — 따로 뜬 팝업 창이나
// noopener 창처럼 탭 줄의 opener가 없는 경우도 잡힌다)이고, tabs.onCreated의 openerTabId는 보조 신호다.
export function watchNewTabs(tabId: number): { stop(): CreatedTab[] } {
  const created = new Map<number, CreatedTab>();
  const add = (id: number, url: string) => {
    const prev = created.get(id);
    created.set(id, { tabId: id, url: url || prev?.url || "" });
  };
  const onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId === tabId && tab.id !== undefined) add(tab.id, tab.pendingUrl || tab.url || "");
  };
  const onTarget = (d: chrome.webNavigation.WebNavigationSourceCallbackDetails) => {
    if (d.sourceTabId === tabId) add(d.tabId, d.url);
  };
  chrome.tabs.onCreated.addListener(onCreated);
  chrome.webNavigation.onCreatedNavigationTarget.addListener(onTarget);
  return {
    stop: () => {
      chrome.tabs.onCreated.removeListener(onCreated);
      chrome.webNavigation.onCreatedNavigationTarget.removeListener(onTarget);
      return [...created.values()];
    },
  };
}

// 클릭이 끝난 뒤: 막힌 window.open과 열린 팝업 창을 정리하고, 열린 팝업 창(첫 번째)은 따라간다.
// pageUrl은 클릭한 페이지 주소(다른 사이트 창인지 알리는 데만 쓴다 — 승인 판정은 openrouter가 지금 창 주소로 한다).
export async function settlePopups(
  turnTab: TurnTab,
  pageUrl: string,
  created: CreatedTab[],
  opens: OpenCall[],
): Promise<PopupEffect | null> {
  const effect: PopupEffect = {};
  // window.open은 noopener면 창이 열려도 null을 돌려준다. null을 돌려준 호출 중 같은 주소로 만들어진 탭·창이 없는
  // 것만 막힌 것으로 본다(성공한 호출·주소가 다른 새 탭은 막힌 호출을 가리지 않는다, src/lib/popupMatch.ts).
  const blocked = blockedOpens(opens, created.map((t) => t.url));
  if (blocked.length) effect.blocked = { count: blocked.length, where: popupWhere(blocked[0].url) };
  for (const t of created) {
    let tab: chrome.tabs.Tab | null = null;
    try {
      tab = await chrome.tabs.get(t.tabId);
    } catch {
      // 열렸다가 바로 닫힌 창
      continue;
    }
    let win: chrome.windows.Window | null = null;
    try {
      win = await chrome.windows.get(tab.windowId);
    } catch {
      win = null;
    }
    if (win?.type !== "popup") continue;
    // 열린 직후는 about:blank에서 시작해 이동 중일 수 있다. 가려는 주소(pendingUrl)를 먼저 본다.
    const url = tab.pendingUrl || tab.url || t.url;
    const followed = followPopup(turnTab, { tabId: t.tabId, windowId: tab.windowId });
    effect.opened = { where: popupWhere(url), followed, otherSite: /^https?:/i.test(url) && !sameSiteAs(pageUrl, url) };
    debugLog("popup:opened", `tab ${t.tabId}${followed ? " (따라감)" : ""}`);
    break;
  }
  return effect.blocked || effect.opened ? effect : null;
}
