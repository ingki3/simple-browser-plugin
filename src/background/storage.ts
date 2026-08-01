import { DEFAULT_MODEL, normalizeModelId } from "@/lib/models";
import {
  DEFAULT_MAX_TOOL_HOPS,
  FLAGS_KEY,
  MAX_MAX_TOOL_HOPS,
  MIN_MAX_TOOL_HOPS,
  SETTINGS_KEY,
  type Flags,
  type Settings,
} from "@/lib/messages";

export const DEFAULT_SETTINGS: Settings = {
  openRouterApiKey: "",
  model: DEFAULT_MODEL,
  translationTargetLang: "ko",
  downloadFolderPrefix: "simple-browser-plugin",
  maxToolHops: DEFAULT_MAX_TOOL_HOPS,
};

function normalizeMaxHops(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_MAX_TOOL_HOPS;
  return Math.min(MAX_MAX_TOOL_HOPS, Math.max(MIN_MAX_TOOL_HOPS, n));
}

export async function readSettings(): Promise<Settings> {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = (obj[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return {
    openRouterApiKey:
      typeof raw.openRouterApiKey === "string" ? raw.openRouterApiKey : "",
    model: normalizeModelId(raw.model),
    translationTargetLang:
      typeof raw.translationTargetLang === "string" && raw.translationTargetLang.length >= 2
        ? raw.translationTargetLang
        : DEFAULT_SETTINGS.translationTargetLang,
    downloadFolderPrefix:
      typeof raw.downloadFolderPrefix === "string"
        ? raw.downloadFolderPrefix
        : DEFAULT_SETTINGS.downloadFolderPrefix,
    maxToolHops: normalizeMaxHops(raw.maxToolHops),
  };
}

export async function writeSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  cache = await readSettings();
  return cache;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTINGS_KEY in changes) {
    cache = null;
  }
});

export async function readFlags(): Promise<Flags> {
  const obj = await chrome.storage.local.get(FLAGS_KEY);
  return (obj[FLAGS_KEY] as Flags | undefined) ?? {};
}

export async function setFlag<K extends keyof Flags>(key: K, value: Flags[K]): Promise<void> {
  const current = await readFlags();
  const next: Flags = { ...current, [key]: value };
  await chrome.storage.local.set({ [FLAGS_KEY]: next });
}
