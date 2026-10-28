// 카드의 쉬운 도구 이름(#130): 등록한 이름만 바꾸고, 모델이 준 이상한 이름은 글자 그대로 둔다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolLabel } from "../src/lib/toolLabels.ts";

test("등록한 도구는 쉬운 이름", () => {
  assert.equal(toolLabel("click_element"), "누르기");
});

test("모르는 이름과 상속 속성 이름은 그대로 글자", () => {
  assert.equal(toolLabel("no_such_tool"), "no_such_tool");
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(toolLabel(name), name);
  }
});
