// 설정 페이지(옵션 탭, #127) 열기. 패널의 ⚙·"설정 열기"가 부른다. 이미 열린 설정 탭이 있으면 그 한 탭만 앞으로 가져와 묶음을
// 바꾸고(해시만 바꾸므로 다시 읽히지 않음 — 다른 설정 탭은 건드리지 않음), 없으면 새로 연다. 두 패널·연속 클릭이 겹쳐도 탭이
// 하나 더 생기지 않게 한 번에 하나씩 처리하고, 방금 만든 탭은 주소가 잡히기 전에도 다시 쓴다.
import { isSettingsSection, type SettingsSection } from "@/lib/settingsSections";

const PAGE = "src/options/index.html";
let queue: Promise<unknown> = Promise.resolve();
// 직렬화 안에서 방금 만든 탭(로드가 끝나기 전 다음 요청이 와도 그 탭을 쓴다).
let created: number | null = null;

export function openSettings(section: unknown, windowId: unknown): Promise<void> {
  const sec = isSettingsSection(section) ? section : null;
  const win = typeof windowId === "number" && Number.isInteger(windowId) ? windowId : undefined;
  const run = queue.then(() => open(sec, win));
  queue = run.catch(() => {});
  return run;
}

async function open(section: SettingsSection | null, windowId: number | undefined): Promise<void> {
  const base = chrome.runtime.getURL(PAGE);
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== undefined && isSettingsTab(t, base));
  if (created !== null && !tabs.some((t) => t.id === created)) {
    const t = await chrome.tabs.get(created).catch(() => null);
    if (t && t.id !== undefined && isSettingsTab(t, base)) tabs.push(t);
    else created = null;
  }
  const target = tabs.find((t) => t.windowId === windowId) ?? tabs[0];
  if (target?.id !== undefined) {
    await chrome.tabs.update(target.id, { active: true, ...(section ? { url: `${base}#${section}` } : {}) });
    // 그 탭이 있는 창을 앞으로(요청한 패널의 창이 아니라).
    await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
    return;
  }
  const tab = await chrome.tabs.create({ url: `${base}#${section ?? "model"}`, ...(windowId !== undefined ? { windowId } : {}) });
  created = tab.id ?? null;
}

// 이 확장의 설정 페이지 탭인지(만드는 중이면 pendingUrl). 다른 곳으로 옮긴 탭은 아니다.
function isSettingsTab(t: chrome.tabs.Tab, base: string): boolean {
  const u = t.url || t.pendingUrl || "";
  return u === base || u.startsWith(`${base}#`) || u.startsWith(`${base}?`);
}
