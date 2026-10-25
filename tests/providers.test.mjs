import { test } from "node:test";
import assert from "node:assert/strict";
import { openRouterPayload } from "../src/lib/providers/openrouter.ts";
import { agentReasoningConfig, agentRetryReasoningConfig, translationReasoningConfig, AGENT_MAX_TOKENS } from "../src/lib/models.ts";

const msgs = [{ role: "user", content: "hi" }];
const tools = [{ type: "function", function: { name: "describe_page" } }];

test("OpenRouter 어댑터: 에이전트 스트림 요청 본문이 예전과 같다", () => {
  for (const [intent, cfg] of [["agent", agentReasoningConfig], ["agent_low", agentRetryReasoningConfig]]) {
    for (const model of ["deepseek/deepseek-v4-pro", "google/gemini-3.6-flash", "openai/gpt-oss-120b"]) {
      const body = openRouterPayload(
        { model, messages: msgs, tools, toolChoice: "auto", parallelToolCalls: false, reasoning: intent, maxTokens: AGENT_MAX_TOKENS },
        true,
      );
      assert.deepEqual(body, {
        model,
        messages: msgs,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_tokens: AGENT_MAX_TOKENS,
        reasoning: cfg(model),
        stream: true,
      });
    }
  }
});

test("OpenRouter 어댑터: 번역(엄격 JSON)·초안 요청 본문이 예전과 같다", () => {
  const fmt = { type: "json_schema", json_schema: { name: "x" } };
  const model = "google/gemini-3.6-flash";
  assert.deepEqual(
    openRouterPayload({ model, messages: msgs, temperature: 0, maxTokens: 2048, reasoning: "off", responseFormat: fmt, strictJson: true }, false),
    {
      model,
      messages: msgs,
      temperature: 0,
      max_tokens: 2048,
      reasoning: translationReasoningConfig(model),
      response_format: fmt,
      plugins: [{ id: "response-healing" }],
      provider: { sort: "throughput", require_parameters: true },
    },
  );
  assert.deepEqual(
    openRouterPayload({ model, messages: msgs, temperature: 0, maxTokens: 1500, reasoning: "off", responseFormat: { type: "json_object" } }, false),
    { model, messages: msgs, temperature: 0, max_tokens: 1500, reasoning: translationReasoningConfig(model), response_format: { type: "json_object" } },
  );
  // 도구 선택 "none"(마무리 요청)도 그대로.
  assert.equal(openRouterPayload({ model, messages: msgs, tools, toolChoice: "none", maxTokens: 10, reasoning: "agent_low" }, true).tool_choice, "none");
});

import { openAiPayload, openAiMessages } from "../src/lib/providers/openai.ts";
import { activeModel, normalizeSettings } from "../src/lib/settings.ts";

