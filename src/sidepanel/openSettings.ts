import type { SettingsSection } from "@/lib/settingsSections";

// 설정 페이지(옵션 탭, #127)를 연다. 찾기·만들기는 백그라운드가 한 곳에서 한다(이미 열린 설정 탭이 있으면 그 탭으로).
// section이 없으면 열린 탭의 묶음을 그대로 둔다(새로 열면 모델·연결).
export async function openSettingsPage(section?: SettingsSection): Promise<void> {
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getCurrent()).id;
  } catch {
    windowId = undefined;
  }
  const res = (await chrome.runtime.sendMessage({ kind: "open_settings", section, windowId })) as { ok?: boolean; error?: string } | undefined;
  if (!res?.ok) throw new Error(res?.error ?? "설정 페이지를 열지 못했습니다.");
}
