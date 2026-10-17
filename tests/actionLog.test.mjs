import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_LOG_MAX_AGE_MS,
  ACTION_LOG_MAX_ENTRIES,
  collapseRepeats,
  fnv1a,
  logTarget,
  pruneLog,
  summarizeClickEffect,
  urlPattern,
} from "../src/lib/actionLog.ts";

test("urlPattern: 글 번호·식별자는 자리표시, 쿼리는 이름만", () => {
  assert.deepEqual(urlPattern("https://ex.test/board/123/view?id=55&page=2&id=7#comments"), {
    origin: "https://ex.test",
    pattern: "/board/{n}/view?id&page",
  });
  assert.equal(
    urlPattern("https://ex.test/doc/550e8400-e29b-41d4-a716-446655440000/edit").pattern,
    "/doc/{id}/edit",
  );
  assert.equal(urlPattern("https://ex.test/f/AbC123xyz987QwErTy").pattern, "/f/{id}");
  assert.equal(urlPattern("https://ex.test/post-2024.html").pattern, "/post-{n}.html");
  // 숫자가 없는 긴 낱말은 그대로 둔다.
  assert.equal(urlPattern("https://ex.test/settings/notifications").pattern, "/settings/notifications");
  // 쿼리 순서가 달라도 같은 틀.
  assert.equal(urlPattern("https://ex.test/s?b=1&a=2").pattern, urlPattern("https://ex.test/s?a=9&b=8").pattern);
});

test("urlPattern: 해시 라우터는 경로로, 그 밖의 해시는 버림", () => {
  assert.equal(urlPattern("https://ex.test/app#/mail/123").pattern, "/app#/mail/{n}");
  assert.equal(urlPattern("https://ex.test/app#!/inbox").pattern, "/app#/inbox");
  assert.equal(urlPattern("https://ex.test/app#section-2").pattern, "/app");
});

test("urlPattern: http(s)가 아니면 null", () => {
  assert.equal(urlPattern("chrome://settings"), null);
  assert.equal(urlPattern("file:///tmp/a.html"), null);
  assert.equal(urlPattern("not a url"), null);
});

test("collapseRepeats·fnv1a: 목록 항목 수가 달라도 같은 해시", () => {
  assert.deepEqual(collapseRepeats(["li", "li", "li", "nav", "li"]), ["li*", "nav", "li"]);
  assert.deepEqual(collapseRepeats(["a"]), ["a"]);
  const three = collapseRepeats(["li(button)", "li(button)", "li(button)"]).join(",");
  const ten = collapseRepeats(Array(10).fill("li(button)")).join(",");
  assert.equal(fnv1a(three), fnv1a(ten));
  assert.notEqual(fnv1a("ul(li*)"), fnv1a("ol(li*)"));
  assert.match(fnv1a(""), /^[0-9a-f]{8}$/);
});

const info = {
  tag: "a",
  role: "link",
  name: "  보고서   3월  ",
  href: "https://ex.test/files/987654/download?token=secret",
  region: "main",
  inFrame: false,
  fieldType: "",
  sensitive: null,
  context: "보고서 3월 홍길동 010-1234-5678",
  list: { index: 2, count: 9, semantic: true },
};

test("logTarget: 행 글자와 주소 값은 남기지 않음", () => {
  const t = logTarget(info);
  assert.equal(t.name, "보고서 3월");
  assert.equal(t.hrefPattern, "https://ex.test/files/{n}/download?token");
  assert.deepEqual(t.list, { index: 2, count: 9 });
  assert.equal("context" in t, false);
  assert.equal("hasValue" in t, false);
  assert.doesNotMatch(JSON.stringify(t), /secret|010-1234/);
});

test("logTarget: 입력 값은 있음/없음만", () => {
  const field = { ...info, tag: "input", role: "textbox", href: "", fieldType: "password", sensitive: "password" };
  const t = logTarget(field, "hunter22");
  assert.equal(t.hasValue, true);
  assert.equal(logTarget(field, "").hasValue, false);
  assert.doesNotMatch(JSON.stringify(t), /hunter22/);
});

test("summarizeClickEffect: 도착 주소는 틀만", () => {
  const e = summarizeClickEffect({
    navigation: "same_origin",
    url: "https://ex.test/board/77?q=내이름",
    sameDocument: false,
    newTab: false,
    dom: { mutations: 3, dialogOpened: false },
  });
  assert.equal(e.toPattern, "https://ex.test/board/{n}?q");
  assert.equal(e.domChanged, true);
  const none = summarizeClickEffect({ navigation: "none", url: "https://ex.test/", sameDocument: true, newTab: true, dom: null });
  assert.equal(none.toPattern, undefined);
  assert.equal(none.newTab, true);
  assert.equal(none.domChanged, false);
});

test("pruneLog: 30일·500건 한도, 깨진 값은 버림", () => {
  const now = 10 * ACTION_LOG_MAX_AGE_MS;
  assert.deepEqual(pruneLog(undefined, now), []);
  assert.deepEqual(pruneLog({ a: 1 }, now), []);
  const old = { id: "o", at: now - ACTION_LOG_MAX_AGE_MS - 1 };
  const fresh = { id: "f", at: now - 1000 };
  assert.deepEqual(pruneLog([old, null, "x", fresh], now), [fresh]);
  const many = Array.from({ length: ACTION_LOG_MAX_ENTRIES + 20 }, (_, i) => ({ id: String(i), at: now }));
  const kept = pruneLog(many, now);
  assert.equal(kept.length, ACTION_LOG_MAX_ENTRIES);
  assert.equal(kept[0].id, "20");
});
