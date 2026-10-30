import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPattern, matchPath, matchesRule, normalizePathPattern, normalizeRuleInput, parseRules, ruleFor } from "../src/lib/pageSuggest.ts";

test("matchPath: 세그먼트 단위 *, 끝의 **", () => {
  assert.equal(matchPath("/*/*", "/@user/my-article"), true);
  assert.equal(matchPath("/*/*", "/@user"), false);
  assert.equal(matchPath("/*/*", "/a/b/c"), false);
  assert.equal(matchPath("/a/**", "/a"), true);
  assert.equal(matchPath("/a/**", "/a/b/c"), true);
  assert.equal(matchPath("/a/**", "/b/c"), false);
  assert.equal(matchPath("/", "/"), true);
  assert.equal(matchPath("/", "/x"), false);
  assert.equal(matchPath("/blog/*", "/blog/post/"), true);
});

test("normalizePathPattern: 형식 검사", () => {
  assert.equal(normalizePathPattern("/a//b/"), "/a/b");
  assert.equal(normalizePathPattern("a/b"), null);
  assert.equal(normalizePathPattern("/a/**/b"), null);
  assert.equal(normalizePathPattern("/a*b"), null);
  assert.equal(normalizePathPattern("/a?x=1"), null);
});

test("matchesRule: 출처는 정확히, 쿼리·해시 무시", () => {
  const r = { origin: "https://medium.com", path: "/*/*" };
  assert.equal(matchesRule(r, "https://medium.com/@u/post-1?source=x#h"), true);
  assert.equal(matchesRule(r, "https://evil.medium.com/@u/post-1"), false);
  assert.equal(matchesRule(r, "http://medium.com/@u/post-1"), false);
  assert.equal(matchesRule(r, "chrome://settings"), false);
});

test("defaultPattern: 마지막 세그먼트를 *로", () => {
  assert.equal(defaultPattern("https://medium.com/@u/my-post?x=1"), "/@u/*");
  assert.equal(defaultPattern("https://a.com/"), "/");
  assert.equal(defaultPattern("https://a.com/x"), "/*");
});

test("normalizeRuleInput·parseRules·ruleFor", () => {
  assert.throws(() => normalizeRuleInput({ origin: "ftp://a.com", path: "/", request: "x" }));
  assert.throws(() => normalizeRuleInput({ origin: "https://a.com", path: "/", request: "  " }));
  const n = normalizeRuleInput({ origin: "https://a.com/x/y", path: "/x/*", label: "", request: "이 글 번역해줘" });
  assert.deepEqual(n, { origin: "https://a.com", path: "/x/*", label: "이 글 번역해줘", request: "이 글 번역해줘" });
  const rules = parseRules([
    { id: "1", ...n, enabled: false, version: 2, createdAt: 1 },
    { id: "2", ...n, path: "/x/**", enabled: true, version: 1, createdAt: 2 },
    { id: "", ...n },
    { bad: true },
  ]);
  assert.equal(rules.length, 2);
  assert.equal(ruleFor(rules, "https://a.com/x/1")?.id, "2");
  assert.equal(ruleFor(rules, "https://b.com/x/1"), null);
});

test("normalizeRuleInput: 긴 요청은 자르지 않고 거절", () => {
  assert.throws(() => normalizeRuleInput({ origin: "https://a.com", path: "/", request: "가".repeat(501) }), /500자/);
  assert.equal(normalizeRuleInput({ origin: "https://a.com", path: "/", request: "가".repeat(500) }).request.length, 500);
});
