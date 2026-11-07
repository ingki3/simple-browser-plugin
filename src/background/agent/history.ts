// 대화 기록 계산(#263 단계 2 — chatAgent.ts에서 그대로 옮김). 기록·기준을 인자로 받아 계산만 하고, 필드 대입은 ChatAgent가 한다.
import type { OpenRouterMessage } from "@/lib/openrouter";
import type { RebaseOffer } from "../tools/rowRebase";

// 요청에 실었던 결과의 기준 중 아직 pending인 것을 응답이 온 뒤 확정한다. 그 사이 기록을 비웠으면(새 pending 배열) 확정하지 않는다.
// 남은 pending을 새 배열로 돌려준다(ChatAgent가 대입). confirmed는 그 Map을 그대로 고친다 — ChatAgent가 같은 Map을 승인 전
// 대상 확인(buildToolPreview)에 넘기고 그쪽은 await 뒤에 읽으므로, 옮기기 전처럼 같은 객체를 유지한다.
export function confirmRebases(
  pending: readonly RebaseOffer[],
  confirmed: Map<string, string[]>,
  sent: readonly RebaseOffer[],
): RebaseOffer[] {
  const rest = [...pending];
  for (const offer of sent) {
    const at = rest.indexOf(offer);
    if (at < 0) continue;
    rest.splice(at, 1);
    const list = (confirmed.get(offer.id) ?? []).filter((n) => n !== offer.nonce);
    list.push(offer.nonce);
    if (list.length > 8) list.shift();
    confirmed.delete(offer.id);
    confirmed.set(offer.id, list);
    while (confirmed.size > 200) {
      const oldest = confirmed.keys().next().value;
      if (oldest === undefined) break;
      confirmed.delete(oldest);
    }
  }
  return rest;
}

// 중단된 턴이 tool_calls만 남기고 결과를 못 채웠으면 다음 요청이 API에서 거부된다.
// 빠진 결과를 "중단됨"으로 채워 기록을 유효하게 만든다. 채울 tool 메시지를 돌려준다(ChatAgent가 기록 끝에 넣는다).
export function closeDanglingToolCalls(history: readonly OpenRouterMessage[]): OpenRouterMessage[] {
  let at = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      at = i;
      break;
    }
  }
  const last = history[at];
  if (!last || last.role !== "assistant" || !last.tool_calls?.length) return [];
  // 그 호출 블록 뒤의 결과만 센다 — 모델이 앞 턴의 id(call_0 등)를 다시 쓰면 앞 결과를 이번 호출의 답으로 보지 않게(#221).
  const answered = new Set(
    history.slice(at + 1).flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
  );
  const fill: OpenRouterMessage[] = [];
  for (const call of last.tool_calls) {
    if (answered.has(call.id)) continue;
    fill.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content: JSON.stringify({ error: "interrupted" }),
    });
  }
  return fill;
}

// 대화 기록의 마지막 답(글자). 저장 카드 초안의 맥락으로 쓴다.
export function lastAnswerText(history: readonly OpenRouterMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}

// 기록의 start(이번 요청의 사용자 메시지) 뒤에서 도구 호출이 없는 마지막 답.
export function answerSince(history: readonly OpenRouterMessage[], start: number): string {
  for (let i = history.length - 1; i > start; i--) {
    const m = history[i];
    if (m.role === "user") break;
    if (m.role === "assistant" && !m.tool_calls?.length && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return "";
}
