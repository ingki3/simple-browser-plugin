import { useEffect, useRef, useState } from "react";

export interface CurrentTab {
  windowId: number;
  tabId: number;
  url: string;
  web: boolean;
}

// 패널이 붙은 창의 활성 탭(#174·#173). 표시용이며, 이 값으로 하는 동작은 백그라운드가 다시 확인한다.
// 탭 전환·주소 변화·로드 완료마다 다시 묻고, 겹친 조회는 순번으로 늦은 응답을 버린다. 시크릿 창이면 null.
// loadSeq: 탭이 새로 로드를 시작할 때마다(새로고침 포함) 올린다 — 페이지 제안을 페이지마다 한 번만 띄우는 데 쓴다.
export function useCurrentTab(): { tab: CurrentTab | null; loadSeq: number } {
  const [tab, setTab] = useState<CurrentTab | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const seq = useRef(0);
  const windowId = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const mine = ++seq.current;
      try {
        if (windowId.current === null) windowId.current = (await chrome.windows.getCurrent()).id ?? null;
        const wid = windowId.current;
        if (wid === null) throw new Error("no window");
        const res = (await chrome.runtime.sendMessage({ kind: "current_tab_info", windowId: wid })) as
          | { ok: boolean; data?: { tabId: number; url: string; web: boolean } | null }
          | undefined;
        if (!alive || mine !== seq.current) return;
        const d = res?.ok ? res.data : null;
        setTab(d ? { windowId: wid, tabId: d.tabId, url: d.url, web: d.web } : null);
      } catch {
        if (alive && mine === seq.current) setTab(null);
      }
    };
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      if (windowId.current === null || info.windowId === windowId.current) void refresh();
    };
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo, t: chrome.tabs.Tab) => {
      if (!t.active || (windowId.current !== null && t.windowId !== windowId.current)) return;
      if (change.status === "loading") setLoadSeq((n) => n + 1);
      if (change.url !== undefined || change.status !== undefined) void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    void refresh();
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return { tab, loadSeq };
}
