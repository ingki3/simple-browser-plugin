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
