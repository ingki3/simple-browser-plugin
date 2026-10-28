// 제공자별 키 발급·요금·사용량 안내 주소(#129). 첫 화면과 설정의 시작하기에서 함께 쓴다.
import type { ProviderId } from "./providers/types.ts";

export interface ProviderLinks {
  label: string;
  keyUrl: string;
  pricingUrl: string;
  usageUrl: string;
}

export const PROVIDER_LINKS: Record<ProviderId, ProviderLinks> = {
  openrouter: {
    label: "OpenRouter",
    keyUrl: "https://openrouter.ai/keys",
    pricingUrl: "https://openrouter.ai/models",
    usageUrl: "https://openrouter.ai/activity",
  },
  openai: {
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    pricingUrl: "https://openai.com/api/pricing/",
    usageUrl: "https://platform.openai.com/usage",
  },
  gemini: {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    usageUrl: "https://aistudio.google.com/",
  },
  anthropic: {
    label: "Anthropic Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    pricingUrl: "https://www.anthropic.com/pricing#api",
    usageUrl: "https://console.anthropic.com/usage",
  },
};
