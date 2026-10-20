import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_CSV_MAX_CHARS,
  DEFAULT_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOOL_HOPS_VERSION,
  SETTINGS_KEY,
  normalizeCsvMaxChars,
  normalizeMaxToolHops,
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
  actionLogEnabled: true,
  csvMaxChars: DEFAULT_CSV_MAX_CHARS,
  autoApprove: false,
  showThinking: false,
  rememberPages: true,
};


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
    maxToolHops: normalizeMaxToolHops(raw),
    actionLogEnabled: raw?.actionLogEnabled !== false,
    csvMaxChars: normalizeCsvMaxChars(raw?.csvMaxChars),
    autoApprove: raw?.autoApprove === true,
    showThinking: raw?.showThinking === true,
    rememberPages: raw?.rememberPages !== false,
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
      csvMaxChars: normalizeCsvMaxChars(next.csvMaxChars),
      maxToolHops: normalizeMaxToolHops({ ...next, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }),
      maxToolHopsVersion: MAX_TOOL_HOPS_VERSION,
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    await chrome.runtime.sendMessage({ kind: "settings_updated" }).catch(() => {
      /* ignore */
    });
  }, []);

  return { settings, loaded, save };
}
