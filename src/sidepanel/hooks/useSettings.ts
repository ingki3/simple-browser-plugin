import { useCallback, useEffect, useState } from "react";
import { SETTINGS_KEY, type Settings, type SettingsPatch } from "@/lib/messages";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/settings";

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // 첫 조회 응답이 그보다 늦게 처리된 변경 알림 뒤에 오면 옛 값으로 되돌린다(#127). 알림을 받았으면 첫 조회는 버리고
    // 알림의 새 값으로 loaded를 확정한다. 정리된 effect(StrictMode 재실행 등)의 늦은 응답도 버린다.
    let active = true;
    let changed = false;
    chrome.storage.local.get(SETTINGS_KEY).then((obj) => {
      if (!active || changed) return;
      setSettings(normalizeSettings(obj[SETTINGS_KEY] as Partial<Settings> | undefined));
      setLoaded(true);
    });
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (!active) return;
      if (area === "local" && SETTINGS_KEY in changes) {
        changed = true;
        setSettings(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings>));
        setLoaded(true);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  // 바꾼 필드만 최신 설정에 합쳐 저장한다(#99). 합치기·쓰기는 백그라운드가 차례로 해 여러 패널의 저장이 겹쳐도 서로 덮지 않는다.
  // (설정 전체를 쓰는 저장은 두지 않는다 — 화면이 들고 있는 옛 값으로 다른 곳의 변경을 덮는다.)
  const savePatch = useCallback(async (patch: SettingsPatch) => {
    const res = (await chrome.runtime.sendMessage({ kind: "settings_patch", patch })) as { ok?: boolean; error?: string } | undefined;
    if (!res?.ok) throw new Error(res?.error ?? "설정을 저장하지 못했습니다.");
  }, []);

  return { settings, loaded, savePatch };
}
