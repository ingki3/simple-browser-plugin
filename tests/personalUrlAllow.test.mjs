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

test("personalUrlKey: plain merged values may change, flagged parts may not", () => {
  const base = personalUrlKey(SRT);
  assert.ok(base.startsWith("key:"));
  // 양식 값(역 이름)이 붙거나 바뀌어도 같은 열쇠.
  assert.equal(personalUrlKey(`${SRT}&dpt=${encodeURIComponent("수서")}`), base);
  assert.equal(personalUrlKey(`${SRT}&dpt=${encodeURIComponent("부산")}&date=20261028`), base);
  // 걸린 값이 바뀌거나 개인정보 모양 값이 새로 붙으면 다른 열쇠.
  assert.notEqual(personalUrlKey("https://etk.srail.kr/hpg/hra/01/selectScheduleList.do?pageId=TK0101019999"), base);
  assert.notEqual(personalUrlKey(`${SRT}&tel=01099998888`), base);
  assert.notEqual(personalUrlKey(`${SRT}&memo=01099998888`), base);
  assert.notEqual(personalUrlKey(`${SRT}&name=${encodeURIComponent("홍길동")}`), base);
  // 다른 경로·출처·해시는 다른 열쇠.
  assert.notEqual(personalUrlKey("https://etk.srail.kr/other.do?pageId=TK0101010000"), base);
  assert.notEqual(personalUrlKey("https://evil.example/hpg/hra/01/selectScheduleList.do?pageId=TK0101010000"), base);
  assert.notEqual(personalUrlKey(`${SRT}#x`), base);
  // 경로에 신호가 있으면 글자 그대로.
  const pathy = "https://a.example/u/010-1234-5678?pageId=TK0101010000";
  assert.equal(personalUrlKey(pathy), `raw:${pathy}`);
  assert.notEqual(personalUrlKey(`${pathy}&dpt=x`), personalUrlKey(pathy));
});

test("deferred keys merge the same form across value changes", () => {
  const a = t({ name: "조회", submitTo: SRT, submitUrl: `${SRT}&dpt=` });
  const b = t({ name: "조회", submitTo: SRT, submitUrl: `${SRT}&dpt=${encodeURIComponent("수서")}` });
  const da = new Map();
  const db = new Map();
  autoApproveBlock("click_element", [a], [], { deferPersonalUrls: da });
  autoApproveBlock("click_element", [b], [], { deferPersonalUrls: db });
  assert.equal(da.size, 1);
  assert.deepEqual([...da.keys()], [...db.keys()]);
});
