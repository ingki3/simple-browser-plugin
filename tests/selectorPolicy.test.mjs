import { test } from "node:test";
import assert from "node:assert/strict";
import { selectorBlock } from "../src/lib/selectorPolicy.ts";

test("selectorBlock: 구조 조건은 허용", () => {
  for (const s of [
    "a[href^='https']",
    ".card > h2",
    "#main button",
    "[data-testid]",
    "[aria-label='닫기']",
    "input[type=checkbox]:checked",
    "li:nth-child(2)",
    "a:not([rel=nofollow])",
    '[name="q"]',
    "div:has(> img)",
    "p::before",
    "[class~=active]",
    "a[title*=']']",
  ]) {
    assert.equal(selectorBlock(s), null, s);
  }
});

test("selectorBlock: 값에 의존하는 조건은 거부(중첩·대소문자·네임스페이스·이스케이프 포함)", () => {
  for (const s of [
    "input[value^='a']",
    "[data-email*='@']",
    "[value]",
    "[ VALUE ]",
    "input:placeholder-shown",
    "input:valid",
    "input:INVALID",
    "input:in-range",
    "input:-webkit-autofill",
    ":is([data-x='1'])",
    "div:has(input[value='x'])",
    "a:not(:where([data-k$='z']))",
    "[v\\61lue='x']",
    "[v\\61 lue='x']",
    "input:v\\61 lid",
    "[*|value='x']",
    "[ns|data-x='1']",
    "[DATA-X='1']",
    "[data-x='a'i]",
    "/*'*/input[value^=s]",
    "input/**/[data-x='1']",
    "input:v\\61\rlid",
    "input:v\\61\flid",
    "input:v\\61\r\nlid",
    "input[aria-valuenow^='12']",
    "input[aria-valuetext^='s']",
    "[aria-invalid=true]",
    ':is("\n,input[value^=s])',
    "input[value^=a",
    "input[data-x='a",
    ":is('x",
    "a\n[data-x='1']",
    "input[dir=auto]:dir(rtl)",
    ":is(input:DIR(ltr))",
  ]) {
    assert.notEqual(selectorBlock(s), null, s);
  }
});

test("selectorBlock: 문자열 안의 대괄호·콜론은 조건으로 보지 않는다", () => {
  assert.equal(selectorBlock("a[title=':valid [value=1]']"), null);
  assert.equal(selectorBlock(".a\\:valid"), null);
});
