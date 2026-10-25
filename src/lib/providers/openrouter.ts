// OpenRouter 어댑터(#97). 요청은 OpenAI 호환 Chat Completions 그대로이고, 생각 설정은 OpenRouter의 reasoning 필드로 보낸다.
import { agentReasoningConfig, agentRetryReasoningConfig, translationReasoningConfig, type ReasoningConfig } from "../models.ts";
import { openRouterJson, openRouterRequest, readOpenRouterStream } from "../openrouter.ts";
import type { ChatRequest, ProviderAdapter, ReasoningIntent } from "./types.ts";

export function openRouterReasoning(model: string, intent: ReasoningIntent): ReasoningConfig {
  if (intent === "agent") return agentReasoningConfig(model);
  if (intent === "agent_low") return agentRetryReasoningConfig(model);
  return translationReasoningConfig(model);
}

// 다른 제공자(Gemini)가 도구 호출에 붙인 값은 보내지 않는다(제공자가 바뀌면 기록을 새로 시작하지만 한 번 더 막는다).
function withoutExtraContent(messages: ChatRequest["messages"]): ChatRequest["messages"] {
  return messages.map((m) =>
    m.role === "assistant" && m.tool_calls?.some((c) => c.extra_content !== undefined)
      ? { ...m, tool_calls: m.tool_calls.map(({ extra_content: _x, ...c }) => c) }
      : m,
  );
}

// 내부 요청 → OpenRouter 요청 본문.
export function openRouterPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    messages: withoutExtraContent(req.messages),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    ...(req.parallelToolCalls !== undefined ? { parallel_tool_calls: req.parallelToolCalls } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    max_tokens: req.maxTokens,
    reasoning: openRouterReasoning(req.model, req.reasoning),
    ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
    // 엄격한 형식: 매개변수를 지키는 공급자만, 처리량 순으로 고르고 깨진 JSON은 보정받는다.
    ...(req.strictJson
      ? { plugins: [{ id: "response-healing" }], provider: { sort: "throughput", require_parameters: true } }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

export const openRouterAdapter: ProviderAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  async openStream(apiKey, req, signal) {
    const response = await openRouterRequest(apiKey, openRouterPayload(req, true), signal);
    return { read: (onChunk, inactivityMs) => readOpenRouterStream(response, onChunk, inactivityMs) };
  },
  async complete(apiKey, req, signal) {
    const res = await openRouterJson<{ choices?: Array<{ message?: { content?: string | null } }> }>(
      apiKey,
      openRouterPayload(req, false),
      signal,
    );
    return res.choices?.[0]?.message?.content ?? "";
  },
};
