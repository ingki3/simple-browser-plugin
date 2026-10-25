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
