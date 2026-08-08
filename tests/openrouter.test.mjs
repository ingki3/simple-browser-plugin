import test from "node:test";
import assert from "node:assert/strict";

import {
  agentReasoningConfig,
  translationReasoningConfig,
} from "../src/lib/models.ts";
import { readOpenRouterStream } from "../src/lib/openrouter.ts";
import { appendCustomSystemPrompt } from "../src/lib/systemPrompt.ts";
import {
  parseTranslationResponse,
  translationResponseFormat,
} from "../src/lib/translationProtocol.ts";

test("custom system prompt is appended after the built-in prompt", () => {
  const result = appendCustomSystemPrompt("내부 규칙", "  출력은 한글로  ");
  assert.match(result, /^내부 규칙/);
  assert.match(result, /사용자 지정 기본 지침:\n출력은 한글로/);
  assert.match(result, /절대 규칙.*우선하지 않는다/);
});

test("Gemini 3 models receive an explicit reasoning effort", () => {
  assert.deepEqual(agentReasoningConfig("google/gemini-3.6-flash"), {
    effort: "medium",
  });
  assert.deepEqual(translationReasoningConfig("google/gemini-3.6-flash"), {
    effort: "minimal",
    exclude: true,
  });
});

test("gpt-oss uses bounded low reasoning effort", () => {
  assert.deepEqual(agentReasoningConfig("openai/gpt-oss-120b"), {
    effort: "low",
  });
});

test("stream reader resolves at SSE DONE even when the connection stays open", async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"완료"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const chunks = [];

  await readOpenRouterStream(new Response(body), (chunk) => chunks.push(chunk), 1000);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].choices[0].delta.content, "완료");
  assert.equal(cancelled, true);
});

test("translation schema requires exactly one output per input", () => {
  const format = translationResponseFormat(3);
  const translations = format.json_schema.schema.properties.translations;
  assert.equal(format.json_schema.strict, true);
  assert.equal(translations.minItems, 3);
  assert.equal(translations.maxItems, 3);
});

test("translation response rejects missing items", () => {
  assert.deepEqual(
    parseTranslationResponse('{"translations":["가","나"]}', 2),
    ["가", "나"],
  );
  assert.throws(
    () => parseTranslationResponse('{"translations":["가"]}', 2),
    /길이 불일치/,
  );
});
