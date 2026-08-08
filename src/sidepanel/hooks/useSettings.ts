import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MAX_TOOL_HOPS,
  MAX_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MIN_MAX_TOOL_HOPS,
  SETTINGS_KEY,
  type Settings,
} from "@/lib/messages";
import { DEFAULT_MODEL, normalizeModelId } from "@/lib/models";

const DEFAULTS: Settings = {
  openRouterApiKey: "",
  model: DEFAULT_MODEL,
  systemPrompt: "",
  translationTargetLang: "ko",
  downloadFolderPrefix: "simple-browser-plugin",
  maxToolHops: DEFAULT_MAX_TOOL_HOPS,
};

function normalizeMaxHops(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_MAX_TOOL_HOPS;
  return Math.min(MAX_MAX_TOOL_HOPS, Math.max(MIN_MAX_TOOL_HOPS, n));
}

function normalize(raw: Partial<Settings> | undefined): Settings {
  return {
    openRouterApiKey:
      typeof raw?.openRouterApiKey === "string"
        ? raw.openRouterApiKey
        : DEFAULTS.openRouterApiKey,
    model: normalizeModelId(raw?.model),
    systemPrompt:
      typeof raw?.systemPrompt === "string"
        ? raw.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH)
        : DEFAULTS.systemPrompt,
    translationTargetLang:
      typeof raw?.translationTargetLang === "string" && raw.translationTargetLang.length >= 2
        ? raw.translationTargetLang
        : DEFAULTS.translationTargetLang,
    downloadFolderPrefix:
      typeof raw?.downloadFolderPrefix === "string"
        ? raw.downloadFolderPrefix
        : DEFAULTS.downloadFolderPrefix,
    maxToolHops: normalizeMaxHops(raw?.maxToolHops),
  };
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(SETTINGS_KEY).then((obj) => {
      setSettings(normalize(obj[SETTINGS_KEY] as Partial<Settings> | undefined));
      setLoaded(true);
    });
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && SETTINGS_KEY in changes) {
        setSettings(normalize(changes[SETTINGS_KEY].newValue as Partial<Settings>));
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const save = useCallback(async (next: Settings) => {
    const normalized = {
      ...next,
      systemPrompt: next.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH),
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    await chrome.runtime.sendMessage({ kind: "settings_updated" }).catch(() => {
      /* ignore */
    });
  }, []);

  return { settings, loaded, save };
}
