// 제공자 어댑터 목록(#97).
import { anthropicAdapter } from "./anthropic.ts";
import { geminiAdapter } from "./gemini.ts";
import { openAiAdapter } from "./openai.ts";
import { openRouterAdapter } from "./openrouter.ts";
import { localAdapter } from "./local.ts";
import type { ProviderAdapter, ProviderId } from "./types.ts";

export type { ChatRequest, ChatStream, ProviderAdapter, ProviderAuth, ProviderId, ReasoningIntent } from "./types.ts";
export { PROVIDER_IDS, isProviderId } from "./types.ts";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  openrouter: openRouterAdapter,
  openai: openAiAdapter,
  gemini: geminiAdapter,
  anthropic: anthropicAdapter,
  local: localAdapter,
};

export function providerAdapter(id: ProviderId = "openrouter"): ProviderAdapter {
  return ADAPTERS[id];
}

// 제공자에 맞춘 제한 시간(#193): 로컬 서버는 모델을 처음 올릴 때 첫 응답이 느려 배수를 곱한다.
export function providerTimeout(id: ProviderId, ms: number): number {
  return ms * ADAPTERS[id].timeoutScale;
}
