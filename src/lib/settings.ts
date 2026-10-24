// 설정의 기본값·읽기 정리·저장 정리를 한곳에 둔다. 백그라운드(storage.ts)·사이드 패널(useSettings)·옵션 페이지가 함께 써서,
// 새 설정을 넣을 때 세 곳이 따로 어긋나지 않게 한다.
import { normalizeManualSites } from "./manualSites.ts";
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
  trustedInput: false,
  manualSites: [],
};

// 저장소에서 읽은 값(없거나 일부만 있거나 형식이 틀릴 수 있음)을 완전한 설정으로 정리한다.
// 켜짐이 기본인 설정은 false일 때만 끄고, 꺼짐이 기본인 설정은 true일 때만 켠다.
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const r = raw ?? {};
  return {
    openRouterApiKey: typeof r.openRouterApiKey === "string" ? r.openRouterApiKey : DEFAULT_SETTINGS.openRouterApiKey,
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
  };
}
