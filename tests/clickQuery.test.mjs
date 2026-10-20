import { test } from "node:test";
import assert from "node:assert/strict";
import { clickMatchScore, queryTerms } from "../src/lib/clickQuery.ts";

test("query를 |로 나눠 소문자 낱말로 만든다", () => {
  assert.deepEqual(queryTerms(" 주문 | 배송||My Page "), ["주문", "배송", "my page"]);
  assert.deepEqual(queryTerms(undefined), []);
  assert.deepEqual(queryTerms(""), []);
});

test("글자에 맞으면 주소보다 점수가 높다", () => {
  const terms = queryTerms("주문|배송|order");
  assert.equal(clickMatchScore(terms, "주문확인/배송조회", "https://shopping.naver.com/my/order"), 5);
  assert.equal(clickMatchScore(terms, "고객센터", "https://x.com/order/list"), 1);
  assert.equal(clickMatchScore(terms, "베스트", "https://x.com/best"), 0);
});

test("낱말 하나면 예전처럼 부분일치 필터다", () => {
  const terms = queryTerms("Login");
  assert.ok(clickMatchScore(terms, "로그인", "https://x.com/login") > 0);
  assert.equal(clickMatchScore(terms, "로그인", "https://x.com/signin"), 0);
});
