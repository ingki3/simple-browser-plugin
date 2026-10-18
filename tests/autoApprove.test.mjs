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

test("identifier hints are split on underscores and camel case", async () => {
  const { splitIdentifier } = await import("../src/lib/autoApprove.ts");
  assert.equal(splitIdentifier("otp_code"), "otp code");
  assert.equal(splitIdentifier("userPin"), "user Pin");
  const trusted = new Set([siteOf("https://shop.example/")]);
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/verify?otp_code=123456"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/#password=secret123"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/login?userPin=1234"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/cb?access_token=abc"));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["sk-demo-abcdefghijklmnop"]));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["a".repeat(20001) + " sk-or-v1-abcdefghijklmnop"]));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/collect/sk-or-v1-abcdefghijklmnop"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/login?verification_code=123456"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/#/login?otp_code=123456"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/%70ayment/confirm?x=%ZZ"));
  for (const p of ["/pay_now", "/confirm_order", "/placeOrder", "/donate", "/purchase", "/buy-now", "/충전"]) {
    assert.ok(navigateAutoBlock(trusted, "https://shop.example" + p), p);
  }
  assert.ok(autoApproveBlock("click_element", [t({ name: "Confirm", submitTo: "https://shop.example/donate" })]));
  assert.ok(autoApproveBlock("click_element", [t({ name: "다음", tag: "a", download: true })]));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/redirect?next=https%253A%252F%252Fcollector.example%252F%253Fd%253Dprivate-chat%25ZZ"));
});

test("joined payment button names still ask", () => {
  for (const name of ["PayNow", "BuyNow", "pay_now"]) assert.ok(autoApproveBlock("click_element", [t({ name })]), name);
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
  assert.ok(navigateAutoBlock(new Set([siteOf("https://script.google.com/home")]), "https://script.google.com/macros/s/X/exec?payload=1"));
  assert.ok(navigateAutoBlock(new Set([siteOf("https://docs.google.com/")]), "https://docs.google.com/forms/d/e/X/formResponse?entry.1=1"));
  assert.ok(navigateAutoBlock(new Set([siteOf("http://127.0.0.1:8080/")]), "http://127.0.0.1:9090/"));
  assert.ok(navigateAutoBlock(trusted, "https://honggildong.collector.example/"));
  assert.ok(navigateAutoBlock(trusted, "https://attacker.example/?d=010-1234-5678"));
  assert.ok(navigateAutoBlock(new Set(), "https://www.coupang.com/"));
  assert.ok(navigateAutoBlock(trusted, "javascript:alert(1)"));
  assert.equal(siteOf("javascript:alert(1)"), null);
});

test("navigation and links carrying personal data or payment routes still ask", async () => {
  const trusted = new Set([siteOf("https://shop.example/")]);
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/register?email=alice%40example.com"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/p?x=010-1234-5678"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/checkout/confirm"));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/#/order/place"));
  assert.equal(navigateAutoBlock(trusted, "https://shop.example/search?query=%EB%A7%A5%EB%B6%81&page=2"), null);
  // 기사·상품 번호 같은 숫자는 개인정보로 보지 않는다
  const news = new Set([siteOf("https://n.news.naver.com/")]);
  assert.equal(navigateAutoBlock(news, "https://n.news.naver.com/mnews/article/001/0016382338"), null);
  assert.equal(navigateAutoBlock(news, "https://n.news.naver.com/main/read.naver?oid=001&aid=0016382338"), null);
  assert.ok(navigateAutoBlock(news, "https://n.news.naver.com/u/alice@example.com"));
  assert.ok(autoApproveBlock("click_element", [t({ name: "확인", href: "https://shop.example/pay/confirm?id=3" })]));
  assert.equal(autoApproveBlock("click_element", [t({ name: "다음 글", href: "https://shop.example/board/3" })]), null);
  assert.ok(autoApproveBlock("click_element", [t({ name: "확인", submitTo: "https://shop.example/payment/confirm" })]));
  assert.ok(autoApproveBlock("click_element", [t({ name: "다음", pingUrls: ["https://shop.example/payment/confirm"] })]));
  assert.ok(autoApproveBlock("click_element", [t({ name: "다음", pingUrls: ["https://shop.example/a", "about:too-many-pings"] })]));
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "select", name: "수량", submitTo: "https://shop.example/order/place" })]));
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "select", name: "정렬", submitUrl: "https://shop.example/list?payload=alice%40example.com" })]));
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "select", name: "가기", choiceUrls: ["https://shop.example/checkout/confirm"] })]));
  const wrapped = `https://shop.example/redirect?next=${encodeURIComponent("https://shop.example/continue?email=alice%40example.com")}`;
  assert.ok(navigateAutoBlock(trusted, wrapped));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["alice@example.com"]));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["/checkout/confirm"]));
  assert.ok(navigateAutoBlock(trusted, "https://shop.example/search?q=alice%2540example.com"));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["alice%40example.com"]));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["결제는 4111111111111111 로"]));
  assert.equal(pageActionSiteBlock(trusted, "https://shop.example/", [], ["상품번호 1234567890123"]), null);
  // 감싼 주소를 반복 확장하는 주소도 오래 걸리지 않고, 끝까지 못 보면 묻는다
  const many = "https://shop.example/?" + Array.from({ length: 400 }, (_, i) => `p${i}=%23x${i}`).join("&");
  const started = Date.now();
  navigateAutoBlock(trusted, many);
  autoApproveBlock("click_element", [t({ name: "계속", href: many })]);
  assert.ok(Date.now() - started < 1000);
  // 긴 값에서도 개인정보 판정이 오래 걸리지 않는다
  const { looksPersonalValue } = await import("../src/lib/autoApprove.ts");
  const t1 = Date.now();
  assert.equal(looksPersonalValue("a".repeat(200000)), false);
  assert.equal(looksPersonalValue("a".repeat(100000) + " bob@example.com"), true);
  assert.equal(looksPersonalValue("@ ".repeat(100) + " ".repeat(400) + "alice@example.com"), true);
  const t2 = Date.now();
  assert.equal(looksPersonalValue("eyJ".repeat(50000)), false);
  assert.ok(Date.now() - t2 < 200);
  assert.equal(looksPersonalValue("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc"), true);
  assert.ok(Date.now() - t1 < 500);
  assert.ok(autoApproveBlock("click_element", [t({ name: "계속", href: "https://alice:secret@shop.example/private" })]));
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "input", fieldType: "checkbox", name: "구매 확정" })]));
  assert.ok(autoApproveBlock("fill_form_fields", [t({ tag: "input", fieldType: "checkbox", name: "동의", paymentContext: true })]));
  assert.ok(pageActionSiteBlock(trusted, "https://shop.example/", [], ["/continue?email=alice%40example.com"]));
});

