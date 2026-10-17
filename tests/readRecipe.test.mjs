import test from "node:test";
import assert from "node:assert/strict";

import {
  RECIPE_MAX_AGE_MS,
  RECIPE_MAX_FAILURES,
  RECIPE_MAX_PER_PAGE,
  applyObservations,
  hintsFor,
  pruneRecipes,
  recipeArgs,
  usefulResult,
} from "../src/lib/readRecipe.ts";

const page = { origin: "https://ex.test", pattern: "/board/{n}/view?id", skeleton: "abcd1234" };
const other = { ...page, skeleton: "ffff0000" };

test("recipeArgs: 남길 인자만 고르고 개인정보가 보이면 거부", () => {
  assert.deepEqual(recipeArgs("query_dom", { selector: ".board_view", limit: 5 }), {
    tool: "query_dom",
    args: { selector: ".board_view", limit: 5 },
  });
  assert.deepEqual(recipeArgs("query_dom", { selector: 'a[href*="download"]', attr: "href" }).args, {
    selector: 'a[href*="download"]',
    attr: "href",
  });
  assert.equal(recipeArgs("query_dom", { selector: 'a[href="mailto:alice@example.com"]' }), null);
  assert.equal(recipeArgs("query_dom", { selector: 'a[href^="https://ex.test/"]' }), null);
  assert.equal(recipeArgs("query_dom", { selector: "#post-1234567" }), null);
  assert.equal(recipeArgs("query_dom", { selector: '[data-token="Xk9pQ2wzAbc"]' }), null);
  assert.deepEqual(recipeArgs("list_file_links", { query: "첨부", limit: 10 }), { tool: "list_file_links", args: { query: "첨부" } });
  assert.equal(recipeArgs("list_file_links", {}), null);
  assert.equal(recipeArgs("list_file_links", { query: "alice@example.com" }), null);
  assert.deepEqual(recipeArgs("find_clickables", { query: "다음 글", region: "main" }).args, { query: "다음 글", region: "main" });
  assert.equal(recipeArgs("get_page_content", {}), null);
  assert.equal(recipeArgs("click_element", { id: "c1" }), null);
});

test("usefulResult: 비어 있지 않아야 쓸모 있음", () => {
  assert.equal(usefulResult("query_dom", [{ text: "본문", attrs: {} }]), true);
  assert.equal(usefulResult("query_dom", [{ text: "  ", attrs: { href: "" } }]), false);
  assert.equal(usefulResult("query_dom", [{ text: "", attrs: { href: "/f" } }]), true);
  assert.equal(usefulResult("query_dom", []), false);
  assert.equal(usefulResult("list_file_links", { links: [{}] }), true);
  assert.equal(usefulResult("list_file_links", { links: [] }), false);
  assert.equal(usefulResult("find_clickables", [{}]), true);
  assert.equal(usefulResult("find_clickables", []), false);
});

const q = (selector, useful, p = page) => ({ page: p, tool: "query_dom", args: { selector }, useful });

test("applyObservations: 같은 턴에서 마지막으로 쓸모 있던 호출만 성공", () => {
  const r = applyObservations([], [q(".content", true), q(".wrong", false), q(".board_view", true)], 100);
  assert.equal(r.length, 1);
  assert.equal(r[0].args.selector, ".board_view");
  assert.equal(r[0].successes, 1);
  const r2 = applyObservations(r, [q(".board_view", true)], 200);
  assert.equal(r2[0].successes, 2);
  assert.equal(r2[0].lastUsed, 200);
});

test("applyObservations: 있는 레시피가 빈 결과면 실패, 3번이면 꺼짐, 성공하면 실패 수 초기화", () => {
  let r = applyObservations([], [q(".board_view", true)], 1);
  r = applyObservations(r, [q(".board_view", false)], 2);
  assert.equal(r[0].failures, 1);
  r = applyObservations(r, [q(".board_view", true)], 3);
  assert.equal(r[0].failures, 0);
  for (let i = 0; i < RECIPE_MAX_FAILURES; i++) r = applyObservations(r, [q(".board_view", false)], 10 + i);
  assert.equal(r.length, 0);
  // 레시피가 없는 빈 결과는 아무것도 남기지 않는다.
  assert.deepEqual(applyObservations([], [q(".x", false)], 1), []);
});

test("hintsFor: 뼈대까지 같은 페이지만, 성공 많은 순", () => {
  let r = applyObservations([], [q(".a", true)], 1);
  r = applyObservations(r, [{ page, tool: "list_file_links", args: { query: "첨부" }, useful: true }], 2);
  r = applyObservations(r, [{ page, tool: "list_file_links", args: { query: "첨부" }, useful: true }], 3);
  r = applyObservations(r, [q(".other", true, other)], 4);
  const hints = hintsFor(r, page, 5);
  assert.deepEqual(hints.map((h) => h.tool), ["list_file_links", "query_dom"]);
  assert.equal(hints[0].successes, 2);
  assert.deepEqual(hintsFor(r, { ...page, skeleton: "" }, 5), []);
  assert.deepEqual(hintsFor(r, { ...page, pattern: "/other" }, 5), []);
});

test("pruneRecipes: 페이지당 개수·나이 한도, 깨진 값은 버림", () => {
  const obs = Array.from({ length: RECIPE_MAX_PER_PAGE + 2 }, (_, i) => [q(`.s${i}`, true)]);
  let r = [];
  obs.forEach((o, i) => (r = applyObservations(r, o, i + 1)));
  assert.equal(r.length, RECIPE_MAX_PER_PAGE);
  assert.ok(r.every((x) => x.lastUsed > 2));
  assert.deepEqual(pruneRecipes(r, 10 + RECIPE_MAX_AGE_MS), []);
  assert.deepEqual(pruneRecipes([null, "x", { page: 1 }], 0), []);
  assert.deepEqual(pruneRecipes(undefined, 0), []);
});
