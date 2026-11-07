// 모델 응답 스트림 조각 누적(src/background/agent/streamReply.ts, #263 단계 3). 옮기기 전 requestModel 본문과 같은 결과·패널 조각 순서인지 고정한다.
// 제공자별 실제 모양은 어댑터의 변환기(Anthropic 이벤트 변환, Gemini 번호 매기기, 로컬 <think> 나누기)를 거친 조각으로 넣는다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const { createReplyAccumulator } = await import("../src/background/agent/streamReply.ts");
const { anthropicStreamConverter } = await import("../src/lib/providers/anthropic.ts");
const { geminiIndexer } = await import("../src/lib/providers/gemini.ts");
const { localStreamMapper } = await import("../src/lib/providers/local.ts");

// UUID 대역: result() 때만, id 없는 호출마다 한 번씩 불리는지 센다.
function withUuid(fn) {
  const original = globalThis.crypto.randomUUID;
  let n = 0;
  globalThis.crypto.randomUUID = () => `uuid-${++n}`;
  try {
    return fn(() => n);
  } finally {
    globalThis.crypto.randomUUID = original;
  }
}

// 조각 열을 넣고 결과·패널로 보낸 조각(assistant_chunk·thought_chunk 순서)·사용량을 돌려준다.
function run(chunks) {
  const sent = [];
  const acc = createReplyAccumulator({
    onText: (text) => sent.push({ kind: "assistant_chunk", text }),
    onThought: (text) => sent.push({ kind: "thought_chunk", text }),
  });
  for (const c of chunks) acc.onChunk(c);
  return { sent, usage: acc.usage(), result: acc.result() };
}

const d = (delta, finish_reason) => ({ choices: [{ delta, ...(finish_reason !== undefined ? { finish_reason } : {}) }] });
const text = (t) => ({ kind: "assistant_chunk", text: t });
const thought = (t) => ({ kind: "thought_chunk", text: t });

test("본문 조각: 받는 즉시 보내고 이어 붙인다, 빈 글·null·문자열 아닌 값은 건너뛴다", () => {
  const { sent, result } = run([d({ content: "안녕" }), d({ content: "" }), d({ content: null }), d({ content: 5 }), {}, { choices: [] }, d({ content: "하세요" })]);
  assert.deepEqual(sent, [text("안녕"), text("하세요")]);
  assert.equal(result.assistantText, "안녕하세요");
  assert.equal(result.textChars, 5);
  assert.equal(result.chunkCount, 7, "빈 조각도 센다");
  assert.equal(result.thoughtChars, 0);
  assert.deepEqual(result.functionCalls, []);
  assert.equal(result.finishReason, undefined);
});

test("도구 인자: index별로 이어 붙이고 index 순으로 정렬, id·이름도 이어 붙인다", () => {
  withUuid((count) => {
    const { result, sent } = run([
      d({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "find_", arguments: '{"q"' } }] }),
      d({ tool_calls: [{ index: 0, id: "a", function: { name: "describe_page", arguments: "" } }] }),
      d({ tool_calls: [{ index: 1, id: "2", function: { name: "clickables", arguments: ':"x"}' } }] }),
      d({ tool_calls: [{ index: 0, function: { arguments: "{}" } }, { index: 1 }] }),
    ]);
    assert.deepEqual(sent, []);
    assert.deepEqual(result.functionCalls, [
      { id: "a", type: "function", function: { name: "describe_page", arguments: "{}" } },
      { id: "b2", type: "function", function: { name: "find_clickables", arguments: '{"q":"x"}' } },
    ]);
    assert.equal(count(), 0, "id가 있으면 UUID를 만들지 않는다");
  });
});

