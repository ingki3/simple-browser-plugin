import { DEFAULT_MODEL, normalizeModelId } from "@/lib/models";
import {
  DEFAULT_CSV_MAX_CHARS,
  DEFAULT_MAX_TOOL_HOPS,
  FLAGS_KEY,
  LEGACY_DEFAULT_MAX_TOOL_HOPS,
  MAX_MAX_TOOL_HOPS,
  MIN_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  SETTINGS_KEY,
  normalizeCsvMaxChars,
  type Flags,
  type Settings,
} from "@/lib/messages";

export const DEFAULT_SETTINGS: Settings = {
  openRouterApiKey: "",
  model: DEFAULT_MODEL,
  systemPrompt: "",
  translationTargetLang: "ko",
  downloadFolderPrefix: "simple-browser-plugin",
  maxToolHops: DEFAULT_MAX_TOOL_HOPS,
  actionLogEnabled: true,
  csvMaxChars: DEFAULT_CSV_MAX_CHARS,
  autoApprove: false,
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
    systemPrompt:
      typeof raw.systemPrompt === "string"
        ? raw.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH)
        : DEFAULT_SETTINGS.systemPrompt,
    translationTargetLang:
      typeof raw.translationTargetLang === "string" && raw.translationTargetLang.length >= 2
        ? raw.translationTargetLang
        : DEFAULT_SETTINGS.translationTargetLang,
    downloadFolderPrefix:
      typeof raw.downloadFolderPrefix === "string"
        ? raw.downloadFolderPrefix
        : DEFAULT_SETTINGS.downloadFolderPrefix,
    maxToolHops: normalizeMaxHops(raw.maxToolHops),
    actionLogEnabled: raw.actionLogEnabled !== false,
    csvMaxChars: normalizeCsvMaxChars(raw.csvMaxChars),
    autoApprove: raw.autoApprove === true,
  };
}

export async function writeSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...next,
      systemPrompt: next.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH),
      maxToolHops: normalizeMaxHops(next.maxToolHops),
      csvMaxChars: normalizeCsvMaxChars(next.csvMaxChars),
    },
  });
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

// 기본 도구 호출 한도를 8에서 16으로 올렸다. 설정 화면은 설정 전체를 저장하므로 예전 기본값 8이 저장돼 있으면
// 사용자가 고른 값인지 알 수 없다. 한 번만 새 기본값으로 올리고, 그 뒤에 사용자가 8로 바꾸면 그대로 둔다.
export async function migrateMaxToolHops(): Promise<void> {
  const flags = await readFlags();
  if (flags.maxToolHopsMigrated) return;
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = obj[SETTINGS_KEY] as Partial<Settings> | undefined;
  if (raw && raw.maxToolHops === LEGACY_DEFAULT_MAX_TOOL_HOPS) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...raw, maxToolHops: DEFAULT_MAX_TOOL_HOPS } });
  }
  await setFlag("maxToolHopsMigrated", true);
}
