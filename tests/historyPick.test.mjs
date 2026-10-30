import { test } from "node:test";
import assert from "node:assert/strict";
import { groupHistory, makeSnapshot, matchesSavedTemplate, parsePicks, shapeOf, MAX_PICKS } from "../src/lib/historyPick.ts";

const now = Date.UTC(2026, 9, 30);
const e = (url, o = {}) => ({ url, title: o.title ?? url, visitCount: o.v ?? 1, typedCount: o.t ?? 0, lastVisitTime: o.last ?? now });

test("shapeOf: 값·해시는 무시, 이름 중복·= 없는 이름은 구별", () => {
  assert.equal(shapeOf("https://a.com/s?q=1&x=2#h"), shapeOf("https://a.com/s?x=9&q=3"));
  assert.notEqual(shapeOf("https://a.com/s?q=1"), shapeOf("https://a.com/s?q=1&q=2"));
  assert.notEqual(shapeOf("https://a.com/s?flag"), shapeOf("https://a.com/s?flag="));
  assert.equal(shapeOf("ftp://a.com/x"), null);
  assert.equal(shapeOf("https://u:p@a.com/x"), null);
});

test("groupHistory: 같은 형태를 묶고 대표는 가장 최근, 값을 바꿔 쓴 흔적·직접 입력이 점수를 올린다", () => {
  const g = groupHistory(
    [
      e("https://shop.com/s?q=a", { v: 3, last: now - 1000 }),
      e("https://shop.com/s?q=b", { v: 2, last: now }),
      e("https://news.com/a/1", { v: 4 }),
      e("https://bank.com/pay", { v: 50 }),
    ],
    now,
    (x) => x.url.includes("bank"),
  );
  assert.equal(g.length, 2);
  assert.equal(g[0].url, "https://shop.com/s?q=b");
  assert.equal(g[0].visits, 5);
  assert.equal(g[0].distinct, 2);
  assert.ok(!g.some((x) => x.url.includes("bank")));
});

test("groupHistory: 상한", () => {
  const many = Array.from({ length: 50 }, (_, i) => e(`https://a.com/p${i}`));
  assert.equal(groupHistory(many, now, () => false).length, 30);
});

test("matchesSavedTemplate: 보수적 비교", () => {
  const tpl = { base: "https://a.com/search", params: [{ key: "q", slot: "검색어" }], hash: "" };
  assert.equal(matchesSavedTemplate("https://a.com/search?q=books", tpl), true);
  assert.equal(matchesSavedTemplate("https://a.com/search?category=books", tpl), false);
  assert.equal(matchesSavedTemplate("https://a.com/search?q=a&q=b", tpl), false);
  assert.equal(matchesSavedTemplate("https://a.com/search?q=a#x", tpl), false);
  const fixed = { base: "https://a.com/s", params: [{ key: "q", slot: "검색어" }, { key: "sort", value: "price" }, { key: "flag", bare: true }], hash: "" };
  assert.equal(matchesSavedTemplate("https://a.com/s?q=1&sort=price&flag", fixed), true);
  assert.equal(matchesSavedTemplate("https://a.com/s?q=1&sort=date&flag", fixed), false);
  assert.equal(matchesSavedTemplate("https://a.com/s?q=1&sort=price&flag=", fixed), false);
});

test("makeSnapshot: 쿼리 값 없음, 위치 번호, 길이 상한", () => {
  const long = "k".repeat(40);
  const params = Array.from({ length: 12 }, (_, i) => `${i === 0 ? long : "p" + i}=secret${i}`).join("&");
  const [s] = makeSnapshot([{ url: `https://a.com/x?${params}`, title: "  제목   이름 ", visits: 1, typed: 0, last: now, distinct: 1, score: 1 }]);
  assert.equal(s.title, "제목 이름");
  assert.equal(s.base, "https://a.com/x");
  assert.equal(s.params.length, 10);
  assert.equal(s.params[0].key.length, 30);
  assert.deepEqual(s.params.map((p) => p.p), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(!JSON.stringify(s).includes("secret"));
});

test("parsePicks: 보낸 항목만, 정수·중복 없음·최대 8개, params는 스냅샷 위치만", () => {
  const snapshot = makeSnapshot([
    { url: "https://a.com/s?q=1&q=2&trk=x", title: "A", visits: 1, typed: 0, last: now, distinct: 1, score: 1 },
    { url: "https://b.com/", title: "B", visits: 1, typed: 0, last: now, distinct: 1, score: 1 },
  ]);
  const text = JSON.stringify({
    picks: [
      { index: 0, name: "A 검색", purpose: "검색", reason: "자주 씀", params: [{ p: 0, mode: "slot", slot: "검색어" }, { p: 1, mode: "slot", slot: "검색어2" }, { p: 2, mode: "drop" }, { p: 7, mode: "drop" }] },
      { index: 0, name: "중복" },
      { index: 1, name: "보내지 않은 항목" },
      { index: 1.5 },
      { index: "0" },
    ],
  });
  const picks = parsePicks(text, new Set([0]), snapshot, () => 3);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].name, "A 검색");
  assert.deepEqual(picks[0].draft.choices, [{ mode: "slot", slot: "검색어" }, { mode: "slot", slot: "검색어2" }, { mode: "drop" }]);
  assert.equal(parsePicks("not json", new Set([0]), snapshot, () => 3), null);
  const many = { picks: Array.from({ length: 20 }, (_, i) => ({ index: i, name: `n${i}` })) };
  const snap20 = makeSnapshot(Array.from({ length: 20 }, (_, i) => ({ url: `https://a.com/${i}`, title: `t${i}`, visits: 1, typed: 0, last: now, distinct: 1, score: 1 })));
  assert.equal(parsePicks(JSON.stringify(many), new Set(snap20.map((s) => s.i)), snap20, () => 0).length, MAX_PICKS);
});

test("makeSnapshot: 결제·개인정보 단서는 빼지 않고 warning으로 붙인다", () => {
  const g = (url) => ({ url, title: "t", visits: 1, typed: 0, last: now, distinct: 1, score: 1 });
  const snap = makeSnapshot([g("https://a.com/order/history"), g("https://a.com/books")], (u) => (u.includes("order") ? "주문" : null));
  assert.equal(snap.length, 2);
  assert.equal(snap[0].warning, "주문");
  assert.equal(snap[1].warning, undefined);
});
