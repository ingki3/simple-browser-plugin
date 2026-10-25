// Gemini 직접 연결 어댑터(#97 3단계). Google AI Studio API 키로 Gemini API의 OpenAI 호환 엔드포인트에 보낸다.
// - 기록은 OpenAI 어댑터처럼 정리하되, 도구 호출의 extra_content(Gemini 3의 thought_signature)는 그대로 돌려준다
//   (돌려주지 않으면 다음 요청이 거부된다).
// - 생각 강도는 reasoning_effort(agent=medium, agent_low=low, off=minimal — OpenRouter에서 Gemini 3에 쓰던 값과 같게).
// - 응답 상한은 max_tokens. parallel_tool_calls는 보내지 않는다(호환 엔드포인트가 받지 않을 수 있음).
import { chatJson, chatRequest, readOpenRouterStream } from "../openrouter.ts";
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

function effort(intent: ReasoningIntent): string {
  if (intent === "agent") return "medium";
  if (intent === "agent_low") return "low";
  return "minimal";
}

export function geminiPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model,
    messages: openAiMessages(req.messages, true),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    max_tokens: req.maxTokens,
    reasoning_effort: effort(req.reasoning),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  label: LABEL,
  async openStream(apiKey, req, signal) {
    const response = await chatRequest(GEMINI_CHAT_URL, { Authorization: `Bearer ${apiKey}` }, geminiPayload(req, true), signal, LABEL);
    return { read: (onChunk, inactivityMs) => readOpenRouterStream(response, onChunk, inactivityMs, LABEL) };
  },
  async complete(apiKey, req, signal) {
    const response = await chatRequest(GEMINI_CHAT_URL, { Authorization: `Bearer ${apiKey}` }, geminiPayload(req, false), signal, LABEL);
    const res = await chatJson<{ choices?: Array<{ message?: { content?: string | null } }> }>(response, LABEL);
    return res.choices?.[0]?.message?.content ?? "";
  },
};
