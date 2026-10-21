import test from "node:test";
import assert from "node:assert/strict";

import { QUERY_DOM_ATTRS, cleanModelText, editingHost, protectedReason } from "../src/lib/modelText.ts";

const plain = { tag: "div", contentEditable: null, hidden: false, ariaHidden: false, display: "block", visibility: "visible" };

test("protectedReason: 값 컨트롤·편집 영역·숨은 요소의 하위 글자는 뺀다", () => {
  assert.equal(protectedReason(plain), null);
  for (const tag of ["input", "textarea", "select"]) assert.equal(protectedReason({ ...plain, tag }), "control");
  assert.equal(protectedReason({ ...plain, contentEditable: "" }), "editable");
  assert.equal(protectedReason({ ...plain, contentEditable: "true" }), "editable");
  assert.equal(protectedReason({ ...plain, contentEditable: "plaintext-only" }), "editable");
  // contenteditable=false는 스스로 편집 영역이 아니다(편집 영역 안의 섬은 조상 판정에서 막힌다).
  assert.equal(protectedReason({ ...plain, contentEditable: "false" }), null);
  assert.equal(protectedReason({ ...plain, hidden: true }), "hidden");
  assert.equal(protectedReason({ ...plain, ariaHidden: true }), "hidden");
  assert.equal(protectedReason({ ...plain, display: "none" }), "hidden");
  assert.equal(protectedReason({ ...plain, visibility: "hidden" }), "hidden");
  assert.equal(protectedReason({ ...plain, tag: "script" }), "non_text");
});

test("editingHost: contenteditable이 있고 false가 아니면 편집 호스트", () => {
  assert.equal(editingHost(null), false);
  assert.equal(editingHost("FALSE"), false);
  assert.equal(editingHost(""), true);
  assert.equal(editingHost("TRUE"), true);
});

test("query_dom 속성 목록: 값 성격·data-*·class는 없다", () => {
  for (const banned of ["value", "aria-valuetext", "aria-valuenow", "class", "style", "data-value"]) {
    assert.equal(QUERY_DOM_ATTRS.includes(banned), false, banned);
  }
  assert.equal(QUERY_DOM_ATTRS.includes("href"), true);
});

test("cleanModelText: 공백을 정리하고 자른다", () => {
  assert.equal(cleanModelText("  a \n  b  ", 10), "a b");
  assert.equal(cleanModelText("abcdef", 3), "abc");
});
