import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_APPROVE_TOOLS, autoApproveBlock, navigateAutoBlock } from "../src/lib/autoApprove.ts";

const t = (over = {}) => ({
  tag: "button", role: "button", name: "", href: "", region: "main", inFrame: false,
  fieldType: "", sensitive: null, context: "", ...over,
});

test("navigation, plain clicks and plain fills run automatically", () => {
  assert.equal(autoApproveBlock("navigate_to_url", []), null);
  assert.equal(autoApproveBlock("click_element", [t({ name: "검색" })]), null);
  assert.equal(autoApproveBlock("click_element", [t({ name: "다음 페이지" })]), null);
  assert.equal(autoApproveBlock("click_element", [t({ name: "Apply filters" })]), null);
  assert.equal(autoApproveBlock("fill_form_fields", [t({ tag: "input", fieldType: "text", name: "검색어" })]), null);
});

test("payment and order buttons still ask", () => {
  for (const name of ["결제하기", "바로 구매", "주문하기", "송금", "Checkout", "Buy now", "Place order", "Pay"]) {
    assert.ok(autoApproveBlock("click_element", [t({ name })]), name);
  }
});

test("sign-up, application and submit buttons still ask", () => {
  for (const name of ["회원가입", "신청하기", "제출", "본인인증", "인증번호 요청", "Sign up", "Submit"]) {
    assert.ok(autoApproveBlock("click_element", [t({ name })]), name);
  }
});

test("buttons of a form with filled personal values still ask", () => {
  assert.ok(autoApproveBlock("click_element", [t({ name: "다음", submitsPersonal: true })]));
});

test("password, payment and personal fields still ask", () => {
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "input", fieldType: "password", sensitive: "password" })]));
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "input", sensitive: "payment" })]));
  assert.match(
    autoApproveBlock("fill_form_fields", [t({ name: "검색어" }), t({ tag: "input", name: "휴대폰 번호", personal: true })]),
    /개인정보/,
  );
});

test("buttons on a payment screen still ask, whatever their text", () => {
  assert.ok(autoApproveBlock("click_element", [t({ name: "확인", paymentContext: true })]));
  assert.ok(autoApproveBlock("click_element", [t({ name: "Confirm", paymentContext: true })]));
});

test("navigation runs automatically only within the site or to another site's home", () => {
  const cur = "https://shopping.naver.com/ns/home";
  assert.equal(navigateAutoBlock(cur, "https://shopping.naver.com/ns/search?query=%EB%A7%A5%EB%B6%81"), null);
  assert.equal(navigateAutoBlock(cur, "https://news.naver.com/"), null);
  assert.equal(navigateAutoBlock(undefined, "https://www.coupang.com"), null);
  assert.ok(navigateAutoBlock(cur, "https://attacker.example/?d=010-1234-5678"));
  assert.ok(navigateAutoBlock(cur, "https://attacker.example/hong-gildong"));
  assert.ok(navigateAutoBlock(cur, "https://hong01012345678.attacker.example/"));
  assert.ok(navigateAutoBlock(cur, "https://user:pw@attacker.example/"));
  assert.ok(navigateAutoBlock(cur, "javascript:alert(1)"));
});

test("tools outside page actions are never automatic", () => {
  assert.ok(!AUTO_APPROVE_TOOLS.has("read_document"));
  assert.ok(autoApproveBlock("download_images", []));
  assert.ok(autoApproveBlock("read_document", []));
  assert.ok(autoApproveBlock("google_sheets_write_range", []));
});
