import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingDisplay } from "../src/lib/thinkingView.ts";

const m = (over = {}) => ({ thoughtText: "", text: "", streaming: true, ...over });

test("기본: 추론 중에만 생각 중 표시, 추론 글자는 보이지 않음", () => {
  assert.equal(thinkingDisplay(m({ thoughtText: "음..." }), false), "indicator");
  // 답 글자가 시작되면 표시를 없앤다.
  assert.equal(thinkingDisplay(m({ thoughtText: "음...", text: "답" }), false), "none");
  // 스트리밍이 끝났거나(완료·중단) 추론이 없으면 아무것도 없다.
  assert.equal(thinkingDisplay(m({ thoughtText: "음...", streaming: false }), false), "none");
  assert.equal(thinkingDisplay(m(), false), "none");
});

test("생각 과정 보기를 켜면 추론이 있는 메시지는 상자로", () => {
  assert.equal(thinkingDisplay(m({ thoughtText: "음..." }), true), "box");
  assert.equal(thinkingDisplay(m({ thoughtText: "음...", text: "답", streaming: false }), true), "box");
  assert.equal(thinkingDisplay(m(), true), "none");
});
