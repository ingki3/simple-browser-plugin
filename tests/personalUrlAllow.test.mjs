import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSONAL_URL_REASON, autoApproveBlock, personalOnlyUrl, personalUrlKey, sensitiveUrlReason } from "../src/lib/autoApprove.ts";

const t = (over = {}) => ({
  tag: "button", role: "button", name: "", href: "", region: "main", inFrame: false,
  fieldType: "", sensitive: null, context: "", ...over,
});
const SRT = "https://etk.srail.kr/hpg/hra/01/selectScheduleList.do?pageId=TK0101010000";

test("personalOnlyUrl: only a personal-looking signal, nothing else", () => {
  assert.equal(sensitiveUrlReason(SRT), PERSONAL_URL_REASON);
  assert.equal(personalOnlyUrl(SRT), true);
  assert.equal(personalOnlyUrl("https://etk.srail.kr/main.do"), false);
  // 감싼 주소 안에 계정 정보·결제 경로가 있으면 허용 대상이 아니다(바깥 주소의 첫 이유가 개인정보여도).
  const account = "https://etk.srail.kr/go?pageId=TK0101010000&next=https%3A%2F%2Falice%3Apw%40etk.srail.kr%2Fhome";
  assert.equal(sensitiveUrlReason(account), PERSONAL_URL_REASON);
  assert.equal(personalOnlyUrl(account), false);
  assert.equal(personalOnlyUrl("https://etk.srail.kr/checkout?pageId=TK0101010000"), false);
  assert.equal(personalOnlyUrl("about:undecodable"), false);
});

test("sensitiveUrlReason keeps reporting the first reason in order", () => {
  assert.equal(sensitiveUrlReason("https://a.example/pay?x=1"), "결제·주문 주소");
  assert.equal(sensitiveUrlReason("https://u:p@a.example/"), "계정 정보가 실린 주소");
  assert.equal(sensitiveUrlReason("https://a.example/?phone=01012345678"), PERSONAL_URL_REASON);
  assert.equal(sensitiveUrlReason("https://a.example/"), null);
});

test("deferPersonalUrls collects personal-only URLs and keeps checking the rest", () => {
  const click = t({ name: "조회", submitTo: SRT, aroundFormActions: [SRT] });
  assert.match(autoApproveBlock("click_element", [click]), /개인정보가 실린 주소/);
  const deferred = new Map();
  assert.equal(autoApproveBlock("click_element", [click], [], { deferPersonalUrls: deferred }), null);
  assert.deepEqual([...deferred.values()], [SRT]);

  // 다른 신호(제출 문구, 개인정보가 채워진 양식, 감싼 계정 정보)는 그대로 막는다.
  for (const other of [
    t({ name: "가입하기", submitTo: SRT }),
    t({ name: "조회", submitTo: SRT, submitsPersonal: true }),
    t({ name: "조회", submitTo: SRT, href: "https://u:p@etk.srail.kr/" }),
  ]) {
    assert.ok(autoApproveBlock("click_element", [other], [], { deferPersonalUrls: new Map() }), other.name);
  }
});

test("htmx request URLs are never deferred", () => {
  const deferred = new Map();
  const why = autoApproveBlock("click_element", [t({ name: "조회", requestUrls: [SRT] })], [], { deferPersonalUrls: deferred });
  assert.match(why, /개인정보가 실린 주소/);
  assert.equal(deferred.size, 0);
  const fillWhy = autoApproveBlock(
    "fill_form_fields",
    [t({ tag: "input", fieldType: "text", name: "역", requestUrls: [SRT] })],
    ["수서"],
    { deferPersonalUrls: new Map() },
  );
  assert.match(fillWhy, /개인정보가 실린 주소/);
});

