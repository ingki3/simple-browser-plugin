// Gemini 직접 연결 어댑터(#97 3단계). Google AI Studio API 키로 Gemini API의 OpenAI 호환 엔드포인트에 보낸다.
// - 기록은 OpenAI 어댑터처럼 정리하되, 도구 호출의 extra_content(Gemini 3의 thought_signature)는 그대로 돌려준다
//   (돌려주지 않으면 다음 요청이 거부된다).
// - 생각 강도는 reasoning_effort(agent=medium, agent_low=low, off=minimal — OpenRouter에서 Gemini 3에 쓰던 값과 같게).
// - 응답 상한은 max_tokens. parallel_tool_calls는 보내지 않는다(호환 엔드포인트가 받지 않을 수 있음).
import { chatJson, chatRequest, readOpenRouterStream, type OpenRouterStreamChunk } from "../openrouter.ts";
import { openAiMessages } from "./openai.ts";
import type { ChatRequest, ProviderAdapter, ReasoningIntent } from "./types.ts";

export const GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const LABEL = "Gemini";

export const GEMINI_MODEL_SUGGESTIONS = [
  "gemini-3.6-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
] as const;
export const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";

function effort(model: string, intent: ReasoningIntent): string {
  if (intent === "agent") return "medium";
  if (intent === "agent_low") return "low";
  // 생각이 필요 없는 짧은 JSON 호출: Pro 모델은 minimal을 받지 않아 low가 가장 낮다.
  return /pro/i.test(model) ? "low" : "minimal";
}

// 호환 엔드포인트는 파일 조각(PDF)을 받지 않는다. 기록에 남아 있으면 안내 글자로 바꿔 보낸다(새 첨부는 하지 않는다).
function withoutFileParts(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((m) =>
    Array.isArray(m.content) && m.content.some((p: { type?: string }) => p?.type === "file")
      ? {
          ...m,
          content: m.content.map((p: { type?: string }) =>
            p?.type === "file" ? { type: "text", text: "[첨부 파일은 이 제공자로 보내지 않았습니다]" } : p,
          ),
        }
      : m,
  );
}

// 스트림 도구 호출 조각에 index가 없으면(Gemini가 생략할 수 있다) 호출마다 번호를 매긴다: id나 이름이 있는 조각은 새 호출,
// 없으면 앞 호출의 이어지는 조각.
export function geminiIndexer(): (chunk: OpenRouterStreamChunk) => OpenRouterStreamChunk {
  let next = 0;
  let last = -1;
  return (chunk) => {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta?.tool_calls?.length) return chunk;
    const calls = delta.tool_calls.map((c) => {
      if (typeof c.index === "number") {
        last = c.index;
        next = Math.max(next, c.index + 1);
        return c;
      }
      const fresh = !!c.id || !!c.function?.name || last < 0;
      const index = fresh ? next++ : last;
      last = index;
      return { ...c, index };
    });
    return { ...chunk, choices: [{ ...chunk.choices![0], delta: { ...delta, tool_calls: calls } }] };
  };
}

export function geminiPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    messages: withoutFileParts(openAiMessages(req.messages, true)),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    max_tokens: req.maxTokens,
    reasoning_effort: effort(req.model, req.reasoning),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  label: LABEL,
  supportsFileParts: false,
  async openStream(apiKey, req, signal) {
    const response = await chatRequest(GEMINI_CHAT_URL, { Authorization: `Bearer ${apiKey}` }, geminiPayload(req, true), signal, LABEL);
    const index = geminiIndexer();
    return { read: (onChunk, inactivityMs) => readOpenRouterStream(response, (c) => onChunk(index(c)), inactivityMs, LABEL) };
  },
  async complete(apiKey, req, signal) {
    const response = await chatRequest(GEMINI_CHAT_URL, { Authorization: `Bearer ${apiKey}` }, geminiPayload(req, false), signal, LABEL);
    const res = await chatJson<{ choices?: Array<{ message?: { content?: string | null } }> }>(response, LABEL);
    return res.choices?.[0]?.message?.content ?? "";
  },
};
