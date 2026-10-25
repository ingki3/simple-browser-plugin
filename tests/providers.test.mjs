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
