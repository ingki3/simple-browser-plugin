export const MODEL_IDS = [
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_MODEL: ModelId = "gemini-3-flash-preview";

export const MODEL_LABELS: Record<ModelId, string> = {
  "gemini-3-flash-preview": "Gemini 3 Flash (기본, 빠르고 균형)",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro (고품질, 느림)",
  "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite (초경량)",
};

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && (MODEL_IDS as readonly string[]).includes(value);
}
