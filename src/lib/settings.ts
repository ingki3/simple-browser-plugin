// 설정의 기본값·읽기 정리·저장 정리를 한곳에 둔다. 백그라운드(storage.ts)·사이드 패널(useSettings)·옵션 페이지가 함께 써서,
// 새 설정을 넣을 때 세 곳이 따로 어긋나지 않게 한다.
import { normalizeManualSites } from "./manualSites.ts";
import { isProviderId, type ProviderId } from "./providers/types.ts";
import { OPENAI_DEFAULT_MODEL } from "./providers/openai.ts";
import { GEMINI_DEFAULT_MODEL } from "./providers/gemini.ts";
import { DEFAULT_MODEL, normalizeModelId } from "./models.ts";
import {
  DEFAULT_CSV_MAX_CHARS,
  DEFAULT_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOOL_HOPS_VERSION,
  normalizeCsvMaxChars,
  normalizeMaxToolHops,
  type Settings,
} from "./messages.ts";

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",
  openRouterApiKey: "",
  apiKeys: {},
  providerModels: {},
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
  trustedInput: false,
  manualSites: [],
};

// 저장소에서 읽은 값(없거나 일부만 있거나 형식이 틀릴 수 있음)을 완전한 설정으로 정리한다.
// 켜짐이 기본인 설정은 false일 때만 끄고, 꺼짐이 기본인 설정은 true일 때만 켠다.
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const r = raw ?? {};
  return {
    provider: isProviderId(r.provider) ? r.provider : DEFAULT_SETTINGS.provider,
    openRouterApiKey: typeof r.openRouterApiKey === "string" ? r.openRouterApiKey : DEFAULT_SETTINGS.openRouterApiKey,
    apiKeys: stringFields(r.apiKeys, ["openai", "gemini"]),
    providerModels: stringFields(r.providerModels, ["openai", "gemini"]),
    model: normalizeModelId(r.model),
    systemPrompt:
      typeof r.systemPrompt === "string" ? r.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH) : DEFAULT_SETTINGS.systemPrompt,
    translationTargetLang:
      typeof r.translationTargetLang === "string" && r.translationTargetLang.length >= 2
        ? r.translationTargetLang
        : DEFAULT_SETTINGS.translationTargetLang,
    downloadFolderPrefix:
      typeof r.downloadFolderPrefix === "string" ? r.downloadFolderPrefix : DEFAULT_SETTINGS.downloadFolderPrefix,
    maxToolHops: normalizeMaxToolHops(r),
    actionLogEnabled: r.actionLogEnabled !== false,
    csvMaxChars: normalizeCsvMaxChars(r.csvMaxChars),
    autoApprove: r.autoApprove === true,
    showThinking: r.showThinking === true,
    rememberPages: r.rememberPages !== false,
    trustedInput: r.trustedInput === true,
    manualSites: normalizeManualSites(r.manualSites),
  };
}

// 저장할 값: 화면에서 고친 설정을 정리하고, 도구 호출 한도는 사용자가 고른 값임을 표시(maxToolHopsVersion)한다.
export function settingsForStorage(next: Settings): Settings {
  return {
    ...next,
    systemPrompt: next.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH),
    maxToolHops: normalizeMaxToolHops({ ...next, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }),
    maxToolHopsVersion: MAX_TOOL_HOPS_VERSION,
    csvMaxChars: normalizeCsvMaxChars(next.csvMaxChars),
    manualSites: normalizeManualSites(next.manualSites),
    apiKeys: stringFields(next.apiKeys, ["openai", "gemini"]),
    providerModels: stringFields(next.providerModels, ["openai", "gemini"]),
  };
}

// 객체에서 정해 둔 키의 문자열 값만 남긴다(앞뒤 공백 제거, 빈 값은 뺌).
function stringFields<K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  if (!v || typeof v !== "object") return out;
  for (const k of keys) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === "string" && x.trim()) out[k] = x.trim();
  }
  return out;
}

// 지금 쓸 제공자·키·모델(#97). 키가 없으면 apiKey는 빈 글자.
export function activeModel(s: Settings): { provider: ProviderId; apiKey: string; model: string } {
  if (s.provider === "gemini") {
    return { provider: "gemini", apiKey: s.apiKeys.gemini ?? "", model: s.providerModels.gemini || GEMINI_DEFAULT_MODEL };
  }
  if (s.provider === "openai") {
    return { provider: "openai", apiKey: s.apiKeys.openai ?? "", model: s.providerModels.openai || OPENAI_DEFAULT_MODEL };
  }
  return { provider: "openrouter", apiKey: s.openRouterApiKey, model: s.model };
}
