// OpenAI 직접 연결 어댑터(#97 2단계). Chat Completions(api.openai.com)에 사용자의 OpenAI API 키로 보낸다.
// 내부 기준 형식(OpenAI 호환)과 거의 같고, 다음만 바꾼다:
// - 대화 기록에서 OpenAI가 받지 않는 필드(OpenRouter의 reasoning·reasoning_details·annotations, 도구 결과의 name)를 뺀다.
// - 응답 상한은 max_completion_tokens. 추론 모델(o 계열·gpt-5 계열)은 reasoning_effort로 생각 강도를 정하고 temperature를
//   보내지 않는다(받지 않음). 그 밖의 모델은 temperature만.
import type { OpenRouterMessage } from "../openrouter.ts";
import { chatJson, chatRequest, readOpenRouterStream } from "../openrouter.ts";
import type { ChatRequest, ProviderAdapter, ReasoningIntent } from "./types.ts";

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const LABEL = "OpenAI";

export const OPENAI_MODEL_SUGGESTIONS = ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini"] as const;
export const OPENAI_DEFAULT_MODEL = "gpt-5-mini";

// 추론 모델인지(모델 ID의 형태로만 — 요청 매개변수를 고르는 데 쓴다).
export function openAiReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

function effort(model: string, intent: ReasoningIntent): string {
  if (intent === "agent") return "medium";
  if (intent === "agent_low") return "low";
  // 생각이 필요 없는 짧은 JSON 호출: 모델 계열마다 받는 가장 낮은 값이 다르다 — gpt-5·gpt-5-mini·gpt-5-nano는 minimal,
  // gpt-5.1 같은 뒤 버전은 none, o 계열과 그 밖은 low(모두 받는 값).
  if (/^gpt-5(-|$)/i.test(model)) return "minimal";
  if (/^gpt-5\.\d/i.test(model)) return "none";
  return "low";
}

// 내부 기록 → OpenAI 메시지(받지 않는 필드를 뺀다).
// keepExtra: 도구 호출의 extra_content를 남길지(그것을 돌려받는 제공자 — Gemini).
export function openAiMessages(messages: OpenRouterMessage[], keepExtra = false): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const calls = m.tool_calls?.map(({ extra_content, ...c }) =>
        keepExtra && extra_content !== undefined ? { ...c, extra_content } : c,
      );
      return { role: "assistant", content: m.content, ...(calls?.length ? { tool_calls: calls } : {}) };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    return { role: m.role, content: m.content };
  });
}

export function openAiPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const reasoningModel = openAiReasoningModel(req.model);
  return {
    model: req.model,
    messages: openAiMessages(req.messages),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    ...(req.parallelToolCalls !== undefined && req.tools ? { parallel_tool_calls: req.parallelToolCalls } : {}),
    max_completion_tokens: req.maxTokens,
    ...(reasoningModel
      ? { reasoning_effort: effort(req.model, req.reasoning) }
      : req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

export const openAiAdapter: ProviderAdapter = {
  id: "openai",
  label: LABEL,
  async openStream(apiKey, req, signal) {
    const response = await chatRequest(OPENAI_CHAT_URL, { Authorization: `Bearer ${apiKey}` }, openAiPayload(req, true), signal, LABEL);
    return { read: (onChunk, inactivityMs) => readOpenRouterStream(response, onChunk, inactivityMs, LABEL) };
  },
  async complete(apiKey, req, signal) {
    const response = await chatRequest(OPENAI_CHAT_URL, { Authorization: `Bearer ${apiKey}` }, openAiPayload(req, false), signal, LABEL);
    const res = await chatJson<{ choices?: Array<{ message?: { content?: string | null } }> }>(response, LABEL);
    return res.choices?.[0]?.message?.content ?? "";
  },
};
