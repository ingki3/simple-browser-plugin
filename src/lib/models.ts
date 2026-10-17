export const MODEL_IDS = [
  "deepseek/deepseek-v4-pro",
  "google/gemini-3.6-flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "openai/gpt-oss-120b",
] as const;

export type ModelId = string;

export const DEFAULT_MODEL: ModelId = "deepseek/deepseek-v4-pro";

export const MODEL_LABELS: Record<(typeof MODEL_IDS)[number], string> = {
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro (기본)",
  "google/gemini-3.6-flash": "Google Gemini 3.6 Flash",
  "google/gemini-3-flash-preview": "Google Gemini 3 Flash",
  "google/gemini-3.1-pro-preview": "Google Gemini 3.1 Pro",
  "google/gemini-3.1-flash-lite-preview": "Google Gemini 3.1 Flash Lite",
  "openai/gpt-oss-120b": "OpenAI gpt-oss-120b",
};

export interface ReasoningConfig {
  enabled?: boolean;
  effort?: "minimal" | "low" | "medium" | "high";
  exclude?: boolean;
  // 생각에 쓸 토큰 상한. effort와 함께 쓰지 않는다.
  max_tokens?: number;
}

// 에이전트 한 번의 응답 상한(요청의 max_tokens).
export const AGENT_MAX_TOKENS = 8192;
// 생각 상한. 응답 상한의 절반으로 묶어 답·도구 호출을 쓸 자리를 남긴다.
export const AGENT_REASONING_MAX_TOKENS = 4096;

function requiresExplicitEffort(model: ModelId): boolean {
  return /^google\/gemini-3(?:[.-]|$)/i.test(model);
}

export function agentReasoningConfig(model: ModelId): ReasoningConfig {
  if (requiresExplicitEffort(model)) return { effort: "medium" };
  if (/^openai\/gpt-oss-/i.test(model)) return { effort: "low" };
  return { max_tokens: AGENT_REASONING_MAX_TOKENS };
}

// 생각만 하다 응답 상한에 걸려 답이 비었을 때 한 번 더 시도할 설정. 상한을 지키지 않는 모델도 있어서 강도를 낮춘다.
export function agentRetryReasoningConfig(model: ModelId): ReasoningConfig {
  void model;
  return { effort: "low" };
}

export function translationReasoningConfig(model: ModelId): ReasoningConfig {
  if (requiresExplicitEffort(model)) return { effort: "minimal", exclude: true };
  if (/^openai\/gpt-oss-/i.test(model)) return { effort: "low", exclude: true };
  return { enabled: false, exclude: true };
}

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && /^[a-z0-9_.~-]+\/[a-z0-9_.:~-]+$/i.test(value);
}

export function normalizeModelId(value: unknown): ModelId {
  if (isModelId(value)) return value;
  if (typeof value === "string" && value.startsWith("gemini-")) {
    return `google/${value}`;
  }
  return DEFAULT_MODEL;
}
