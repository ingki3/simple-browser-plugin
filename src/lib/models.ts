export const MODEL_IDS = [
  "deepseek/deepseek-v4-pro",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
] as const;

export type ModelId = string;

export const DEFAULT_MODEL: ModelId = "deepseek/deepseek-v4-pro";

export const MODEL_LABELS: Record<(typeof MODEL_IDS)[number], string> = {
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro (기본)",
  "google/gemini-3-flash-preview": "Google Gemini 3 Flash",
  "google/gemini-3.1-pro-preview": "Google Gemini 3.1 Pro",
  "google/gemini-3.1-flash-lite-preview": "Google Gemini 3.1 Flash Lite",
};

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