test("clicks and fills run automatically only on pages and destinations within chosen sites", () => {
  const trusted = new Set([siteOf("https://news.naver.com/")]);
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/section/105", ["https://n.news.naver.com/a/1"]), null);
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://news.naver.com/search"]), null);
  assert.ok(pageActionSiteBlock(trusted, "https://collector.example/next", []));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://collector.example/next"]));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", ["https://collector.example/collect"]));
  assert.ok(pageActionSiteBlock(trusted, undefined, []));
  // 입력할 값: 상대 경로 리다이렉트에 실린 바깥 주소, 글 속 주소
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", [], ["/redirect?next=https://collector.example/?d=1"]));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", [], ["see https://collector.example/x"]));
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/", [], ["/main", "맥북 에어", "a@b", "date:desc", "10:30"]), null);
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", [], ["ht\ttps://collector.example/?d=secret"]));
  assert.ok(pageActionSiteBlock(trusted, "https://news.naver.com/", [], ["?next=//collector.example/"]));
  assert.ok(navigateAutoBlock(trusted, "https://news.naver.com/r?u=ht%09tps://collector.example/"));
  // 상대 링크는 페이지 주소 기준으로 푼다
  assert.equal(pageActionSiteBlock(trusted, "https://news.naver.com/", ["/section/105"]), null);
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

test("destinations wrapped in the path are checked against the trusted site", () => {
  const trusted = new Set([siteOf("https://trusted.example/")]);
  assert.ok(navigateAutoBlock(trusted, "https://trusted.example/out/https%3A%2F%2Fcollector.example%2Freceive%3Fd%3Dx"));
  assert.ok(navigateAutoBlock(trusted, "https://trusted.example/proxy/https://collector.example/receive"));
  assert.ok(navigateAutoBlock(trusted, "https://trusted.example/out/https%253A%252F%252Fcollector.example"));
  assert.equal(navigateAutoBlock(trusted, "https://trusted.example/out/https%3A%2F%2Fsub.trusted.example%2Fa"), null);
  assert.equal(navigateAutoBlock(trusted, "https://trusted.example/docs/http-guide"), null);
});

test("common English order confirmation buttons ask", () => {
  for (const name of ["Confirm order", "Complete order", "Place your order", "Submit Order"]) {
    assert.ok(autoApproveBlock("click_element", [t({ name })]), name);
  }
  assert.equal(autoApproveBlock("click_element", [t({ name: "Ordering tips" })]), null);
});

test("phone, resident and card numbers in the path ask", () => {
  const trusted = new Set([siteOf("https://trusted.example/")]);
  for (const p of ["/collect/010-1234-5678", "/collect/900101-1234567", "/collect/4111-1111-1111-1111", "/c/01012345678", "/c/4111111111111111"]) {
    assert.ok(navigateAutoBlock(trusted, "https://trusted.example" + p), p);
  }
  assert.equal(navigateAutoBlock(trusted, "https://trusted.example/article/20261019/123456"), null);
});
