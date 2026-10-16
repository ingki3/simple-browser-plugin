import test from "node:test";
import assert from "node:assert/strict";

import {
  clickCard,
  describeDifference,
  describeEffect,
  fillCard,
  navKind,
  sameApproved,
  sameBase,
} from "../src/lib/actionTarget.ts";

const link = {
  tag: "a",
  role: "link",
  name: "다음 글",
  href: "https://ex.test/board/view?id=12",
  region: "main",
  inFrame: false,
  fieldType: "",
  sensitive: null,
};

test("sameBase: 기본 항목 중 하나라도 다르면 다른 대상", () => {
  assert.equal(sameBase(link, { ...link }), true);
  assert.equal(sameBase(link, { ...link, name: "이전 글" }), false);
  assert.equal(sameBase(link, { ...link, href: "https://ex.test/board/view?id=13" }), false);
  assert.equal(sameBase(link, { ...link, region: "nav" }), false);
  assert.equal(sameBase(link, { ...link, inFrame: true }), false);
  // 목록 위치는 기본 비교에서 보지 않는다.
  assert.equal(sameBase(link, { ...link, list: { index: 2, count: 5 } }), true);
});

test("sameApproved: 목록 순번은 같아야 하고 항목 수는 늘어도 된다", () => {
  const a = { ...link, list: { index: 3, count: 10, semantic: true } };
  assert.equal(sameApproved(a, { ...a, list: { index: 3, count: 20, semantic: true } }), true);
  assert.equal(sameApproved(a, { ...a, list: { index: 4, count: 10, semantic: true } }), false);
  assert.equal(sameApproved(a, { ...a, list: null }), false);
  assert.equal(sameApproved({ ...link, list: null }, { ...link, list: null }), true);
});

test("describeDifference는 바뀐 항목을 짚는다", () => {
  assert.match(describeDifference(link, { ...link, name: "광고" }), /'다음 글' → '광고'/);
  assert.equal(describeDifference(link, { ...link, href: "x" }), "링크 주소가 바뀜");
  assert.equal(describeDifference(link, { ...link, sensitive: "password" }), "입력 칸 종류가 바뀜");
  assert.equal(
    describeDifference(
      { ...link, list: { index: 1, count: 3, semantic: true } },
      { ...link, list: { index: 2, count: 3, semantic: true } },
    ),
    "목록 안 순서가 바뀜",
  );
});

test("clickCard: 역할·이름·위치·주소를 보여 준다", () => {
  const card = clickCard({ ...link, list: { index: 3, count: 10, semantic: false } });
  assert.equal(card.summary, "링크 '다음 글'을(를) 클릭합니다.");
  assert.match(card.details, /대상: 링크 '다음 글'/);
  assert.match(card.details, /위치: 본문 · 목록 10개 중 3번째/);
  assert.match(card.details, /주소: https:\/\/ex\.test\/board\/view\?id=12/);
});

test("clickCard: 목록 표시가 없는 3~4개 묶음은 목록으로 말하지 않는다", () => {
  assert.doesNotMatch(clickCard({ ...link, list: { index: 2, count: 3, semantic: false } }).details, /목록/);
  assert.match(clickCard({ ...link, list: { index: 2, count: 3, semantic: true } }).details, /목록 3개 중 2번째/);
});

test("clickCard: 글자 없는 버튼은 경고한다", () => {
  const card = clickCard({ ...link, tag: "button", role: "button", name: "", href: "", inFrame: true });
  assert.match(card.summary, /^버튼 \(글자 없음\)/);
  assert.match(card.details, /페이지 안 프레임/);
  assert.match(card.details, /⚠ 글자가 없는 요소/);
  assert.doesNotMatch(card.details, /주소:/);
});

test("fillCard: 비밀번호는 가리고 결제 칸은 경고한다", () => {
  const field = { ...link, tag: "input", role: "textbox", href: "", fieldType: "text" };
  const card = fillCard([
    { info: { ...field, name: "이름" }, value: "홍길동" },
    { info: { ...field, name: "비밀번호", fieldType: "password", sensitive: "password" }, value: "hunter22" },
    { info: { ...field, name: "카드 번호", sensitive: "payment" }, value: "1234" },
  ]);
  assert.equal(card.summary, "입력 칸 3개에 값을 채웁니다.");
  assert.match(card.details, /• 이름 \(text, 본문\): 홍길동/);
  assert.match(card.details, /• 비밀번호 \(password, 본문\): ●{8} \(8자\) ⚠ 비밀번호 칸/);
  assert.doesNotMatch(card.details, /hunter22/);
  assert.match(card.details, /카드 번호 .*: 1234 ⚠ 결제 정보 칸/);
  assert.match(fillCard([{ info: { ...field, name: "숨은 칸", hidden: true }, value: "x" }]).details, /⚠ 화면에 보이지 않는 칸/);
});

test("fillCard: 10개 넘으면 나머지는 개수만", () => {
  const field = { ...link, tag: "input", role: "textbox", href: "", fieldType: "text" };
  const items = Array.from({ length: 12 }, (_, i) => ({ info: { ...field, name: `칸${i}` }, value: "v" }));
  const card = fillCard(items);
  assert.match(card.details, /… 그 외 2개$/);
  assert.equal(card.details.split("\n").length, 11);
});

test("navKind", () => {
  assert.equal(navKind("https://a.test/x", "https://a.test/x"), "none");
  assert.equal(navKind("https://a.test/x", "https://a.test/x#top"), "fragment");
  assert.equal(navKind("https://a.test/x#a", "https://a.test/x#b"), "fragment");
  assert.equal(navKind("https://a.test/x", "https://a.test/y"), "same_origin");
  assert.equal(navKind("https://a.test/x", "https://b.test/x"), "cross_origin");
  assert.equal(navKind("https://a.test/x", "chrome-error://chromewebdata/"), "error");
  assert.equal(navKind("https://a.test/x", ""), "none");
});

test("describeEffect", () => {
  const base = { navigation: "none", url: "https://a.test/x", sameDocument: true, newTab: false, dom: null };
  assert.match(describeEffect(base), /화면 변화가 감지되지 않았습니다/);
  assert.equal(
    describeEffect({ ...base, dom: { mutations: 4, dialogOpened: true } }),
    "대화상자가 열렸습니다, 화면이 바뀌었습니다(변경 4건).",
  );
  assert.equal(
    describeEffect({ ...base, navigation: "same_origin", url: "https://a.test/b?id=1", sameDocument: false }),
    "같은 사이트의 다른 페이지로 이동했습니다(/b?…).",
  );
  assert.match(
    describeEffect({ ...base, navigation: "same_origin", url: "https://a.test/b", sameDocument: true }),
    /페이지 안에서 주소만 바뀌었습니다/,
  );
  assert.match(
    describeEffect({ ...base, navigation: "cross_origin", url: "https://b.test/", sameDocument: false }),
    /다른 사이트\(b\.test\)로 이동/,
  );
  assert.match(describeEffect({ ...base, sameDocument: false }), /다시 불러왔습니다/);
  assert.match(describeEffect({ ...base, newTab: true }), /새 탭이 열렸습니다/);
  assert.equal(
    describeEffect({ ...base, navigation: "fragment", url: "https://a.test/x#install" }),
    "페이지 안 위치(#install)로 이동했습니다.",
  );
  assert.match(describeEffect({ ...base, sameDocument: null }), /응답하지 않습니다/);
  assert.equal(describeEffect({ ...base, navigation: "error", sameDocument: false }), "이동했지만 오류 페이지입니다.");
});