test("OpenAI 어댑터: 추론 모델은 reasoning_effort·max_completion_tokens, temperature 없음", () => {
  const b = openAiPayload({ model: "gpt-5-mini", messages: msgs, tools, toolChoice: "auto", parallelToolCalls: false, reasoning: "agent", maxTokens: 8192, temperature: 0 }, true);
  assert.deepEqual(b, {
    model: "gpt-5-mini",
    messages: msgs,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_completion_tokens: 8192,
    reasoning_effort: "medium",
    stream: true,
  });
  assert.equal(openAiPayload({ model: "gpt-5", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "minimal");
  assert.equal(openAiPayload({ model: "gpt-5-nano", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "minimal");
  assert.equal(openAiPayload({ model: "gpt-5.1", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "none");
  assert.equal(openAiPayload({ model: "gpt-5.2-mini", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "none");
  assert.equal(openAiPayload({ model: "o4-mini", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "low");
  assert.equal(openAiPayload({ model: "o4-mini", messages: msgs, maxTokens: 10, reasoning: "agent_low" }, false).reasoning_effort, "low");
});

test("OpenAI 어댑터: 일반 모델은 temperature만, 도구 없으면 parallel_tool_calls 없음", () => {
  const fmt = { type: "json_object" };
  assert.deepEqual(openAiPayload({ model: "gpt-4.1", messages: msgs, maxTokens: 1500, reasoning: "off", temperature: 0, responseFormat: fmt, parallelToolCalls: false }, false), {
    model: "gpt-4.1",
    messages: msgs,
    max_completion_tokens: 1500,
    temperature: 0,
    response_format: fmt,
  });
});

test("OpenAI 어댑터: 기록에서 OpenRouter 전용 필드와 도구 결과의 name을 뺀다", () => {
  const out = openAiMessages([
    { role: "system", content: "s" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }], reasoning: "r", reasoning_details: [{}], annotations: [] },
    { role: "tool", tool_call_id: "c1", name: "x", content: "{}" },
    { role: "assistant", content: "끝", reasoning: "r" },
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "s" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "{}" },
    { role: "assistant", content: "끝" },
  ]);
});

test("설정: 제공자·제공자별 키·모델 정리와 activeModel", () => {
  const def = normalizeSettings({ openRouterApiKey: "or", model: "deepseek/deepseek-v4-pro" });
  assert.equal(def.provider, "openrouter");
  assert.deepEqual(activeModel(def), { provider: "openrouter", apiKey: "or", model: "deepseek/deepseek-v4-pro" });
  const oa = normalizeSettings({ provider: "openai", apiKeys: { openai: "  sk-x  ", other: "y" }, providerModels: { openai: "" } });
  assert.deepEqual(oa.apiKeys, { openai: "sk-x" });
  assert.deepEqual(activeModel(oa), { provider: "openai", apiKey: "sk-x", model: "gpt-5-mini" });
  assert.equal(normalizeSettings({ provider: "nope" }).provider, "openrouter");
  assert.deepEqual(normalizeSettings({ apiKeys: "x" }).apiKeys, {});
});

import { geminiPayload } from "../src/lib/providers/gemini.ts";

const withSig = [
  { role: "user", content: "hi" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" }, extra_content: { google: { thought_signature: "s" } } }], reasoning: "r" },
  { role: "tool", tool_call_id: "c1", name: "x", content: "{}" },
];

test("Gemini 어댑터: 호환 엔드포인트 형식, thought_signature(extra_content)는 돌려주고 OpenRouter 전용 필드는 뺀다", () => {
  const b = geminiPayload({ model: "gemini-3.6-flash", messages: withSig, tools, toolChoice: "auto", parallelToolCalls: false, reasoning: "agent", maxTokens: 8192 }, true);
  assert.deepEqual(b, {
    model: "gemini-3.6-flash",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" }, extra_content: { google: { thought_signature: "s" } } }] },
      { role: "tool", tool_call_id: "c1", content: "{}" },
    ],
    tools,
    tool_choice: "auto",
    max_tokens: 8192,
    reasoning_effort: "medium",
    stream: true,
  });
  assert.equal(geminiPayload({ model: "m", messages: msgs, maxTokens: 10, reasoning: "off", temperature: 0 }, false).reasoning_effort, "minimal");
  assert.equal(geminiPayload({ model: "m", messages: msgs, maxTokens: 10, reasoning: "agent_low" }, false).reasoning_effort, "low");
});

test("다른 제공자의 extra_content는 OpenAI·OpenRouter 어댑터가 보내지 않는다", () => {
  const oa = openAiPayload({ model: "gpt-5", messages: withSig, maxTokens: 10, reasoning: "agent" }, false);
  assert.ok(!JSON.stringify(oa).includes("thought_signature"));
  const or = openRouterPayload({ model: "deepseek/deepseek-v4-pro", messages: withSig, maxTokens: 10, reasoning: "agent" }, false);
  assert.ok(!JSON.stringify(or).includes("thought_signature"));
  // 서명이 없는 기록은 OpenRouter에 그대로(같은 객체).
  assert.equal(openRouterPayload({ model: "x/y", messages: msgs, maxTokens: 10, reasoning: "agent" }, false).messages[0], msgs[0]);
});

test("설정: Gemini 키·모델과 activeModel", () => {
  const g = normalizeSettings({ provider: "gemini", apiKeys: { gemini: "AIza" }, providerModels: { gemini: "gemini-3.1-pro-preview" } });
  assert.deepEqual(activeModel(g), { provider: "gemini", apiKey: "AIza", model: "gemini-3.1-pro-preview" });
  assert.equal(activeModel(normalizeSettings({ provider: "gemini" })).model, "gemini-3.6-flash");
});

import { geminiIndexer } from "../src/lib/providers/gemini.ts";

test("Gemini: index 없는 도구 호출 조각을 호출마다 나눈다(이어지는 조각은 앞 호출)", () => {
  const ix = geminiIndexer();
  const d = (calls) => ({ choices: [{ delta: { tool_calls: calls } }] });
  const out = [
    ix(d([{ id: "a", type: "function", function: { name: "describe_page", arguments: "" } }])),
    ix(d([{ function: { arguments: "{}" } }])),
    ix(d([{ id: "b", type: "function", function: { name: "get_page_content", arguments: "{}" } }])),
    ix(d([{ id: "c", function: { name: "x", arguments: "{}" } }, { id: "d", function: { name: "y", arguments: "{}" } }])),
  ].flatMap((c) => c.choices[0].delta.tool_calls.map((t) => t.index));
  assert.deepEqual(out, [0, 0, 1, 2, 3]);
  // index가 있으면 그대로.
  const ix2 = geminiIndexer();
  assert.equal(ix2(d([{ index: 5, id: "z", function: { name: "n" } }])).choices[0].delta.tool_calls[0].index, 5);
  assert.equal(ix2(d([{ id: "w", function: { name: "m" } }])).choices[0].delta.tool_calls[0].index, 6);
  // 도구 호출이 없는 조각은 같은 객체.
  const plain = { choices: [{ delta: { content: "hi" } }] };
  assert.equal(geminiIndexer()(plain), plain);
});

test("Gemini: Pro 모델의 생각 끄기는 low, 기록의 파일 조각은 안내 글자로", () => {
  assert.equal(geminiPayload({ model: "gemini-3.1-pro-preview", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "low");
  assert.equal(geminiPayload({ model: "gemini-3.6-flash", messages: msgs, maxTokens: 10, reasoning: "off" }, false).reasoning_effort, "minimal");
  const withFile = [{ role: "user", content: [{ type: "text", text: "q" }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" } }] }];
  const b = geminiPayload({ model: "gemini-3.6-flash", messages: withFile, maxTokens: 10, reasoning: "agent" }, false);
  assert.ok(!JSON.stringify(b).includes("base64"));
  assert.equal(b.messages[0].content[1].type, "text");
});

import { anthropicMessages, anthropicPayload, anthropicStreamConverter, anthropicThinkingMode, anthropicThinkingModel } from "../src/lib/providers/anthropic.ts";

test("Anthropic: 기록 변환 — system 분리, 같은 역할 합치기(tool_result 먼저), 생각·도구 블록, PDF document", () => {
  const { system, messages } = anthropicMessages([
    { role: "system", content: "규칙" },
    { role: "user", content: [{ type: "text", text: "이 PDF 요약" }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,QUJD" } }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "toolu_1", type: "function", function: { name: "describe_page", arguments: '{"a":1}' } }],
      reasoning_details: [{ type: "anthropic.thinking", thinking: "생각", signature: "sig" }, { type: "reasoning.text", text: "다른 제공자" }],
    },
    { role: "tool", tool_call_id: "toolu_1", name: "describe_page", content: "{}" },
    { role: "user", content: "[현재 시각]" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "끝" },
  ]);
  assert.equal(system, "규칙");
  assert.deepEqual(messages, [
    { role: "user", content: [{ type: "text", text: "이 PDF 요약" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "생각", signature: "sig" },
        { type: "tool_use", id: "toolu_1", name: "describe_page", input: { a: 1 } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }, { type: "text", text: "[현재 시각]" }] },
    { role: "assistant", content: [{ type: "text", text: "끝" }] },
  ]);
});

test("Anthropic: 요청 형식 — 도구·tool_choice·생각(에이전트만)·JSON 지침", () => {
  const tools = [{ type: "function", function: { name: "describe_page", description: "관측", parameters: { type: "object", properties: {} } } }];
  const agent = anthropicPayload({ model: "claude-sonnet-5-5", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], tools, toolChoice: "auto", parallelToolCalls: false, reasoning: "agent", maxTokens: 8192, temperature: 0 }, true);
  assert.deepEqual(agent, {
    model: "claude-sonnet-5-5",
    system: "s",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 8192,
    tools: [{ name: "describe_page", description: "관측", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    // 5 계열은 adaptive + effort, temperature는 보내지 않는다.
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    stream: true,
  });
  assert.deepEqual(anthropicPayload({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }], tools, toolChoice: "none", reasoning: "agent_low", maxTokens: 8192 }, true).tool_choice, { type: "none" });
  assert.deepEqual(anthropicPayload({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: "x" }], reasoning: "agent_low", maxTokens: 8192 }, true).output_config, { effort: "low" });
  // 4~4.5와 3.7은 budget_tokens.
  const b45 = anthropicPayload({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x" }], reasoning: "agent", maxTokens: 8192, temperature: 0 }, true);
  assert.deepEqual(b45.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.ok(!("temperature" in b45) && !("output_config" in b45));
  assert.equal(anthropicPayload({ model: "claude-3-7-sonnet-latest", messages: [{ role: "user", content: "x" }], reasoning: "agent_low", maxTokens: 8192 }, true).thinking.budget_tokens, 1024);
  assert.equal(anthropicThinkingMode("claude-opus-4-6"), "adaptive");
  assert.equal(anthropicThinkingMode("claude-sonnet-4-20250514"), "budget");
  assert.equal(anthropicThinkingMode("claude-fable-5-1"), "adaptive");
  const json = anthropicPayload({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "x" }], reasoning: "off", maxTokens: 1500, temperature: 0, responseFormat: { type: "json_schema", json_schema: { schema: { type: "object" } } } }, false);
  assert.ok(!("thinking" in json) && !("temperature" in json));
  // adaptive 모델의 생각 끄기는 강도를 가장 낮게.
  assert.deepEqual(json.output_config, { effort: "low" });
  assert.ok(!("output_config" in anthropicPayload({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "x" }], reasoning: "off", maxTokens: 10 }, false)));
  assert.match(json.system, /JSON 객체 하나만/);
  assert.match(json.system, /"type":"object"/);
  // 생각을 지원하지 않는 옛 모델은 켜지 않는다.
  assert.equal(anthropicThinkingModel("claude-3-5-haiku-latest"), false);
  assert.equal(anthropicThinkingModel("claude-3-7-sonnet-latest"), true);
  assert.equal(anthropicThinkingModel("claude-opus-4-1"), true);
  assert.ok(!("thinking" in anthropicPayload({ model: "claude-3-5-haiku-latest", messages: [{ role: "user", content: "x" }], reasoning: "agent", maxTokens: 100 }, true)));
});

test("Anthropic: 스트림 이벤트 → 내부 조각(글자·생각·서명·도구 인자·종료 이유)", () => {
  const conv = anthropicStreamConverter();
  const evs = [
    { type: "message_start" },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "음" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "S" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "보자" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "find_clickables" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t2", name: "describe_page" } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  const deltas = evs.flatMap((e) => conv(e)).map((c) => ({ ...c.choices[0].delta, ...(c.choices[0].finish_reason ? { finish: c.choices[0].finish_reason } : {}) }));
  assert.deepEqual(deltas, [
    { reasoning: "음" },
    { reasoning_details: [{ type: "anthropic.thinking", thinking: "음", signature: "S" }] },
    { content: "보자" },
    { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "find_clickables", arguments: "" } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] },
    { tool_calls: [{ index: 1, id: "t2", type: "function", function: { name: "describe_page", arguments: "" } }] },
    { tool_calls: [{ index: 1, function: { arguments: "{}" } }] },
    { finish: "tool_calls" },
  ]);
  const c2 = anthropicStreamConverter();
  assert.equal(c2({ type: "message_delta", delta: { stop_reason: "max_tokens" } })[0].choices[0].finish_reason, "length");
  assert.equal(c2({ type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } })[0].choices[0].finish_reason, "length");
  assert.equal(c2({ type: "message_delta", delta: { stop_reason: "end_turn" } })[0].choices[0].finish_reason, "stop");
});
