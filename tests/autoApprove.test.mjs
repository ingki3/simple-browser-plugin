import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_APPROVE_TOOLS, autoApproveBlock, navigateAutoBlock, pageActionSiteBlock, siteOf } from "../src/lib/autoApprove.ts";

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

test("sites group subdomains of one registrable domain, but not shared hosting", () => {
  assert.equal(siteOf("https://n.news.naver.com/mnews/article/1"), "https://naver.com");
  assert.equal(siteOf("https://shopping.naver.com/"), "https://naver.com");
  assert.equal(siteOf("https://www.gmarket.co.kr/x"), "https://gmarket.co.kr");
  assert.equal(siteOf("https://alice.github.io/"), "https://alice.github.io");
  assert.equal(siteOf("https://blog.tistory.com/"), "https://blog.tistory.com");
  assert.equal(siteOf("http://127.0.0.1:8080/a"), "http://127.0.0.1:8080");
  assert.equal(siteOf("javascript:alert(1)"), null);
});

test("navigation runs automatically only within sites the user chose", () => {
  const trusted = new Set(["https://naver.com"]);
  assert.equal(navigateAutoBlock(trusted, "https://shopping.naver.com/ns/search?query=%EB%A7%A5%EB%B6%81"), null);
  assert.equal(navigateAutoBlock(trusted, "https://news.naver.com/"), null);
  assert.ok(navigateAutoBlock(trusted, "https://honggildong.collector.example/"));
  assert.ok(navigateAutoBlock(trusted, "https://attacker.example/?d=010-1234-5678"));
  assert.ok(navigateAutoBlock(new Set(), "https://www.coupang.com/"));
  assert.ok(navigateAutoBlock(trusted, "javascript:alert(1)"));
});

test("clicks and fills run automatically only on pages and links within chosen sites", () => {
  const trusted = new Set(["https://naver.com"]);
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/section/105", ["https://n.news.naver.com/a/1"]), null);
  assert.equal(pageActionSiteBlock(trusted, "https://shopping.naver.com/", []), null);
  assert.ok(pageActionSiteBlock(trusted, "https://collector.example/next", []));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://collector.example/next"]));
  assert.ok(pageActionSiteBlock(trusted, undefined, []));
});

test("tools outside page actions are never automatic", () => {
  assert.ok(!AUTO_APPROVE_TOOLS.has("read_document"));
  assert.ok(autoApproveBlock("download_images", []));
  assert.ok(autoApproveBlock("read_document", []));
  assert.ok(autoApproveBlock("google_sheets_write_range", []));
});
