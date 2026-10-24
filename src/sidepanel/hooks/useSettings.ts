import { useCallback, useEffect, useState } from "react";
import { SETTINGS_KEY, type Settings } from "@/lib/messages";
import { DEFAULT_SETTINGS, normalizeSettings, settingsForStorage } from "@/lib/settings";

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(SETTINGS_KEY).then((obj) => {
      setSettings(normalizeSettings(obj[SETTINGS_KEY] as Partial<Settings> | undefined));
      setLoaded(true);
    });
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && SETTINGS_KEY in changes) {
        setSettings(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings>));
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const save = useCallback(async (next: Settings) => {
    const normalized = settingsForStorage(next);
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    await chrome.runtime.sendMessage({ kind: "settings_updated" }).catch(() => {
      /* ignore */
    });
  }, []);

  return { settings, loaded, save };
}
