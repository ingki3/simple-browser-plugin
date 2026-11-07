// 모델 응답 스트림 조각 누적(#263 단계 3). ChatAgent.requestModel이 stream.read에 넘기던 조각 처리와 다 받은 뒤의 도구 호출 정리를
// 옮겼다. 대상 확인·중단·거두기·stale 확인·사용량 기록(recordUsage)·연결 타이머는 ChatAgent에 남는다. 이 모듈은 상태를 두지 않고
// 호출마다 새 누적기를 만든다. 조각 처리 안에는 기다림이 없다(조각마다 동기로 끝난다).
import type { OpenRouterStreamChunk, OpenRouterToolCall } from "@/lib/openrouter";
import { usageFromChunk, type ModelUsage } from "@/lib/usage";

export interface StreamReplyResult {
  assistantText: string;
  assistantReasoning: string;
  reasoningDetails: unknown[];
  // index 순서로 정렬, id가 비었으면 이때 UUID를 단다(result()를 부를 때마다 새로 만든다 — 한 번만 부른다).
  functionCalls: OpenRouterToolCall[];
  finishReason: string | undefined;
  chunkCount: number;
  textChars: number;
  thoughtChars: number;
}

export interface ReplyAccumulator {
  // stream.read에 그대로 넘긴다. 보이는 글은 받는 즉시 onText·onThought로 보낸다.
  onChunk(chunk: OpenRouterStreamChunk): void;
  // 지금까지 받은 마지막 사용량(끊긴 경우에도 남기려고 따로 읽는다).
  usage(): ModelUsage | null;
  result(): StreamReplyResult;
}

export function createReplyAccumulator(cb: { onText: (text: string) => void; onThought: (text: string) => void }): ReplyAccumulator {
  let usage: ModelUsage | null = null;
  let assistantText = "";
  let assistantReasoning = "";
  const reasoningDetails: unknown[] = [];
  const functionCallParts = new Map<number, OpenRouterToolCall>();
  let chunkCount = 0;
  let textChars = 0;
  let thoughtChars = 0;
  let finishReason: string | undefined;
  return {
    onChunk(chunk) {
      chunkCount += 1;
      // 사용량은 마지막에 받은 값(누적)을 쓴다.
      if (chunk.usage) usage = usageFromChunk(chunk.usage) ?? usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content) {
        assistantText += delta.content;
        textChars += delta.content.length;
        cb.onText(delta.content);
      }
      if (typeof delta?.reasoning === "string" && delta.reasoning) {
        assistantReasoning += delta.reasoning;
        if (!delta.reasoning_details?.length) {
          thoughtChars += delta.reasoning.length;
          cb.onThought(delta.reasoning);
        }
      }
      for (const detail of delta?.reasoning_details ?? []) {
        reasoningDetails.push(detail);
        if (!detail || typeof detail !== "object") continue;
        const item = detail as { text?: unknown; summary?: unknown };
        const visible =
          typeof item.text === "string"
            ? item.text
            : typeof item.summary === "string"
              ? item.summary
              : "";
        if (visible) {
          thoughtChars += visible.length;
          cb.onThought(visible);
        }
      }
      for (const part of delta?.tool_calls ?? []) {
        const current = functionCallParts.get(part.index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (part.id) current.id += part.id;
        if (part.function?.name) current.function.name += part.function.name;
        if (part.function?.arguments) {
          current.function.arguments += part.function.arguments;
        }
        // 다음 요청에 돌려줘야 하는 제공자 값(Gemini thought_signature)은 그대로 둔다.
        if (part.extra_content !== undefined) current.extra_content = part.extra_content;
        functionCallParts.set(part.index, current);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    },
    usage: () => usage,
    result() {
      const functionCalls = [...functionCallParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          ...call,
          id: call.id || crypto.randomUUID(),
        }));
      return { assistantText, assistantReasoning, reasoningDetails, functionCalls, finishReason, chunkCount, textChars, thoughtChars };
    },
  };
}
