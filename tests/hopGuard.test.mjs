import test from "node:test";
import assert from "node:assert/strict";

import {
  SPIN_FAILURE_LIMIT,
  SPIN_REPEAT_LIMIT,
  canonicalJson,
  clickObservedChange,
  detectSpin,
  fingerprint,
  summarizeRuns,
} from "../src/lib/hopGuard.ts";

const run = (tool, args, { ok = true, result = "r", changed = false, cancelled = false, summary = "s" } = {}) => ({
  tool,
  argsKey: canonicalJson(args),
  ok,
  resultKey: fingerprint(result),
  changed,
  cancelled,
  summary,
});

test("canonicalJson: 키 순서와 관계없이 같은 값은 같은 문자열, undefined 키는 뺌", () => {
  assert.equal(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] }), canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assert.notEqual(canonicalJson({ id: "c1" }), canonicalJson({ id: "c2" }));
  assert.equal(canonicalJson(undefined), "null");
});

test("fingerprint: 같은 글자는 같은 지문, 다르면 다름", () => {
  assert.equal(fingerprint("abc"), fingerprint("abc"));
  assert.notEqual(fingerprint("abc"), fingerprint("abd"));
  assert.notEqual(fingerprint(""), fingerprint("a"));
});

test("detectSpin: 같은 관측을 같은 결과로 3번 연속 부르면 반복", () => {
  assert.equal(SPIN_REPEAT_LIMIT, 3);
  const r = [run("describe_page", {}), run("describe_page", {})];
  assert.equal(detectSpin(r), null);
  r.push(run("describe_page", {}));
  assert.deepEqual(detectSpin(r), { kind: "repeat", tool: "describe_page", count: 3 });
});

test("detectSpin: 같은 호출이라도 결과가 달라지면(페이지가 바뀌는 중) 반복으로 세지 않음", () => {
  const r = [
    run("find_clickables", { query: "다음" }, { result: "a" }),
    run("find_clickables", { query: "다음" }, { result: "b" }),
    run("find_clickables", { query: "다음" }, { result: "b" }),
  ];
  assert.equal(detectSpin(r), null);
});

test("detectSpin: 인자가 다르거나 사이에 다른 호출이 끼면 연속이 아님", () => {
  assert.equal(
    detectSpin([run("query_dom", { selector: "a" }), run("query_dom", { selector: "b" }), run("query_dom", { selector: "a" })]),
    null,
  );
  assert.equal(
    detectSpin([run("describe_page", {}), run("describe_page", {}), run("get_page_content", {}), run("describe_page", {})]),
    null,
  );
});

test("detectSpin: '다음 달'처럼 같은 id 클릭도 화면 변화가 관측되면 반복이 아님", () => {
  const click = { id: "c12-x" };
  const r = [];
  for (let i = 0; i < 6; i += 1) r.push(run("click_element", click, { result: "same", changed: true }));
  assert.equal(detectSpin(r), null);
});

test("detectSpin: 화면 변화 없이 같은 클릭이 같은 결과로 3번이면 반복", () => {
  const click = { id: "c12-x" };
  const r = [
    run("click_element", click, { result: "same", changed: true }),
    run("click_element", click, { result: "same" }),
    run("click_element", click, { result: "same" }),
  ];
  // 첫 클릭은 화면을 바꿨으니 연속을 끊는다(변화 없는 클릭 2번).
  assert.equal(detectSpin(r), null);
  r.push(run("click_element", click, { result: "same" }));
  assert.deepEqual(detectSpin(r), { kind: "repeat", tool: "click_element", count: 3 });
});

test("detectSpin: 같은 입력을 같은 결과로 3번이면 반복", () => {
  const fill = { fields: [{ id: "f1-x", value: "하와이" }] };
  const r = [run("fill_form_fields", fill), run("fill_form_fields", fill), run("fill_form_fields", fill)];
  assert.equal(detectSpin(r)?.kind, "repeat");
});

test("detectSpin: 사용자 취소는 실패로 세지 않고 반복의 연속도 끊음", () => {
  const nav = { url: "https://example.com/" };
  const r = [
    run("navigate_to_url", nav, { ok: false, result: "user_cancelled", cancelled: true }),
    run("navigate_to_url", nav, { ok: false, result: "user_cancelled", cancelled: true }),
    run("navigate_to_url", nav, { ok: false, result: "user_cancelled", cancelled: true }),
  ];
  assert.equal(detectSpin(r), null);
  const r2 = [run("describe_page", {}), run("describe_page", {}), run("click_element", { id: "c1" }, { ok: false, cancelled: true }), run("describe_page", {})];
  assert.equal(detectSpin(r2), null);
});

