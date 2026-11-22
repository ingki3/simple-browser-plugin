// 선택지·트리거 팝업 종류(#316): ARIA 역할·aria-haspopup 열거값으로만 판정.
import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceKindOf, kindMatch, triggerPopupKind } from "../src/lib/choiceKind.ts";

test("choiceKindOf: option → listbox, menuitem* → menu, 그 밖 null", () => {
  assert.equal(choiceKindOf("option"), "listbox");
  assert.equal(choiceKindOf(" Option "), "listbox");
  for (const r of ["menuitem", "menuitemradio", "menuitemcheckbox"]) assert.equal(choiceKindOf(r), "menu");
  assert.equal(choiceKindOf("button"), null);
  assert.equal(choiceKindOf(null), null);
});

test("triggerPopupKind: combobox는 속성 없음·true를 listbox로, 이름 있는 값은 그대로, false·잘못된 값은 unknown", () => {
  assert.equal(triggerPopupKind("combobox", null), "listbox");
  assert.equal(triggerPopupKind("combobox", "listbox"), "listbox");
  assert.equal(triggerPopupKind("combobox", "TRUE "), "listbox");
  assert.equal(triggerPopupKind("combobox", "dialog"), "dialog");
  assert.equal(triggerPopupKind("combobox", "grid"), "grid");
  assert.equal(triggerPopupKind("combobox", "false"), "unknown");
  assert.equal(triggerPopupKind("combobox", "yes"), "unknown");
  // 빈 값·공백은 속성 없음과 다르다(알 수 없음 — 모호성으로 센다).
  assert.equal(triggerPopupKind("combobox", ""), "unknown");
  assert.equal(triggerPopupKind("combobox", "  "), "unknown");
  assert.equal(kindMatch("combobox", "", "menu"), "maybe");
});

test("triggerPopupKind: combobox가 아니면 true → menu, 이름 있는 값은 그대로, 그 밖 unknown", () => {
  assert.equal(triggerPopupKind(null, "true"), "menu");
  assert.equal(triggerPopupKind("button", "menu"), "menu");
  assert.equal(triggerPopupKind("button", "Listbox"), "listbox");
  assert.equal(triggerPopupKind("button", "dialog"), "dialog");
  assert.equal(triggerPopupKind("button", "popup"), "unknown");
  assert.equal(triggerPopupKind("button", "false"), "unknown");
  assert.equal(triggerPopupKind("button", null), "unknown");
});

test("kindMatch: 같은 종류 match, 알 수 없음 maybe, 다른 종류 no, combobox+true는 menu에 maybe", () => {
  assert.equal(kindMatch("combobox", "true", "listbox"), "match");
  assert.equal(kindMatch("combobox", "true", "menu"), "maybe");
  assert.equal(kindMatch("combobox", null, "listbox"), "match");
  assert.equal(kindMatch("combobox", null, "menu"), "no");
  assert.equal(kindMatch(null, "true", "menu"), "match");
  assert.equal(kindMatch(null, "true", "listbox"), "no");
  assert.equal(kindMatch(null, "listbox", "listbox"), "match");
  assert.equal(kindMatch(null, "dialog", "listbox"), "no");
  assert.equal(kindMatch(null, "weird", "listbox"), "maybe");
  assert.equal(kindMatch("combobox", "false", "listbox"), "maybe");
});
