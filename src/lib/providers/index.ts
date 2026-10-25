// 제공자 어댑터 목록(#97).
import { openAiAdapter } from "./openai.ts";
import { openRouterAdapter } from "./openrouter.ts";
import type { ProviderAdapter, ProviderId } from "./types.ts";

export type { ChatRequest, ChatStream, ProviderAdapter, ProviderId, ReasoningIntent } from "./types.ts";
export { PROVIDER_IDS, isProviderId } from "./types.ts";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openrouter: openRouterAdapter,
  openai: openAiAdapter,
};

export function providerAdapter(id: ProviderId = "openrouter"): ProviderAdapter {
  return ADAPTERS[id];
}
