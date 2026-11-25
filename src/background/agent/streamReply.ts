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

// 겹친 호출 id를 대신할 새 id: 원래 id와 같은 길이의 영숫자(일부 로컬 모델 템플릿은 정해진 길이의 영숫자 id만 받는다 — 예: 9자).
// 원래 id가 영숫자가 아니거나 너무 길거나(SAME_SHAPE_MAX), 정해진 시도 안에 겹치지 않는 id를 못 만들면(아주 짧은 id) UUID — 멈추거나
// 예외로 끝나지 않는다.
const SAME_SHAPE_MAX = 64;
const SAME_SHAPE_TRIES = 16;
function sameShapeId(original: string, used: ReadonlySet<string>): string {
  if (original.length > SAME_SHAPE_MAX || !/^[A-Za-z0-9]+$/.test(original)) return crypto.randomUUID();
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let i = 0; i < SAME_SHAPE_TRIES; i += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(original.length));
    const id = Array.from(bytes, (b) => chars[b % chars.length]).join("");
    if (!used.has(id)) return id;
  }
  return crypto.randomUUID();
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
      // 호출 id는 한 응답 안에서 하나씩이어야 결과와 짝지어진다(#318 — 모델이 같은 id를 두 번 주면 뒤의 것에 새 id를 준다.
      // 기록의 호출 블록과 결과가 모두 이 id를 쓰므로 제공자에는 짝이 맞는 기록이 간다).
      const used = new Set<string>();
      const functionCalls = [...functionCallParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => {
          const id = call.id && !used.has(call.id) ? call.id : call.id ? sameShapeId(call.id, used) : crypto.randomUUID();
          used.add(id);
          return { ...call, id };
        });
      return { assistantText, assistantReasoning, reasoningDetails, functionCalls, finishReason, chunkCount, textChars, thoughtChars };
    },
  };
}