test("id 없는 호출: result() 때 호출마다 UUID 한 번(조각 처리 중에는 만들지 않음), 정렬 순서대로", () => {
  withUuid((count) => {
    const sent = [];
    const acc = createReplyAccumulator({ onText: (t) => sent.push(t), onThought: (t) => sent.push(t) });
    acc.onChunk(d({ tool_calls: [{ index: 2, function: { name: "c", arguments: "{}" } }] }));
    acc.onChunk(d({ tool_calls: [{ index: 0, function: { name: "a", arguments: "{}" } }] }));
    acc.onChunk(d({ tool_calls: [{ index: 1, id: "has", function: { name: "b", arguments: "{}" } }] }));
    assert.equal(count(), 0);
    const r = acc.result();
    assert.equal(count(), 2);
    assert.deepEqual(r.functionCalls.map((c) => [c.id, c.function.name]), [["uuid-1", "a"], ["has", "b"], ["uuid-2", "c"]]);
  });
});

test("extra_content(Gemini 서명): 받은 값을 남기고, 나중 값이 덮으며, 없는 조각은 지우지 않는다", () => {
  const sig = { google: { thought_signature: "SIG1" } };
  const { result } = run([
    d({ tool_calls: [{ index: 0, id: "g", function: { name: "describe_page", arguments: "" }, extra_content: sig }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
    d({ tool_calls: [{ index: 1, id: "h", function: { name: "x", arguments: "{}" }, extra_content: null }] }),
    d({ tool_calls: [{ index: 2, id: "i", function: { name: "y", arguments: "{}" }, extra_content: 1 }] }),
    d({ tool_calls: [{ index: 2, extra_content: 2 }] }),
  ]);
  assert.equal(result.functionCalls[0].extra_content, sig, "같은 객체를 그대로");
  assert.equal("extra_content" in result.functionCalls[1], true);
  assert.equal(result.functionCalls[1].extra_content, null);
  assert.equal(result.functionCalls[2].extra_content, 2);
  const plain = run([d({ tool_calls: [{ index: 0, id: "p", function: { name: "n", arguments: "{}" } }] })]).result.functionCalls[0];
  assert.equal("extra_content" in plain, false, "없으면 키를 만들지 않는다");
});

test("생각: reasoning 문자열은 details가 없을 때만 보이고, details가 있으면 기록만 한다", () => {
  const { sent, result } = run([
    d({ reasoning: "생각1" }),
    d({ reasoning: "숨김", reasoning_details: [{ type: "reasoning.text", text: "보임" }] }),
    d({ reasoning: "생각2", reasoning_details: [] }),
    d({ reasoning: "" }),
    d({ reasoning: null }),
  ]);
  assert.deepEqual(sent, [thought("생각1"), thought("보임"), thought("생각2")]);
  assert.equal(result.assistantReasoning, "생각1숨김생각2", "보내지 않은 reasoning도 기록에는 이어 붙인다");
  assert.equal(result.thoughtChars, 3 + 2 + 3);
  assert.deepEqual(result.reasoningDetails, [{ type: "reasoning.text", text: "보임" }]);
});

test("reasoning_details: text 우선, 없으면 summary, 그 밖·빈 글은 보내지 않되 모두 기록한다", () => {
  const details = [
    { type: "reasoning.text", text: "가", summary: "무시" },
    { type: "reasoning.summary", summary: "나다" },
    { type: "reasoning.encrypted", data: "xx" },
    { type: "reasoning.text", text: "" },
    { type: "reasoning.text", text: 3, summary: "라" },
    null,
    "문자열",
    7,
  ];
  const { sent, result } = run([d({ reasoning_details: details.slice(0, 4) }), d({ reasoning_details: details.slice(4) })]);
  assert.deepEqual(sent, [thought("가"), thought("나다"), thought("라")]);
  assert.equal(result.thoughtChars, 4);
  assert.deepEqual(result.reasoningDetails, details);
  assert.equal(result.reasoningDetails[0], details[0], "객체를 복사하지 않는다");
  assert.equal(result.assistantReasoning, "");
});

test("한 조각 안의 보내기 순서: 본문 → reasoning → details 순", () => {
  const { sent } = run([d({ reasoning_details: [{ text: "D1" }, { summary: "D2" }], reasoning: "R", content: "C" }), d({ reasoning: "R2", content: "C2" })]);
  assert.deepEqual(sent, [text("C"), thought("D1"), thought("D2"), text("C2"), thought("R2")]);
});

test("사용량: 마지막 값, 읽을 수 없는 사용량 조각은 앞 값을 지우지 않는다, usage()는 언제든 읽힌다", () => {
  const acc = createReplyAccumulator({ onText() {}, onThought() {} });
  assert.equal(acc.usage(), null);
  acc.onChunk({ usage: { prompt_tokens: 10, completion_tokens: 1 } });
  assert.deepEqual(acc.usage(), { input: 10, output: 1 });
  acc.onChunk({ usage: { foo: 1 } });
  acc.onChunk({ usage: null });
  assert.deepEqual(acc.usage(), { input: 10, output: 1 });
  acc.onChunk({ usage: { prompt_tokens: 12, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } }, choices: [] });
  assert.deepEqual(acc.usage(), { input: 12, output: 5, cachedInput: 4, reasoning: 2 });
  assert.equal(acc.result().chunkCount, 4);
});

test("finish_reason: 마지막 비지 않은 값, null·빈 값은 덮지 않는다", () => {
  assert.equal(run([d({}, "tool_calls"), d({}, null), d({}, "")]).result.finishReason, "tool_calls");
  assert.equal(run([d({}, "stop"), d({}, "length")]).result.finishReason, "length");
});

test("보내기가 던지면 그 자리에서 멈춘다(앞 누적은 남음)", () => {
  const acc = createReplyAccumulator({
    onText: () => {
      throw new Error("send");
    },
    onThought() {},
  });
  assert.throws(() => acc.onChunk(d({ content: "가", reasoning: "생각" }, "stop")), /send/);
  const r = acc.result();
  assert.equal(r.assistantText, "가");
  assert.equal(r.textChars, 1);
  assert.equal(r.assistantReasoning, "", "던진 뒤의 생각은 처리하지 않는다");
  assert.equal(r.finishReason, undefined);
  assert.equal(r.chunkCount, 1);
});

test("결과는 같은 reasoningDetails 배열, 도구 호출은 얕은 복사(function은 공유)", () => {
  const acc = createReplyAccumulator({ onText() {}, onThought() {} });
  acc.onChunk(d({ reasoning_details: [{ text: "a" }], tool_calls: [{ index: 0, id: "x", function: { name: "n", arguments: "{}" } }] }));
  const r1 = acc.result();
  const r2 = acc.result();
  assert.equal(r1.reasoningDetails, r2.reasoningDetails);
  assert.notEqual(r1.functionCalls[0], r2.functionCalls[0]);
  assert.equal(r1.functionCalls[0].function, r2.functionCalls[0].function);
});

// --- 제공자별 실제 조각 모양 ---

test("OpenRouter: reasoning과 reasoning_details가 같은 조각에 오면 details만 보인다, 마지막 사용량 조각", () => {
  const { sent, result, usage } = run([
    d({ reasoning: "음", reasoning_details: [{ type: "reasoning.text", text: "음", format: "anthropic-claude-v1", index: 0 }] }),
    d({ reasoning: null, reasoning_details: [{ type: "reasoning.encrypted", data: "ENC", index: 1 }] }),
    d({ content: "확인", reasoning: null }),
    d({ tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "describe_page", arguments: "" } }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] }),
    d({}, "tool_calls"),
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } },
  ]);
  assert.deepEqual(sent, [thought("음"), text("확인")]);
  assert.equal(result.assistantReasoning, "음");
  assert.equal(result.reasoningDetails.length, 2);
  assert.deepEqual(result.functionCalls, [{ id: "toolu_1", type: "function", function: { name: "describe_page", arguments: '{"a":1}' } }]);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(usage, { input: 100, output: 20, cachedInput: 50 });
});

