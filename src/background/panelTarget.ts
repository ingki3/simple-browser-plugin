// 패널이 붙은 창의 활성 탭(#174·#173). 패널은 자기 창 id(chrome.windows.getCurrent)를 보내고, 백그라운드는 그 창에서만 찾는다
// (마지막으로 포커스된 창이 아니라 버튼을 누른 패널의 창). 시크릿 창이면 쓰지 않는다.

export interface PanelTab {
  tabId: number;
  url: string;
  // http(s) 페이지인지(기억하기·제안 대상).
  web: boolean;
}

export async function panelTarget(windowId: unknown): Promise<PanelTab> {
  if (typeof windowId !== "number" || !Number.isInteger(windowId)) throw new Error("창을 확인할 수 없습니다.");
  let win: chrome.windows.Window;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    throw new Error("창을 찾을 수 없습니다.");
  }
  if (win.incognito) throw new Error("시크릿 창에서는 쓸 수 없습니다.");
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id) throw new Error("이 창의 활성 탭을 찾을 수 없습니다.");
  const url = tab.url ?? "";
  return { tabId: tab.id, url, web: /^https?:\/\//i.test(url) };
}
