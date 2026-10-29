import { ABORTED_NAV_ERROR, type NavigationError } from "@/lib/navError";

interface PendingNav {
  resolvers: Array<() => void>;
  hardTimer: ReturnType<typeof setTimeout>;
  started: boolean;
}

const pending = new Map<number, PendingNav>();

function resolveTab(tabId: number): void {
  const entry = pending.get(tabId);
  if (!entry) return;
  clearTimeout(entry.hardTimer);
  for (const fn of entry.resolvers) fn();
  pending.delete(tabId);
}

// 탭마다 마지막 최상위 이동이 실패한 주소와 Chrome 오류 코드. 오류 화면이 떠 있는 동안만 남긴다.
const navErrors = new Map<number, NavigationError>();

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  navErrors.delete(details.tabId);
  const existing = pending.get(details.tabId);
  if (existing) {
    existing.started = true;
  } else {
    pending.set(details.tabId, {
      resolvers: [],
      hardTimer: setTimeout(() => resolveTab(details.tabId), 15_000),
      started: true,
    });
  }
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  // Small grace period so the content script has time to register its listener
  // after DOM completion.
  setTimeout(() => resolveTab(details.tabId), 250);
});

// 탭마다 최근 최상위 문서 커밋(문서 id, 페이지가 스스로 넘긴 이동인지). 따라가기 시작한 새 탭이 첫 도구 전에
// 광고 중간 주소처럼 스스로 다른 문서로 넘어갔는지 보는 데 쓴다(#146). 서비스 워커가 다시 뜨면 비어 있다.
const commits = new Map<number, Array<{ documentId: string; clientRedirect: boolean }>>();
const MAX_COMMITS = 8;

// 오류 화면은 onCommitted가 아니라 onErrorOccurred로 온다. 정상 문서가 커밋되면(뒤로 가기 포함) 기록을 지운다.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  navErrors.delete(details.tabId);
  if (!details.documentId) return;
  const q = details.transitionQualifiers ?? [];
  const list = commits.get(details.tabId) ?? [];
  list.push({ documentId: details.documentId, clientRedirect: q.includes("client_redirect") && !q.includes("forward_back") });
  if (list.length > MAX_COMMITS) list.shift();
  commits.set(details.tabId, list);
});

// 탭의 문서가 fromDoc에서 지금 문서 toDoc까지 페이지가 스스로 넘긴 이동(client_redirect)으로만 바뀌었는지.
// 사용자가 주소창·뒤로 가기·링크로 옮긴 이동이 하나라도 끼었거나 기록이 없으면 false.
export function redirectedOnlyFrom(tabId: number, fromDoc: string, toDoc: string): boolean {
  const list = commits.get(tabId);
  if (!list?.length || list[list.length - 1].documentId !== toDoc) return false;
  const from = list.map((c) => c.documentId).lastIndexOf(fromDoc);
  if (from < 0 || from === list.length - 1) return false;
  return list.slice(from + 1).every((c) => c.clientRedirect);
}

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.error !== ABORTED_NAV_ERROR) navErrors.set(details.tabId, { url: details.url, error: details.error });
  resolveTab(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  navErrors.delete(tabId);
  commits.delete(tabId);
  resolveTab(tabId);
});

export function markOptimisticNavigation(tabId: number): void {
  if (pending.has(tabId)) return;
  const entry: PendingNav = {
    resolvers: [],
    hardTimer: setTimeout(() => resolveTab(tabId), 15_000),
    started: false,
  };
  pending.set(tabId, entry);
  // If no actual navigation begins within 500ms, revoke the optimistic mark so
  // non-navigation clicks don't stall subsequent tool calls.
  setTimeout(() => {
    const current = pending.get(tabId);
    if (current === entry && !current.started && current.resolvers.length === 0) {
      resolveTab(tabId);
    }
  }, 500);
}

export function waitForNavigationSettle(tabId: number, timeoutMs = 10_000): Promise<void> {
  const entry = pending.get(tabId);
  if (!entry) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const softTimer = setTimeout(() => {
      const e = pending.get(tabId);
      if (e) {
        e.resolvers = e.resolvers.filter((r) => r !== resolve);
      }
      resolve();
    }, timeoutMs);
    entry.resolvers.push(() => {
      clearTimeout(softTimer);
      resolve();
    });
  });
}

// 탭에 지금 떠 있는 오류 화면의 원인. 기록한 주소와 탭 주소가 같을 때만 돌려준다(서비스 워커가 다시 떠 기록이 없으면 null).
export async function navigationError(tabId: number): Promise<NavigationError | null> {
  const rec = navErrors.get(tabId);
  if (!rec) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const current = tab?.url || tab?.pendingUrl;
  return current === rec.url ? rec : null;
}