test("OpenAI: 생각 없이 본문·도구, usage만 있는 마지막 조각(choices 빈 배열)", () => {
  const { sent, result, usage } = run([
    d({ role: "assistant", content: "" }),
    d({ content: "네" }),
    d({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "find_clickables", arguments: "" } }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }),
    d({ tool_calls: [{ index: 0, function: { arguments: '"배송"}' } }] }),
    d({}, "tool_calls"),
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 } } },
  ]);
  assert.deepEqual(sent, [text("네")]);
  assert.equal(result.functionCalls[0].function.arguments, '{"query":"배송"}');
  assert.equal(result.chunkCount, 7);
  assert.deepEqual(usage, { input: 7, output: 3 });
});

test("Gemini: index 없는 도구 조각(번호 매기기 뒤)·extra_content 서명·id 없음 → UUID", () => {
  withUuid((count) => {
    const ix = geminiIndexer();
    const sig = { google: { thought_signature: "G-SIG" } };
    const raw = [
      d({ reasoning: "**계획**" }),
      d({ tool_calls: [{ function: { name: "describe_page", arguments: "{}" }, extra_content: sig }] }),
      d({ tool_calls: [{ function: { name: "find_clickables", arguments: '{"q":"a"}' } }] }),
      d({ tool_calls: [{ function: { arguments: "" } }] }),
      { ...d({}, "tool_calls"), usage: { prompt_tokens: 9, completion_tokens: 4 } },
    ];
    const { sent, result, usage } = run(raw.map(ix));
    assert.deepEqual(sent, [thought("**계획**")]);
    assert.deepEqual(result.functionCalls, [
      { id: "uuid-1", type: "function", function: { name: "describe_page", arguments: "{}" }, extra_content: sig },
      { id: "uuid-2", type: "function", function: { name: "find_clickables", arguments: '{"q":"a"}' } },
    ]);
    assert.equal(count(), 2);
    assert.deepEqual(usage, { input: 9, output: 4 });
  });
});