test("fills defer form actions, including the click check of checkboxes", () => {
  const text = t({ tag: "input", fieldType: "text", name: "출발역", aroundFormActions: [SRT] });
  const deferred = new Map();
  assert.equal(autoApproveBlock("fill_form_fields", [text], ["수서"], { deferPersonalUrls: deferred }), null);
  assert.deepEqual([...deferred.values()], [SRT]);

  const box = t({ tag: "input", role: "checkbox", fieldType: "checkbox", name: "선택", ancestorHref: SRT });
  assert.ok(autoApproveBlock("fill_form_fields", [box], ["true"]));
  const boxDeferred = new Map();
  assert.equal(autoApproveBlock("fill_form_fields", [box], ["true"], { deferPersonalUrls: boxDeferred }), null);
  assert.deepEqual([...boxDeferred.values()], [SRT]);
});

test("mixed URLs: every personal-only URL is collected", () => {
  const other = "https://etk.srail.kr/x?tel=01099998888";
  const deferred = new Map();
  assert.equal(
    autoApproveBlock("click_element", [t({ name: "조회", submitTo: SRT, scopeFormActions: [other] })], [], { deferPersonalUrls: deferred }),
    null,
  );
  assert.deepEqual([...deferred.values()].sort(), [SRT, other].sort());
});

test("personalUrlKey: exact string, except a form submission that only appends clean fields to its action", () => {
  const acts = [SRT];
  assert.equal(personalUrlKey(SRT, acts), SRT);
  // 양식 칸 값을 덧붙인 제출 주소는 그 action의 열쇠.
  assert.equal(personalUrlKey(`${SRT}&dpt=${encodeURIComponent("수서")}`, acts), SRT);
  assert.equal(personalUrlKey(`${SRT}&dpt=${encodeURIComponent("부산")}&date=20261028`, acts), SRT);
  // action이 목록에 없으면(링크 주소 등) 글자 그대로 — 평범한 매개변수가 달라도 다른 열쇠(리뷰 P1: public=0 → public=1).
  const link0 = "https://portal.example/settings?pageId=TK0101010000&public=0";
  const link1 = "https://portal.example/settings?pageId=TK0101010000&public=1";
  assert.notEqual(personalUrlKey(link1), personalUrlKey(link0));
  assert.notEqual(personalUrlKey(link1, [link0]), personalUrlKey(link0, [link0]));
  // 덧붙은 값에 개인정보 신호가 있거나, action의 매개변수를 바꾸거나 다른 경로·출처·해시면 action 열쇠가 아니다.
  for (const u of [
    `${SRT}&tel=01099998888`,
    `${SRT}&memo=01099998888`,
    `${SRT}&name=${encodeURIComponent("홍길동")}`,
    "https://etk.srail.kr/hpg/hra/01/selectScheduleList.do?pageId=TK0101019999&dpt=x",
    "https://etk.srail.kr/other.do?pageId=TK0101010000&dpt=x",
    "https://evil.example/hpg/hra/01/selectScheduleList.do?pageId=TK0101010000&dpt=x",
    `${SRT}&dpt=x#h`,
  ]) {
    assert.equal(personalUrlKey(u, acts), u, u);
  }
  // 덧붙지 않고 같은 길이면 action 열쇠가 아니다.
  assert.equal(personalUrlKey(SRT.replace("TK0101010000", "TK0101010001"), acts), SRT.replace("TK0101010000", "TK0101010001"));
});

test("deferred keys merge the same form across value changes", () => {
  const a = t({ name: "조회", submitTo: SRT, submitUrl: `${SRT}&dpt=` });
  const b = t({ name: "조회", submitTo: SRT, submitUrl: `${SRT}&dpt=${encodeURIComponent("수서")}` });
  const da = new Map();
  const db = new Map();
  assert.equal(autoApproveBlock("click_element", [a], [], { deferPersonalUrls: da }), null);
  assert.equal(autoApproveBlock("click_element", [b], [], { deferPersonalUrls: db }), null);
  assert.deepEqual([...da.keys()], [SRT]);
  assert.deepEqual([...db.keys()], [SRT]);
  // 링크 주소는 action과 묶이지 않는다.
  const link = t({ tag: "a", role: "link", name: "설정", href: `${SRT}&public=1`, aroundFormActions: [SRT] });
  const dl = new Map();
  autoApproveBlock("click_element", [link], [], { deferPersonalUrls: dl });
  assert.deepEqual([...dl.keys()].sort(), [SRT, `${SRT}&public=1`].sort());
});
