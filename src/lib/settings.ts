// 설정의 기본값·읽기 정리·저장 정리를 한곳에 둔다. 백그라운드(storage.ts)·사이드 패널(useSettings)·옵션 페이지가 함께 써서,
// 새 설정을 넣을 때 세 곳이 따로 어긋나지 않게 한다.
import { normalizeManualSites } from "./manualSites.ts";
import { normalizeLoginSites } from "./loginPolicy.ts";
import { isProviderId, type ProviderId } from "./providers/types.ts";
import { OPENAI_DEFAULT_MODEL } from "./providers/openai.ts";
import { GEMINI_DEFAULT_MODEL } from "./providers/gemini.ts";
import { ANTHROPIC_DEFAULT_MODEL } from "./providers/anthropic.ts";
import { localEndpoint } from "./providers/local.ts";
import { DEFAULT_MODEL, normalizeModelId } from "./models.ts";
import {
  DEFAULT_CSV_MAX_CHARS,
  DEFAULT_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MAX_TOOL_HOPS_VERSION,
  normalizeCsvMaxChars,
  normalizeMaxToolHops,
  isRunMode,
  type Settings,
  type SettingsPatch,
} from "./messages.ts";
import { DEFAULT_VOICE_INPUT, mergeVoiceInput, normalizeVoiceInput } from "./voice.ts";

export const DEFAULT_SETTINGS: Settings = {
  provider: "openrouter",
  openRouterApiKey: "",
  apiKeys: {},
  providerModels: {},
  localServer: { baseUrl: "", model: "" },
  model: DEFAULT_MODEL,
  systemPrompt: "",
  translationTargetLang: "ko",
  downloadFolderPrefix: "simple-browser-plugin",
  maxToolHops: DEFAULT_MAX_TOOL_HOPS,
  actionLogEnabled: true,
  csvMaxChars: DEFAULT_CSV_MAX_CHARS,
  runMode: "ask",
  showThinking: false,
  quickThinking: false,
  rememberPages: true,
  pageSuggestions: true,
  trustedInput: false,
  manualSites: [],
  loginSites: [],
  voiceInput: DEFAULT_VOICE_INPUT,
};

// 저장소에서 읽은 값(없거나 일부만 있거나 형식이 틀릴 수 있음)을 완전한 설정으로 정리한다.
// 켜짐이 기본인 설정은 false일 때만 끄고, 꺼짐이 기본인 설정은 true일 때만 켠다.
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const r = raw ?? {};
  return {
    provider: isProviderId(r.provider) ? r.provider : DEFAULT_SETTINGS.provider,
    openRouterApiKey: typeof r.openRouterApiKey === "string" ? r.openRouterApiKey : DEFAULT_SETTINGS.openRouterApiKey,
    apiKeys: stringFields(r.apiKeys, ["openai", "gemini", "anthropic", "local"]),
    providerModels: stringFields(r.providerModels, ["openai", "gemini", "anthropic"]),
    localServer: normalizeLocalServer(r.localServer),
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
    // 예전 설정은 자동 실행 켜기(autoApprove)만 있었다.
    runMode: isRunMode(r.runMode) ? r.runMode : (r as { autoApprove?: unknown }).autoApprove === true ? "auto" : "ask",
    showThinking: r.showThinking === true,
    quickThinking: r.quickThinking === true,
    rememberPages: r.rememberPages !== false,
    pageSuggestions: r.pageSuggestions !== false,
    trustedInput: r.trustedInput === true,
    manualSites: normalizeManualSites(r.manualSites),
    loginSites: normalizeLoginSites(r.loginSites),
    voiceInput: normalizeVoiceInput(r.voiceInput),
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
    loginSites: normalizeLoginSites(next.loginSites),
    apiKeys: stringFields(next.apiKeys, ["openai", "gemini", "anthropic", "local"]),
    providerModels: stringFields(next.providerModels, ["openai", "gemini", "anthropic"]),
    localServer: normalizeLocalServer(next.localServer),
    voiceInput: normalizeVoiceInput(next.voiceInput),
  };
}

// 로컬 서버 설정: 문자열만, 길이 한도(주소 500자·모델 200자). 주소는 사용자가 쓴 그대로 둔다(편집 중 지우지 않게 — 쓸 때 검사).
function normalizeLocalServer(v: unknown): Settings["localServer"] {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    baseUrl: typeof r.baseUrl === "string" ? r.baseUrl.slice(0, 500) : "",
    model: typeof r.model === "string" ? r.model.trim().slice(0, 200) : "",
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

// 지금 쓸 제공자·키·모델(#97). 키가 없으면 apiKey는 빈 글자. ready: 요청을 보낼 수 있는지(키가 필요한 제공자는 키, local은 유효한 주소와
// 모델 — 키는 선택, #193). missing: 준비되지 않은 이유. baseUrl: local만(정규화한 주소, 유효하지 않으면 사용자가 쓴 값).
export type ActiveModel = {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  ready: boolean;
  missing: "key" | "endpoint" | "model" | null;
};

function keyed(provider: ProviderId, apiKey: string, model: string): ActiveModel {
  return { provider, apiKey, model, ready: !!apiKey, missing: apiKey ? null : "key" };
}

export function activeModel(s: Settings): ActiveModel {
  if (s.provider === "local") {
    const ep = localEndpoint(s.localServer.baseUrl);
    const model = s.localServer.model;
    const missing = !ep.ok ? "endpoint" : !model ? "model" : null;
    return { provider: "local", apiKey: s.apiKeys.local ?? "", model, baseUrl: ep.ok ? ep.base : s.localServer.baseUrl, ready: !missing, missing };
  }
  if (s.provider === "anthropic") return keyed("anthropic", s.apiKeys.anthropic ?? "", s.providerModels.anthropic || ANTHROPIC_DEFAULT_MODEL);
  if (s.provider === "gemini") return keyed("gemini", s.apiKeys.gemini ?? "", s.providerModels.gemini || GEMINI_DEFAULT_MODEL);
  if (s.provider === "openai") return keyed("openai", s.apiKeys.openai ?? "", s.providerModels.openai || OPENAI_DEFAULT_MODEL);
  return keyed("openrouter", s.openRouterApiKey, s.model);
}

// 보낼 대상의 식별(#193 — 대화·번역·보조 요청이 이 값이 바뀌면 멈춘다). 키도 포함하므로 저장·로그·content script로 보내지 않는다(비교에만).
export function targetKey(a: Pick<ActiveModel, "provider" | "apiKey" | "model" | "baseUrl">): string {
  return JSON.stringify([a.provider, a.apiKey, a.model, a.provider === "local" ? (a.baseUrl ?? "") : ""]);
}

// 바꾼 필드(patch)를 설정에 합친다(#99). 제공자별 키·모델(apiKeys·providerModels)은 한 단계 더 합쳐, 한 제공자의 값만 바꾼
// patch가 다른 제공자의 값을 되돌리지 않게 한다.
// 음성 입력(voiceInput)도 하위 필드만 합친다(#184).
export function mergeSettingsPatch(base: Settings, patch: SettingsPatch): Settings {
  return {
    ...base,
    ...patch,
    apiKeys: { ...base.apiKeys, ...(patch.apiKeys ?? {}) },
    providerModels: { ...base.providerModels, ...(patch.providerModels ?? {}) },
    localServer: { ...base.localServer, ...(patch.localServer ?? {}) },
    voiceInput: mergeVoiceInput(base.voiceInput, patch.voiceInput),
  };
}