test("Claude(Anthropic 변환기): 생각 조각은 보이고, 마지막 anthropic.content details는 보이지 않으며 기록에 남는다", () => {
  const conv = anthropicStreamConverter();
  const evs = [
    { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 2 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "음" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "보자" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "find_clickables" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_10", name: "describe_page" } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
    { type: "message_stop" },
  ];
  const { sent, result, usage } = run(evs.flatMap(conv));
  assert.deepEqual(sent, [thought("음"), text("보자")]);
  assert.equal(result.assistantReasoning, "음");
  assert.equal(result.assistantText, "보자");
  assert.equal(result.reasoningDetails.length, 1);
  assert.equal(result.reasoningDetails[0].type, "anthropic.content");
  assert.deepEqual(result.functionCalls, [
    { id: "toolu_9", type: "function", function: { name: "find_clickables", arguments: '{"q":"a"}' } },
    { id: "toolu_10", type: "function", function: { name: "describe_page", arguments: "{}" } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.thoughtChars, 1);
  assert.deepEqual(usage, { input: 7, output: 30, cachedInput: 2 }, "prompt_tokens = 입력 + 캐시 읽기 + 캐시 쓰기");
});

test("로컬: <think> 태그·reasoning_content를 생각으로, 갈라진 태그, flush 조각까지", () => {
  const m = localStreamMapper();
  const raw = [
    d({ content: "<thi" }),
    d({ content: "nk>생각 중" }),
    d({ content: "</th" }),
    d({ content: "ink>\n답" }),
    d({ reasoning_content: "추가" }),
    d({ tool_calls: [{ id: "c1", function: { name: "describe_page" } }] }),
    d({ tool_calls: [{ function: { arguments: "{}" } }] }),
    { ...d({}, "stop"), usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ];
  const { sent, result, usage } = run([...raw.flatMap((c) => m.map(c)), ...m.flush()]);
  assert.equal(result.assistantText, "답");
  assert.equal(result.assistantReasoning, "생각 중추가");
  // 태그 뒤 첫 글자를 붙잡아 두었다가 다음 조각에서 본문과 함께 낸다 — 한 조각 안에서는 본문이 생각보다 먼저 보인다.
  assert.deepEqual(sent, [thought("생"), text("답"), thought("각 중"), thought("추가")]);
  assert.deepEqual(result.functionCalls, [{ id: "c1", type: "function", function: { name: "describe_page", arguments: "{}" } }]);
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(usage, { input: 3, output: 2 });
});
