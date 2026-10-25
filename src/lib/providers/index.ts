// 제공자 어댑터 목록(#97).
import { anthropicAdapter } from "./anthropic.ts";
import { geminiAdapter } from "./gemini.ts";
import { openAiAdapter } from "./openai.ts";
import { openRouterAdapter } from "./openrouter.ts";
import type { ProviderAdapter, ProviderId } from "./types.ts";

export type { ChatRequest, ChatStream, ProviderAdapter, ProviderId, ReasoningIntent } from "./types.ts";
export { PROVIDER_IDS, isProviderId } from "./types.ts";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openrouter: openRouterAdapter,
  openai: openAiAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
};

export function providerAdapter(id: ProviderId = "openrouter"): ProviderAdapter {
  return ADAPTERS[id];
}
