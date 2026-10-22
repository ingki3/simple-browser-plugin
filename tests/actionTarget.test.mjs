import test from "node:test";
import assert from "node:assert/strict";

import {
  clickCard,
  describeDifference,
  describeEffect,
  fillCard,
  navKind,
  parseCheckedRequest,
  sameApproved,
  sameApprovedInFlight,
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
  context: "",
};

test("sameBase: 기본 항목 중 하나라도 다르면 다른 대상", () => {
  assert.equal(sameBase(link, { ...link }), true);
  assert.equal(sameBase(link, { ...link, name: "이전 글" }), false);
  assert.equal(sameBase(link, { ...link, href: "https://ex.test/board/view?id=13" }), false);
  assert.equal(sameBase(link, { ...link, region: "nav" }), false);
  assert.equal(sameBase(link, { ...link, inFrame: true }), false);
  // 같은 버튼 노드가 다른 행에 다시 쓰이면 행 글자가 달라진다.
  assert.equal(sameBase({ ...link, context: "A 문서 삭제" }, { ...link, context: "B 문서 삭제" }), false);
  // 모델에 돌려준 이름만 바뀌어도(원문은 같아도) 다른 대상이다.
  assert.equal(sameBase({ ...link, modelName: "다음 글" }, { ...link, modelName: "광고" }), false);
  // 목록 위치는 기본 비교에서 보지 않는다.
  assert.equal(sameBase(link, { ...link, list: { index: 2, count: 5 } }), true);
});

test("sameBase: 모델용 묶음 문맥과 상태도 비교한다(#43 B)", () => {
  const day = { ...link, tag: "a", role: "link", name: "29", modelContext: "2026년 12월 · 일 월 화 …" };
  assert.equal(sameBase(day, { ...day }), true);
  // 원문 행 글자는 같고 모델에 준 묶음 문맥만 달라도 다른 대상이다.
  assert.equal(sameBase(day, { ...day, modelContext: "2027년 1월 · 일 월 화 …" }), false);
  assert.match(describeDifference(day, { ...day, modelContext: "x" }), /행의 내용/);
  // 상태는 순서와 관계없이 같은 값이면 같다.
  const opt = { ...link, role: "menuitemcheckbox", states: { checked: "false", disabled: "true" } };
  assert.equal(sameBase(opt, { ...opt, states: { disabled: "true", checked: "false" } }), true);
  assert.equal(sameBase(opt, { ...opt, states: { checked: "true", disabled: "true" } }), false);
  assert.equal(sameBase(opt, { ...opt, states: undefined }), false);
  assert.match(describeDifference(opt, { ...opt, states: { checked: "true" } }), /상태/);
  // 트리거 관계 정보는 기본 비교에 넣지 않는다(content script가 따로 다시 확인한다).
  assert.equal(sameBase({ ...opt, popup: "linked" }, { ...opt, popup: "unlinked" }), true);
});

test("clickCard: 선택지의 트리거를 보여 준다", () => {
  const opt = { ...link, tag: "div", role: "option", name: "빨강", href: "" };
  const trigger = { ...link, tag: "div", role: "combobox", name: "색상 선택", href: "" };
  assert.match(clickCard({ ...opt, trigger }).details, /열린 목록의 트리거: 선택 상자 '색상 선택'/);
});

test("sameApproved: 목록 순번은 같아야 하고 항목 수는 늘어도 된다", () => {
  const a = { ...link, list: { index: 3, count: 10, semantic: true } };
  assert.equal(sameApproved(a, { ...a, list: { index: 3, count: 20, semantic: true } }), true);
  assert.equal(sameApproved(a, { ...a, list: { index: 4, count: 10, semantic: true } }), false);
  assert.equal(sameApproved(a, { ...a, list: null }), false);
  assert.equal(sameApproved({ ...link, list: null }, { ...link, list: null }), true);
});

test("describeDifference는 바뀐 항목을 짚는다", () => {
  // 글자는 모델에 돌려준 이름만 인용한다(원문 이름에는 입력 칸·편집 영역 글자가 섞일 수 있다).
  const named = { ...link, modelName: "다음 글" };
  assert.match(describeDifference(named, { ...named, name: "광고", modelName: "광고" }), /'다음 글' → '광고'/);
  assert.equal(describeDifference(named, { ...named, name: "다음 글 비밀초안" }), "글자가 바뀜");
  assert.doesNotMatch(describeDifference(named, { ...named, name: "다음 글 비밀초안" }), /비밀초안/);
  assert.equal(describeDifference(link, { ...link, href: "x" }), "링크 주소가 바뀜");
  assert.equal(describeDifference(link, { ...link, sensitive: "password" }), "입력 칸 종류가 바뀜");
  assert.equal(describeDifference(link, { ...link, context: "다른 행" }), "대상이 든 행의 내용이 바뀜");
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
  assert.doesNotMatch(card.details, /행 내용/);
  assert.match(clickCard({ ...link, name: "삭제", context: "보고서.hwp 3KB 삭제" }).details, /행 내용: '보고서\.hwp 3KB 삭제'/);
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
  assert.equal(
    describeEffect({ ...base, dom: { mutations: 0, dialogOpened: false, frameNavigated: true } }),
    "페이지 안 프레임이 다른 문서로 이동했습니다.",
  );
  assert.match(
    describeEffect({ ...base, dom: { mutations: 0, dialogOpened: false, aborted: "링크 주소가 바뀜" } }),
    /^누르기 직전에 대상이 바뀌어 클릭하지 않았습니다\(링크 주소가 바뀜\)/,
  );
  assert.equal(describeEffect({ ...base, navigation: "error", sameDocument: false }), "이동했지만 오류 페이지입니다.");
});

