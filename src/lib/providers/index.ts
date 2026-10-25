// 제공자 어댑터 목록(#97). 지금은 OpenRouter 하나다.
import { openRouterAdapter } from "./openrouter.ts";
import type { ProviderAdapter, ProviderId } from "./types.ts";

export type { ChatRequest, ChatStream, ProviderAdapter, ProviderId, ReasoningIntent } from "./types.ts";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openrouter: openRouterAdapter,
};

export function providerAdapter(id: ProviderId = "openrouter"): ProviderAdapter {
  return ADAPTERS[id];
}