test("detectSpin: 한 도구가 다른 대상·다른 오류 글자로라도 성공 없이 3번 실패하면 멈춤(사이의 찾기는 무관)", () => {
  assert.equal(SPIN_FAILURE_LIMIT, 3);
  const r = [
    run("find_clickables", { query: "다음달" }, { result: "x1" }),
    run("click_element", { id: "c1" }, { ok: false, result: "error:c1 사라짐" }),
    run("find_clickables", { query: "다음달" }, { result: "x2" }),
    run("click_element", { id: "c5" }, { ok: false, result: "error:c5 사라짐" }),
    run("find_clickables", { query: "다음달" }, { result: "x3" }),
  ];
  assert.equal(detectSpin(r), null);
  r.push(run("click_element", { id: "c9" }, { ok: false, result: "error:c9 사라짐" }));
  assert.deepEqual(detectSpin(r), { kind: "failure", tool: "click_element", count: 3 });
});

test("detectSpin: 그 도구가 한 번 성공하면 실패 연속이 끊김", () => {
  const r = [
    run("click_element", { id: "c1" }, { ok: false, result: "e1" }),
    run("click_element", { id: "c2" }, { ok: false, result: "e2" }),
    run("click_element", { id: "c3" }, { ok: true, result: "ok", changed: true }),
    run("click_element", { id: "c4" }, { ok: false, result: "e4" }),
    run("click_element", { id: "c5" }, { ok: false, result: "e5" }),
  ];
  assert.equal(detectSpin(r), null);
});

test("detectSpin: 다른 도구의 실패는 서로 섞어 세지 않음, 마지막이 성공이면 실패 판정 없음", () => {
  const r = [
    run("click_element", { id: "c1" }, { ok: false, result: "e" }),
    run("query_dom", { selector: "x" }, { ok: false, result: "e" }),
    run("click_element", { id: "c2" }, { ok: false, result: "e" }),
    run("read_document", { url: "u" }, { ok: false, result: "e" }),
  ];
  assert.equal(detectSpin(r), null);
  assert.equal(detectSpin([]), null);
});

test("clickObservedChange: 이동·화면 변경·대화상자·새 탭·다시 불러옴은 변화, 직전 멈춤과 무변화는 아님", () => {
  const none = { navigation: "none", newTab: false, sameDocument: true, dom: { mutations: 0, dialogOpened: false } };
  assert.equal(clickObservedChange(none), false);
  assert.equal(clickObservedChange({ ...none, dom: { mutations: 12, dialogOpened: false } }), true);
  assert.equal(clickObservedChange({ ...none, dom: { mutations: 0, dialogOpened: true } }), true);
  assert.equal(clickObservedChange({ ...none, dom: { mutations: 0, frameNavigated: true } }), true);
  assert.equal(clickObservedChange({ ...none, navigation: "same_origin" }), true);
  assert.equal(clickObservedChange({ ...none, newTab: true }), true);
  assert.equal(clickObservedChange({ ...none, sameDocument: false }), true);
  assert.equal(clickObservedChange({ ...none, dom: { mutations: 50, aborted: "글자 바뀜" } }), false);
  assert.equal(clickObservedChange(null), false);
  assert.equal(clickObservedChange(undefined), false);
});

test("summarizeRuns: 도구별 횟수(많은 순), 실패·취소 수, 최근 결과 3줄(긴 줄은 자름)", () => {
  const long = "가".repeat(200);
  const s = summarizeRuns([
    run("describe_page", {}, { summary: "관측" }),
    run("find_clickables", {}, { summary: "찾음" }),
    run("click_element", { id: "a" }, { ok: false, summary: "실패" }),
    run("find_clickables", {}, { summary: "찾음2" }),
    run("click_element", { id: "b" }, { ok: false, cancelled: true, summary: long }),
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.failed, 1);
  assert.equal(s.cancelled, 1);
  assert.deepEqual(s.byTool, [
    { tool: "click_element", count: 2 },
    { tool: "find_clickables", count: 2 },
    { tool: "describe_page", count: 1 },
  ]);
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0], "click_element: 실패");
  assert.ok(s.recent[2].endsWith("…"));
  assert.ok(s.recent[2].length <= "click_element: ".length + 120);
});
