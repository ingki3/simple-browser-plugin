import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_LOG_MAX_AGE_MS,
  ACTION_LOG_MAX_ENTRIES,
  collapseRepeats,
  fnv1a,
  isPreActionStop,
  logTarget,
  pruneLog,
  reasonCode,
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
  assert.deepEqual(collapseRepeats(["li", "li", "li", "nav", "li"]), ["li", "nav", "li"]);
  assert.deepEqual(collapseRepeats(["a"]), ["a"]);
  // 항목 하나짜리 목록도 여럿짜리와 같은 뼈대.
  assert.equal(collapseRepeats(["li(button)"]).join(","), collapseRepeats(["li(button)", "li(button)"]).join(","));
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

test("reasonCode: 오류 문구를 값 없는 분류로", () => {
  const cases = {
    "대상 'c3-k'이(가) 페이지에서 다시 그려지거나 사라졌습니다. 다시 찾으세요.": "target_changed",
    "승인한 뒤 대상이 바뀌어 실행하지 않았습니다(글자가 '비밀번호' → 'hunter22'). 다시 찾으세요.": "target_changed",
    "누르기 직전에 대상이 바뀌어 클릭하지 않았습니다(링크 주소가 바뀜). 다시 찾으세요.": "target_changed",
    "대상 '삭제'이(가) 지금 화면에 보이지 않아 실행하지 않았습니다.": "not_visible",
    "대상 'f2-k'은(는) 이 호출에서 승인되지 않았습니다.": "not_approved",
    "입력 뒤 칸이 바뀌어 승인한 칸에 반영됐는지 확인하지 못했습니다(대상이 든 행의 내용이 바뀜)": "unverified",
    "입력 뒤 페이지가 칸을 새로 그려 값이 남았는지 확인하지 못했습니다": "unverified",
    "페이지가 값을 바꾸거나 받아들이지 않았습니다(최대 길이·서식 등)": "value_rejected",
    "맞는 선택지가 없거나 이 값으로 고를 수 없습니다": "value_rejected",
    "요청을 시작한 탭이 닫혀서 작업을 계속할 수 없습니다.": "page_gone",
    "뭔가 이상함": "error",
  };
  for (const [msg, code] of Object.entries(cases)) assert.equal(reasonCode(msg), code, msg);
  assert.equal(isPreActionStop("target_changed"), true);
  assert.equal(isPreActionStop("not_visible"), true);
  assert.equal(isPreActionStop("value_rejected"), false);
});
