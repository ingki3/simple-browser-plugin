// 원격 승인 질문(#185): 모델에 보낸 글·고정 문구로만 만들고, 만들 수 없으면 null(묻지 않고 거절).
import test from "node:test";
import assert from "node:assert/strict";

import { REMOTE_URL_MAX, remoteHopQuestion, remoteRefusal, remoteToolQuestion } from "../src/lib/remoteApproval.ts";
import { sameBase } from "../src/lib/actionTarget.ts";
import { askCallbackData, newAskId, parseAskCallback } from "../src/lib/telegram.ts";

const base = { guarded: false, block: null, chatGrantReason: null };
const target = (over = {}) => ({
  tag: "button",
  role: "",
  name: "원문 이름 비밀값",
  modelName: "구매하기",
  href: "",
  region: "main",
  inFrame: false,
  fieldType: "",
  sensitive: null,
  context: "원문 행 글자 사용자가 입력한 메모",
  modelContext: "상품 A · 구매하기",
  ...over,
});

test("이동: 전체 주소·출처·승인 효과를 보이고 너무 긴 주소는 묻지 않는다", () => {
  const q = remoteToolQuestion({ ...base, toolName: "navigate_to_url", url: "https://news.naver.com/section/101?x=1" });
  assert.ok(q);
  assert.match(q.text, /주소: https:\/\/news\.naver\.com\/section\/101\?x=1/);
  assert.match(q.text, /사이트: https:\/\/news\.naver\.com/);
  assert.match(q.text, /결제·삭제·개인정보 등은 계속 묻습니다/);
  const long = `https://a.example/?q=${"x".repeat(REMOTE_URL_MAX)}`;
  assert.equal(remoteToolQuestion({ ...base, toolName: "navigate_to_url", url: long }), null);
  assert.equal(remoteToolQuestion({ ...base, toolName: "navigate_to_url", url: "javascript:alert(1)" }), null);
});

test("클릭: 원문 name·context를 넣지 않고 모델용 글만 쓴다", () => {
  const q = remoteToolQuestion({ ...base, toolName: "click_element", target: target(), linkHrefs: [], pageUrl: "https://shop.example/cart" });
  assert.ok(q);
  assert.match(q.text, /페이지: https:\/\/shop\.example/);
  assert.match(q.text, /'구매하기'/);
  assert.match(q.text, /상품 A · 구매하기/);
  assert.doesNotMatch(q.text, /원문|비밀값|메모/);
});

test("클릭: 잘린 대상·이름 없음·출처 없음·다른 목적지가 섞이면 묻지 않는다", () => {
  const ok = { ...base, toolName: "click_element", linkHrefs: [], pageUrl: "https://shop.example/" };
  assert.equal(remoteToolQuestion({ ...ok, target: target({ modelNameClipped: true }) }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target({ modelContextClipped: true }) }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target({ modelName: "" }) }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: undefined }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target(), pageUrl: "chrome://newtab/" }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target({ href: "https://shop.example/a" }), linkHrefs: ["https://shop.example/a", "https://evil.example/?q=1"] }), null);
  assert.ok(remoteToolQuestion({ ...ok, target: target({ href: "https://shop.example/a" }), linkHrefs: ["https://shop.example/a"] }));
});

test("클릭: 체크 상태·대리 라벨·묻는 이유를 보인다(외부 본문 보호는 block 없이도)", () => {
  const q = remoteToolQuestion({
    ...base,
    guarded: true,
    toolName: "click_element",
    target: target({ states: { checked: "false" }, proxy: true }),
    linkHrefs: [],
    pageUrl: "https://shop.example/",
  });
  assert.ok(q);
  assert.match(q.text, /체크 안 됨 \(누르면 바뀝니다\)/);
  assert.match(q.text, /대신 보여 주는 라벨/);
  assert.match(q.text, /외부 문서 내용을 읽은 대화라 자동 실행하지 않음/);
  const b = remoteToolQuestion({ ...base, block: "결제 신호", toolName: "click_element", target: target(), linkHrefs: [], pageUrl: "https://shop.example/" });
  assert.match(b.text, /자동 실행 예외: 결제 신호/);
});

test("그 밖의 도구는 원격으로 묻지 않는다", () => {
  for (const toolName of ["fill_form_fields", "select_option", "sign_in", "read_linked_pages", "download_images"]) {
    assert.equal(remoteToolQuestion({ ...base, toolName, target: target(), pageUrl: "https://a.example/" }), null);
  }
});

test("한도 질문은 수치와 도구별 횟수만", () => {
  const q = remoteHopQuestion({ used: 12, extra: 12, total: 12, failed: 1, cancelled: 0, byTool: [{ tool: "click_element", count: 7 }] });
  assert.match(q.text, /12번 더 진행할까요/);
  assert.match(q.text, /click_element 7회/);
});

test("결과별 기록 문구", () => {
  assert.equal(remoteRefusal("denied").error, "remote_user_denied");
  assert.equal(remoteRefusal("cancelled").error, "remote_approval_cancelled");
  assert.equal(remoteRefusal("expired").error, "remote_approval_expired");
  assert.equal(remoteRefusal("unavailable").error, "remote_needs_approval");
});

test("잘림 플래그가 바뀌면 다른 대상으로 본다(표시 글자가 같아도)", () => {
  const a = target();
  assert.equal(sameBase(a, { ...a }), true);
  assert.equal(sameBase(a, { ...a, modelContextClipped: true }), false);
  assert.equal(sameBase(a, { ...a, modelNameClipped: true }), false);
});

test("텔레그램 버튼 데이터: 만들기·풀기, 모양이 틀리면 null", () => {
  const id = newAskId(new Uint8Array(16).fill(255));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(parseAskCallback(askCallbackData(id, true)), { askId: id, approve: true });
  assert.deepEqual(parseAskCallback(askCallbackData(id, false)), { askId: id, approve: false });
  assert.ok(askCallbackData(id, true).length <= 64);
  assert.equal(parseAskCallback(`a:${id}:yes`), null);
  assert.equal(parseAskCallback("a:short:y"), null);
  assert.equal(parseAskCallback(`x:${id}:y`), null);
});
