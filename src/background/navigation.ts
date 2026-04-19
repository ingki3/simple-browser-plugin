interface PendingNav {
  resolvers: Array<() => void>;
  hardTimer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingNav>();

function resolveTab(tabId: number): void {
  const entry = pending.get(tabId);
  if (!entry) return;
  clearTimeout(entry.hardTimer);
  for (const fn of entry.resolvers) fn();
  pending.delete(tabId);
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!pending.has(details.tabId)) {
    pending.set(details.tabId, {
      resolvers: [],
      hardTimer: setTimeout(() => resolveTab(details.tabId), 15_000),
    });
  }
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  // Small grace period so the content script has time to register its listener
  // after DOM completion.
  setTimeout(() => resolveTab(details.tabId), 250);
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  resolveTab(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  resolveTab(tabId);
});

export function markOptimisticNavigation(tabId: number): void {
  if (pending.has(tabId)) return;
  const entry: PendingNav = {
    resolvers: [],
    hardTimer: setTimeout(() => resolveTab(tabId), 15_000),
  };
  pending.set(tabId, entry);
  // If no actual navigation begins within 500ms, revoke the optimistic mark so
  // non-navigation clicks don't stall subsequent tool calls.
  setTimeout(() => {
    const current = pending.get(tabId);
    if (current === entry && current.resolvers.length === 0) {
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
