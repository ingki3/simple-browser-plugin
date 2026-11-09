// 하네스 모의 모델의 요청 분류(#284 계획 12절 P2): 제공자 실제 구조에서 system 글과 마지막 user 글을 뽑아, 반복 작업의
// 작전 만들기·영역 판단·전체 판단 요청을 가려낸다. OpenAI 호환(OpenRouter·OpenAI·Gemini·로컬 — messages)과
// Anthropic(system + messages) 두 경로를 실제 어댑터의 요청 본문으로 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { requestParts, repeatRequestKind } from "./harness/requestParts.mjs";
import { geminiPayload } from "../src/lib/providers/gemini.ts";
import { anthropicPayload } from "../src/lib/providers/anthropic.ts";
import { openAiPayload } from "../src/lib/providers/openai.ts";
import { localPayload } from "../src/lib/providers/local.ts";
import { REPEAT_PLAN_SYSTEM, REPEAT_REGION_SYSTEM } from "../src/lib/repeatPlan.ts";
import { REPEAT_CHECK_SYSTEM } from "../src/lib/repeatTask.ts";

const kinds = [
  ["plan", REPEAT_PLAN_SYSTEM, `조건: x\n\n<page title="t" url="u">본문</page>\n<region_candidates>\n1. section#a\n</region_candidates>`],
  ["region", REPEAT_REGION_SYSTEM, `조건: x\n\n<plan_notes source="page-derived">기준</plan_notes>\n<region title="t" url="u" selector="s">영역</region>`],
  ["full", REPEAT_CHECK_SYSTEM, `조건: x\n\n<page title="t" url="u">본문</page>`],
];

const req = (system, user) => ({ model: "m", messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0, reasoning: "off", maxTokens: 300, responseFormat: { type: "json_object" } });

test("requestParts: Gemini·OpenAI·로컬(messages)과 Anthropic(system 필드) 요청에서 system·user 글을 뽑고 종류를 가린다", () => {
  const builders = {
    gemini: (r) => geminiPayload(r, false),
    openai: (r) => openAiPayload(r, false),
    local: (r) => localPayload(r, false),
    anthropic: (r) => anthropicPayload(r, false),
  };
  for (const [name, build] of Object.entries(builders)) {
    for (const [kind, system, user] of kinds) {
      const body = build(req(system, user));
      const parts = requestParts(body);
      assert.ok(parts.system.includes(system.slice(0, 30)), `${name}/${kind} system`);
      assert.equal(parts.user, user, `${name}/${kind} user`);
      assert.equal(repeatRequestKind(body), kind, `${name}/${kind}`);
    }
  }
  // Anthropic은 system이 최상위 필드다(messages에는 user만).
  const a = anthropicPayload(req(REPEAT_PLAN_SYSTEM, "u"), false);
  assert.equal(typeof a.system, "string");
  assert.ok(!a.messages.some((m) => m.role === "system"));
});

test("requestParts: 반복 작업 요청이 아니면 kind는 null(번역·저장 카드 초안 등)", () => {
  const body = openAiPayload(req("너는 번역한다", "translations 배열"), false);
  assert.equal(repeatRequestKind(body), null);
  assert.deepEqual(requestParts({}), { system: "", user: "" });
});
