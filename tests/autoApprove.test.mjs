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

test("the text of the enclosing control counts too", () => {
  assert.ok(autoApproveBlock("click_element", [t({ name: "확인", outerText: "구매 확인" })]));
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
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "input", fieldType: "text", sensitive: "password", name: "인증번호" })]));
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

test("trusted sites extend only to the same host and its subdomains", () => {
  const trusted = new Set([siteOf("https://news.naver.com/section/105")]);
  assert.equal(navigateAutoBlock(trusted, "https://news.naver.com/main"), null);
  assert.equal(navigateAutoBlock(trusted, "https://n.news.naver.com/mnews/article/1"), null);
  assert.ok(navigateAutoBlock(trusted, "https://shopping.naver.com/"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://bank.co.za/")]), "https://collector.co.za/?d=1"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://alice.s3.amazonaws.com/")]), "https://mallory.s3.amazonaws.com/"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://tistory.com/")]), "https://evil.tistory.com/"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://s3.amazonaws.com/company/index.html")]), "https://attacker.s3.amazonaws.com/?d=1"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://s3.amazonaws.com/company/index.html")]), "https://s3.amazonaws.com/attacker/?d=1"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://alice.github.io/")]), "https://alice.github.io/x"));
  assert.ok(navigateAutoBlock(new Set([siteOf("http://127.0.0.1:8080/")]), "http://127.0.0.1:9090/"));
  assert.ok(navigateAutoBlock(trusted, "https://honggildong.collector.example/"));
  assert.ok(navigateAutoBlock(trusted, "https://attacker.example/?d=010-1234-5678"));
  assert.ok(navigateAutoBlock(new Set(), "https://www.coupang.com/"));
  assert.ok(navigateAutoBlock(trusted, "javascript:alert(1)"));
  assert.equal(siteOf("javascript:alert(1)"), null);
});

test("clicks and fills run automatically only on pages and destinations within chosen sites", () => {
  const trusted = new Set([siteOf("https://news.naver.com/")]);
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/section/105", ["https://n.news.naver.com/a/1"]), null);
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://news.naver.com/search"]), null);
  assert.ok(pageActionSiteBlock(trusted, "https://collector.example/next", []));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://collector.example/next"]));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://collector.example/collect"]));
  assert.ok(pageActionSiteBlock(trusted, undefined, []));
  // 신뢰 사이트의 리다이렉트 매개변수에 실린 바깥 주소
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://news.naver.com/redirect?url=https%3A%2F%2Fcollector.example%2F%3Fd%3D1"]));
  assert.ok(navigateAutoBlock(trusted, "https://news.naver.com/out?next=//collector.example/x"));
  assert.ok(navigateAutoBlock(trusted, "https://news.naver.com/redirect?next=%2F%5Ccollector.example%2Fcollect%3Fd%3Dsecret"));
  assert.ok(navigateAutoBlock(trusted, "https://news.naver.com/r?u=https:%5C%5Ccollector.example"));
  assert.equal(navigateAutoBlock(trusted, "https://news.naver.com/r?next=%2Fmain%2Fhome"), null);
  let wrapped = "https://collector.example/?d=secret";
  for (let i = 0; i < 5; i++) wrapped = `https://news.naver.com/redirect?url=${encodeURIComponent(wrapped)}`;
  assert.ok(navigateAutoBlock(trusted, wrapped));
  assert.equal(navigateAutoBlock(trusted, "https://news.naver.com/search?query=hello"), null);
  assert.ok(navigateAutoBlock(trusted, "https://news.naver.com/#/go?to=https://collector.example/"));
  assert.equal(navigateAutoBlock(trusted, "https://news.naver.com/r?url=https%3A%2F%2Fn.news.naver.com%2Fa"), null);
  // 목적지를 확인할 수 없는 링크는 묻고, 아무 데도 가지 않는 자리표시 링크는 일반 버튼처럼 본다.
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["javascript:location.href='https://collector.example/'"]));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["data:text/html,hi"]));
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/", ["javascript:void(0)"]), null);
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/", ["javascript:;"]), null);
});

test("fields in a form with filled personal values still ask", () => {
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "select", name: "정렬", submitsPersonal: true })]));
});

test("tools outside page actions are never automatic", () => {
  assert.ok(!AUTO_APPROVE_TOOLS.has("read_document"));
  assert.ok(autoApproveBlock("download_images", []));
  assert.ok(autoApproveBlock("read_document", []));
  assert.ok(autoApproveBlock("google_sheets_write_range", []));
});
