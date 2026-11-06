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

// #242: query 0개 진단·안내.
import { emptyZeroDiag, SCREEN_TEXT_NOTE, zeroDiagText, zeroMatchNote } from "../src/lib/clickQuery.ts";

const diag = (over = {}) => {
  const d = emptyZeroDiag();
  return { ...d, ...over, outside: { ...d.outside, ...(over.outside ?? {}) }, rejected: { ...d.rejected, ...(over.rejected ?? {}) } };
};

test("zeroMatchNote: 후보가 있으면 수와 실제 매칭 규칙(이름·주소)·되풀이 금지를 알린다", () => {
  const t = zeroMatchNote(136, diag({ candidates: 136 }));
  assert.match(t, /조건 없이 찾으면 클릭 가능 요소가 136개/);
  assert.match(t, /이름\(text — aria-label 같은 접근성 이름이 있으면 그것\)과 주소에 맞춥니다/);
  assert.match(t, /matchContext=true/);
  assert.match(t, /같은 query를 되풀이하지 마세요/);
  assert.doesNotMatch(t, /화면 글자에 그대로 들어 있어야/);
  assert.doesNotMatch(t, /클릭 후보\(링크·버튼·선택 위젯\)가 아닌/);
});

test("zeroMatchNote: query 없는 0개(진단 없음)는 수와 조건 빼기 안내만", () => {
  const t = zeroMatchNote(2, null);
  assert.match(t, /2개 있습니다\. 조건을 빼고 다시 찾으세요\.$/);
  assert.equal(zeroMatchNote(0, null), null);
});

test("zeroMatchNote: 후보 밖 화면 글자가 있으면(후보 0개여도) 클릭 후보가 아니라는 안내", () => {
  const none = zeroMatchNote(0, diag({ outside: { total: 3, aNoHref: 1, onclick: 1, tabindex: 1 } }));
  assert.match(none, /^화면 글자에는 query가 보이지만 클릭 후보\(링크·버튼·선택 위젯\)가 아닌 요소 안에/);
  const both = zeroMatchNote(5, diag({ candidates: 5, outside: { total: 1, none: 1 } }));
  assert.match(both, /5개 있습니다/);
  assert.match(both, /클릭 후보\(링크·버튼·선택 위젯\)가 아닌/);
});

test("zeroMatchNote: 후보가 전부 빠졌으면(숨김·aria-hidden 등) 뺀 사실 안내, 아무것도 없으면 null", () => {
  assert.match(zeroMatchNote(0, diag({ rejected: { ariaHidden: 1 } })), /숨겨졌거나\(aria-hidden 포함\)/);
  assert.match(zeroMatchNote(0, diag({ rejected: { hidden: 2 } })), /describe_page/);
  // 관계를 정하지 못한 선택지는 따로 안내하므로(unrelatedNote) 여기서는 세지 않는다.
  assert.equal(zeroMatchNote(0, diag({ rejected: { unrelated: 3 } })), null);
  assert.equal(zeroMatchNote(0, diag()), null);
  // 후보가 있으면 숨은 요소가 많아도(흔한 숨은 메뉴) 뺀 사실은 알리지 않는다.
  assert.doesNotMatch(zeroMatchNote(4, diag({ candidates: 4, rejected: { hidden: 9 } })), /숨겨졌거나/);
});

test("zeroDiagText: 수만 담은 한 줄, 상한 도달 표시", () => {
  const line = zeroDiagText(diag({ candidates: 136, nameNotScreen: 12, outside: { total: 17, aNoHref: 17 }, rejected: { hidden: 40, emptyName: 3 }, limited: true }));
  assert.equal(
    line,
    "후보 136 · 이름≠화면글자 12 · 후보 밖 화면글자 17(a무주소 17, onclick 0, tabindex 0, cursor 0, 신호없음 0) · 뺀 대상 숨김 40·aria-hidden 0·이름없음 3·비활성 0·관계없음 0 · 상한 도달",
  );
  assert.ok(!zeroDiagText(diag()).includes("상한"));
  assert.match(SCREEN_TEXT_NOTE, /화면 글자에 query가 있습니다/);
});
