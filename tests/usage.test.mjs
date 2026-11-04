// 토큰 사용량(#126): 스트림 usage 읽기·표시·합계, 제공자별 요청·변환.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addUsage, emptyUsageTotal, formatTurnUsage, formatUsage, usageFromChunk } from "../src/lib/usage.ts";
import { openAiPayload } from "../src/lib/providers/openai.ts";
import { geminiPayload } from "../src/lib/providers/gemini.ts";
import { anthropicStreamConverter } from "../src/lib/providers/anthropic.ts";

test("usageFromChunk: OpenAI 형식을 읽고, 숫자가 아닌 값·음수는 버린다", () => {
  assert.deepEqual(
    usageFromChunk({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 12 } }),
    { input: 120, output: 30, cachedInput: 100, reasoning: 12 },
  );
  assert.deepEqual(usageFromChunk({ prompt_tokens: 5, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 3 } }), { input: 5, output: 0, cacheWrite: 3 });
  assert.deepEqual(usageFromChunk({ completion_tokens: 7 }), { input: 0, output: 7 });
  assert.equal(usageFromChunk({}), null);
  assert.equal(usageFromChunk(null), null);
  assert.equal(usageFromChunk({ prompt_tokens: "10", completion_tokens: -1 }), null);
  assert.deepEqual(usageFromChunk({ prompt_tokens: 10, completion_tokens: 1.5, prompt_tokens_details: null }), { input: 10, output: 0 });
});

test("formatUsage: 캐시·생각을 괄호로, 없으면 사용량 없음(추정하지 않음)", () => {
  assert.equal(formatUsage({ input: 12345, output: 456, cachedInput: 8000, cacheWrite: 100, reasoning: 120 }, 3240), "입력 12,345(캐시 읽기 8,000·쓰기 100) · 출력 456(생각 120) · 3.2s");
  assert.equal(formatUsage({ input: 10, output: 2 }, 50), "입력 10 · 출력 2 · 0.1s");
  assert.equal(formatUsage(null, 1500), "사용량 없음 · 1.5s");
});

test("addUsage·formatTurnUsage: 호출 수, 사용량 없는 호출, 대화 누계", () => {
  const turn = emptyUsageTotal();
  const conv = emptyUsageTotal();
  for (const u of [{ input: 1000, output: 10, cachedInput: 800 }, null, { input: 2000, output: 20, reasoning: 5 }]) {
    addUsage(turn, u);
    addUsage(conv, u);
  }
  addUsage(conv, { input: 500, output: 5 });
  assert.deepEqual(turn, { calls: 3, missing: 1, input: 3000, output: 30, cachedInput: 800, cacheWrite: 0, reasoning: 5 });
  assert.equal(formatTurnUsage(turn, 12400, conv), "호출 3(사용량 없음 1) · 입력 3,000(캐시 읽기 800) · 출력 30(생각 5) · 12.4s · 대화 누계 입력 3,500 · 출력 35");
});

test("요청: OpenAI 스트림만 include_usage, Gemini 호환 엔드포인트에는 보내지 않는다", () => {
  const req = { model: "gpt-5-mini", messages: [{ role: "user", content: "q" }], maxTokens: 10, reasoning: "agent" };
  assert.deepEqual(openAiPayload(req, true).stream_options, { include_usage: true });
  assert.equal("stream_options" in openAiPayload(req, false), false);
  assert.equal("stream_options" in geminiPayload({ ...req, model: "gemini-3.6-flash" }, true), false);
});

test("Anthropic 변환기: message_start 입력(캐시 포함)과 마지막 message_delta 출력을 usage 조각으로", () => {
  const conv = anthropicStreamConverter();
  const out = [
    { type: "message_start", message: { usage: { input_tokens: 30, cache_read_input_tokens: 900, cache_creation_input_tokens: 70, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: {}, usage: { output_tokens: 15 } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
  ].flatMap((e) => conv(e));
  const usages = out.filter((c) => c.usage).map((c) => usageFromChunk(c.usage));
  // message_start에서 입력(끊겨도 남게), message_delta마다 누적 값 — 백그라운드는 마지막 것만 쓴다(더하지 않음).
  assert.deepEqual(usages[0], { input: 1000, output: 1, cachedInput: 900, cacheWrite: 70 });
  assert.deepEqual(usages.at(-1), { input: 1000, output: 42, cachedInput: 900, cacheWrite: 70 });
  assert.equal(usages.length, 3);
  // usage 조각에는 choices가 없다.
  assert.ok(out.filter((c) => c.usage).every((c) => !c.choices));
  // 사용량을 받지 못한 스트림은 usage 조각을 만들지 않는다(가짜 0을 만들지 않음).
  const bare = anthropicStreamConverter();
  const none = [{ type: "message_start", message: {} }, { type: "message_delta", delta: { stop_reason: "end_turn" } }].flatMap((e) => bare(e));
  assert.equal(none.some((c) => c.usage), false);
});