// #56: 목록 행 체크박스(숨긴 칸 + 보이는 label, 행 문맥).
const rowBox = {
  tag: "input",
  role: "checkbox",
  name: "",
  modelName: "",
  href: "",
  region: "main",
  inFrame: false,
  fieldType: "checkbox",
  sensitive: null,
  context: "카닥 이용약관 개정 안내 10:21",
  modelContext: "카닥 이용약관 개정 안내 10:21",
  proxy: true,
};

test("sameBase: 입력 칸의 행 문맥과 보이는 label로 바꾸는지도 비교한다(#56)", () => {
  assert.equal(sameBase(rowBox, { ...rowBox }), true);
  // 행이 바뀌면(목록 갱신으로 같은 칸 노드가 다른 메일 행에 쓰임) 다른 대상.
  assert.equal(sameBase(rowBox, { ...rowBox, modelContext: "보안 안내 09:00" }), false);
  // 보이는 label이 사라지거나 칸이 보이게 되면 다른 대상.
  assert.equal(sameBase(rowBox, { ...rowBox, proxy: undefined }), false);
  assert.match(describeDifference(rowBox, { ...rowBox, proxy: false }), /보이는 라벨이 바뀜/);
});

test("sameApprovedInFlight: 원문 행 글자가 그대로면 모델용 행 문맥만 바뀐 것은 허용한다(#56, #43 C)", () => {
  const field = { ...rowBox, tag: "input", fieldType: "email", proxy: undefined, context: "이메일 형식이 아닙니다", modelContext: "이메일" };
  // 입력 처리기가 행 안의 숨은 안내 글을 보이게 함 → 원문은 같고 모델용 글자만 늘어남.
  assert.equal(sameApprovedInFlight({ ...field, modelContext: "이메일 형식이 아닙니다" }, field), true);
  // 승인 카드·실행 직전 비교(sameApproved)는 그대로 엄격하다.
  assert.equal(sameApproved({ ...field, modelContext: "이메일 형식이 아닙니다" }, field), false);
  // 원문 행 글자가 바뀌면 입력 도중이어도 다른 대상.
  assert.equal(sameApprovedInFlight({ ...field, context: "다른 행", modelContext: "다른 행" }, field), false);
  // 그 밖의 항목은 그대로 비교한다.
  assert.equal(sameApprovedInFlight({ ...field, name: "비밀번호" }, field), false);
  assert.equal(sameApprovedInFlight({ ...field, list: { index: 2, count: 5, semantic: true } }, { ...field, list: { index: 3, count: 5, semantic: true } }), false);
});

test("parseCheckedRequest: 참·거짓 외의 값은 지정 오류", () => {
  assert.equal(parseCheckedRequest("true"), true);
  assert.equal(parseCheckedRequest(" 체크 "), true);
  assert.equal(parseCheckedRequest("False"), false);
  assert.equal(parseCheckedRequest("off"), null);
});

test("fillCard: 이름 없는 칸·이름이 겹치는 칸은 행 문맥을 보여 준다(#56)", () => {
  const card = fillCard([
    { info: rowBox, value: "true" },
    { info: { ...rowBox, modelContext: "네이버 보안 안내 09:00", proxy: undefined, hidden: false }, value: "false" },
  ]);
  const lines = card.details.split("\n");
  assert.match(lines[0], /^• \(이름 없는 칸\) — 행: '카닥 이용약관 개정 안내 10:21' \(checkbox, 본문\): ☑ 체크/);
  assert.match(lines[1], /행: '네이버 보안 안내 09:00'.*: ☐ 해제$/);
  // 숨긴 칸은 보이는 label을 누른다는 경고.
  assert.doesNotMatch(lines[0], /보이지 않는 칸/);
  assert.match(fillCard([{ info: { ...rowBox, hidden: true }, value: "true" }]).details, /⚠ 화면에 보이지 않는 칸\(보이는 라벨을 눌러 바꿈\)/);
  // checkbox·radio는 이름이 있고 한 칸만 채워도 행 문맥을 보여 준다(모든 행 체크박스가 '메일 선택'인 목록).
  const named = { ...rowBox, name: "메일 선택" };
  assert.match(fillCard([{ info: named, value: "true" }]).details, /메일 선택 — 행: '카닥 이용약관 개정 안내 10:21'/);
  // 글자 칸은 이름이 겹칠 때만 행 문맥을 붙인다.
  const qty = { ...rowBox, name: "수량", fieldType: "number", proxy: undefined, modelContext: "상품 A" };
  assert.doesNotMatch(fillCard([{ info: qty, value: "2" }]).details, /행:/);
  assert.match(fillCard([{ info: qty, value: "2" }, { info: { ...qty, modelContext: "상품 B" }, value: "1" }]).details, /수량 — 행: '상품 B'/);
  // 원문 행 글자(context)는 카드에 쓰지 않는다(모델용 글자만).
  assert.doesNotMatch(fillCard([{ info: { ...rowBox, context: "RAW_ONLY", modelContext: "" }, value: "true" }]).details, /RAW_ONLY/);
});

test("clickCard: 체크 위젯은 지금 상태를 보여 준다(#56)", () => {
  const box = { ...link, tag: "div", role: "checkbox", name: "", href: "", states: { checked: "false" } };
  assert.match(clickCard(box).details, /대상: 체크박스 .*\n[\s\S]*지금 상태: 체크 안 됨/);
  assert.match(clickCard({ ...box, states: { checked: "true" } }).details, /지금 상태: 체크됨/);
  assert.doesNotMatch(clickCard(link).details, /지금 상태/);
});
