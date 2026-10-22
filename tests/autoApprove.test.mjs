import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_APPROVE_TOOLS, autoApproveBlock } from "../src/lib/autoApprove.ts";
import { navigateAutoBlock, pageActionSiteBlock, siteOf } from "../src/lib/siteTrust.ts";

const t = (over = {}) => ({
  tag: "button", role: "button", name: "", href: "", region: "main", inFrame: false,
  fieldType: "", sensitive: null, context: "", ...over,
});

test("navigation, plain clicks and plain fills run automatically", () => {
  assert.equal(autoApproveBlock("navigate_to_url", []), null);
  assert.equal(autoApproveBlock("click_element", [t({ name: "검색" })]), null);
  // 중첩 메뉴(트리거 자신이 다른 목록 안)의 항목은 자동 실행하지 않는다.
  assert.equal(autoApproveBlock("click_element", [t({ name: "보기", nestedPopup: true })]), "중첩 메뉴의 항목");
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

test("trusted sites extend to the same registrable domain (same site), not across public suffixes", () => {
  const trusted = new Set([siteOf("https://news.naver.com/section/105")]);
  assert.equal(navigateAutoBlock(trusted, "https://news.naver.com/main"), null);
  assert.equal(navigateAutoBlock(trusted, "https://n.news.naver.com/mnews/article/1"), null);
  // 같은 등록 도메인(naver.com)의 다른 하위 서비스는 안.
  assert.equal(navigateAutoBlock(trusted, "https://shopping.naver.com/"), null);
  assert.equal(navigateAutoBlock(new Set([siteOf("https://www.naver.com/")]), "https://mail.naver.com/"), null);
  assert.ok(navigateAutoBlock(trusted, "https://naver.com.evil.example/"));
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

test("only lowercase void 0 javascript links are inert", async () => {
  const trusted = new Set([siteOf("https://shop.example/")]);
  const page = "https://shop.example/a";
  assert.equal(pageActionSiteBlock(trusted, page, ["javascript:void(0)"], []), null);
  assert.equal(pageActionSiteBlock(trusted, page, ["JavaScript:void 0;"], []), null);
  assert.ok(pageActionSiteBlock(trusted, page, ["javascript:VOID(0)"], []));
  assert.ok(pageActionSiteBlock(trusted, page, ["javascript:void0"], []));
});

test("English money transfer wording asks", () => {
  for (const name of ["Confirm transfer", "Send money", "Wire funds"]) {
    assert.ok(autoApproveBlock("click_element", [t({ name })]), name);
  }
  const trusted = new Set([siteOf("https://bank.example/")]);
  assert.ok(navigateAutoBlock(trusted, "https://bank.example/transfer/confirm"));
});

test("values split by line breaks are still personal", async () => {
  const { looksPersonalValue } = await import("../src/lib/autoApprove.ts");
  assert.ok(looksPersonalValue("alice@\nexample.com"));
  assert.ok(looksPersonalValue("010-1234-\r\n5678"));
  assert.ok(!looksPersonalValue("hello\nworld"));
});

test("grantableLink: 구조만 보고 같은 문서 밖으로 가는 일반 링크만 허락 대상", async () => {
  const { grantableLink } = await import("../src/lib/autoApprove.ts");
  const page = "https://shop.example/p/1";
  const link = (over = {}) => t({ tag: "a", role: "link", name: "주문/배송 조회", href: "https://shop.example/my/order", ...over });
  // 글자·경로에 결제 단서가 있어도 구조가 일반 링크면 대상이다(사이트 경계는 따로 본다).
  assert.equal(grantableLink(link(), page), true);
  assert.equal(grantableLink(link({ name: "결제하기", href: "https://shop.example/checkout" }), page), true);
  // 버튼, 양식 제출, 내려받기, 개인정보 양식, 바뀐 양식이 있는 범위, 감싼 링크는 아니다.
  assert.equal(grantableLink(t({ name: "주문 조회" }), page), false);
  assert.equal(grantableLink(link({ submitTo: "https://shop.example/order" }), page), false);
  assert.equal(grantableLink(link({ download: true }), page), false);
  assert.equal(grantableLink(link({ submitsPersonal: true }), page), false);
  assert.equal(grantableLink(link({ scopeSubmitUrls: ["https://shop.example/s?q=1"] }), page), false);
  assert.equal(grantableLink(link({ ancestorHref: "https://shop.example/x" }), page), false);
  // 웹 주소가 아니거나 같은 문서 안 위치만 바꾸는 링크는 아니다.
  assert.equal(grantableLink(link({ href: "javascript:void(0)" }), page), false);
  assert.equal(grantableLink(link({ href: "https://shop.example/p/1#reviews" }), page), false);
  assert.equal(grantableLink(link({ href: "https://shop.example/p/1" }), page), false);
  // 주소에 개인정보·비밀 값이 실리면 아니다. ping이 있는 링크는 이동과 별도로 POST를 보내므로 아니다.
  assert.equal(grantableLink(link({ href: "https://shop.example/my?email=a%40b.com" }), page), false);
  assert.equal(grantableLink(link({ href: "https://user:pw@shop.example/my" }), page), false);
  assert.equal(grantableLink(link({ pingUrls: ["https://shop.example/ping/sk-or-v1-abcdefghijklmnop"] }), page), false);
  assert.equal(grantableLink(link({ pingUrls: ["https://shop.example/ping"] }), page), false);
  assert.equal(grantableLink(link({ pingUrls: ["https://shop.example/order/123/confirm"] }), page), false);
  // 주변 양식의 제출 주소에 개인정보가 실리면 아니다(결제 낱말만 있는 주소는 구조 판정에 영향 없음).
  assert.equal(grantableLink(link({ scopeFormActions: ["https://shop.example/send?email=alice%40example.com"] }), page), false);
  assert.equal(grantableLink(link({ aroundFormActions: ["https://shop.example/c/alice@example.com"] }), page), false);
  assert.equal(grantableLink(link({ scopeFormActions: ["https://shop.example/search"] }), page), true);
  // 버튼 역할의 앵커, iframe 안 링크는 아니다.
  assert.equal(grantableLink(link({ role: "button" }), page), false);
  assert.equal(grantableLink(link({ role: "menuitem" }), page), false);
  assert.equal(grantableLink(link({ inFrame: true }), page), false);
  assert.equal(grantableLink(link({ insideControl: true }), page), false);
});

test("site boundary edge cases: public suffixes, shared hosting origins, unknown suffixes, IPs, ports, schemes", () => {
  const nav = (from, to) => navigateAutoBlock(new Set([siteOf(from)]), to);
  // 공개 접미사 아래 서로 다른 등록 도메인은 밖.
  assert.ok(nav("https://example.co.kr/", "https://other.co.kr/"));
  assert.equal(nav("https://www.example.co.kr/", "https://shop.example.co.kr/"), null);
  // 접미사 자체를 원본으로 하위 도메인을 신뢰하지 않는다.
  assert.ok(nav("https://co.kr/", "https://unrelated.co.kr/"));
  // PSL private 영역: 사용자별 하위 도메인은 서로 다름(github.io는 공유 호스팅이라 늘 밖).
  assert.ok(nav("https://a.github.io/", "https://b.github.io/"));
  // 공유 호스팅 원본은 등록 도메인 확장의 근거가 아니다(양방향).
  assert.ok(nav("https://script.google.com/macros/s/x/exec", "https://www.google.com/search?q=internal-project-alpha"));
  assert.ok(nav("https://www.google.com/", "https://script.google.com/macros/s/x/exec"));
  // 확인되지 않은 접미사는 예전 규칙: 하위 도메인만 안.
  assert.equal(nav("https://foo.unknownsuffix/", "https://child.foo.unknownsuffix/"), null);
  assert.ok(nav("https://foo.unknownsuffix/", "https://bar.unknownsuffix/"));
  // IP·localhost는 같은 호스트만, 포트·스킴이 다르면 밖.
  assert.ok(nav("http://127.0.0.1:3000/", "http://127.0.0.2:3000/"));
  assert.ok(nav("http://localhost:3000/", "http://localhost:4000/"));
  assert.equal(nav("http://localhost:3000/", "http://localhost:3000/x"), null);
  assert.ok(nav("http://[::1]:3000/", "http://[::2]:3000/"));
  assert.ok(nav("http://news.naver.com/", "https://shopping.naver.com/"));
  // 끝의 점으로 공유 호스팅 검사를 피하지 못한다(양방향, 같은 사이트 판정도 정규화).
  assert.ok(nav("https://www.google.com/", "https://script.google.com./macros/s/attacker/exec?d=1"));
  assert.ok(nav("https://www.google.com./", "https://script.google.com/macros/s/attacker/exec?d=1"));
  assert.ok(nav("https://script.google.com./x", "https://www.google.com/search?q=1"));
  assert.ok(nav("https://www.google.com/", "https://SCRIPT.GOOGLE.COM../macros/s/a/exec"));
  assert.equal(nav("https://www.naver.com./", "https://mail.naver.com/"), null);
  // IDN(xn--)도 등록 도메인으로 비교.
  assert.equal(nav("https://www.xn--9t4b11yi5a.com/", "https://shop.xn--9t4b11yi5a.com/"), null);
  // 감싼 주소(리다이렉트 매개변수)는 여전히 경계 검사를 받는다.
  assert.ok(nav("https://www.naver.com/", "https://shopping.naver.com/r?url=https%3A%2F%2Fcollector.example%2F"));
  assert.equal(nav("https://www.naver.com/", "https://shopping.naver.com/r?url=https%3A%2F%2Fmail.naver.com%2F"), null);
});

test("숨긴 체크박스를 보이는 label로 바꾸는 칸은 늘 묻는다(#56)", () => {
  const box = t({ tag: "input", role: "checkbox", fieldType: "checkbox", name: "선택" });
  assert.equal(autoApproveBlock("fill_form_fields", [box]), null);
  assert.match(autoApproveBlock("fill_form_fields", [box, { ...box, proxy: true }]), /보이지 않는 칸\(보이는 라벨로 표시\)/);
  // 결제 문구·위험 신호가 없어도(보이는 label의 이름을 다 모으지 못한 경우) 묻는다.
  assert.notEqual(autoApproveBlock("fill_form_fields", [{ ...box, proxy: true, outerText: "" }]), null);
});

test("삭제·휴지통·스팸 버튼은 자동 실행해도 묻는다(#62)", async () => {
  const { destructiveClickBlock, DESTRUCTIVE_REASON } = await import("../src/lib/autoApprove.ts");
  for (const name of [
    "삭제", "선택 삭제", "영구 삭제", "지우기", "휴지통으로 이동", "스팸 신고", "스팸으로 이동", "차단", "휴지통 비우기", "제거",
    "Delete", "Delete forever", "Remove", "Move to trash", "Report spam", "Discard draft", "Block sender", "Move to bin",
    "deleteBtn", "btn-trash",
  ]) {
    assert.equal(autoApproveBlock("click_element", [t({ name })]), DESTRUCTIVE_REASON, name);
    assert.equal(destructiveClickBlock([t({ name })]), DESTRUCTIVE_REASON, name);
  }
  // 아이콘 버튼: 화면 글자 없이 aria-label·title만 있는 경우(clickables가 outerText에 담는다).
  assert.equal(autoApproveBlock("click_element", [t({ name: "Delete", outerText: "Delete" })]), DESTRUCTIVE_REASON);
  assert.equal(autoApproveBlock("click_element", [t({ name: "🗑", outerText: "휴지통" })]), DESTRUCTIVE_REASON);
  assert.equal(autoApproveBlock("click_element", [t({ name: "", outerText: "Report spam" })]), DESTRUCTIVE_REASON);
  // 감싼 버튼의 글자(<button>삭제 <span>확인</span></button>의 span).
  assert.equal(autoApproveBlock("click_element", [t({ name: "확인", outerText: "삭제 확인" })]), DESTRUCTIVE_REASON);
});

test("삭제를 구조로 선언한 대상과 삭제 경로로 가는 링크·양식은 묻는다(#62)", async () => {
  const { DESTRUCTIVE_REASON } = await import("../src/lib/autoApprove.ts");
  // data-method="delete"·hx-delete·_method=DELETE는 글자가 평범해도 묻는다.
  assert.equal(autoApproveBlock("click_element", [t({ name: "확인", deleteMethod: true })]), DESTRUCTIVE_REASON);
  for (const href of ["https://shop.example/cart/remove/3", "https://bbs.example/bbs/delete.php?wr_id=3"]) {
    assert.equal(autoApproveBlock("click_element", [t({ tag: "a", role: "link", name: "x", href })]), DESTRUCTIVE_REASON, href);
  }
  for (const submitTo of ["https://mail.example/messages/batchDelete", "https://mail.example/act?op=trash"]) {
    assert.equal(autoApproveBlock("click_element", [t({ name: "확인", submitTo })]), DESTRUCTIVE_REASON, submitTo);
  }
});

test("선택지는 트리거가 삭제 버튼이어도 묻는다(#62)", async () => {
  const { DESTRUCTIVE_REASON } = await import("../src/lib/autoApprove.ts");
  assert.equal(autoApproveBlock("click_element", [t({ role: "menuitem", name: "확인" }), t({ name: "삭제 옵션" })]), DESTRUCTIVE_REASON);
  assert.equal(
    autoApproveBlock("click_element", [t({ role: "menuitem", name: "스팸으로 이동" }), t({ name: "더보기" })]),
    DESTRUCTIVE_REASON,
  );
});

test("행 문맥의 '삭제' 글자로는 일반 버튼·체크를 묻지 않는다(#62)", async () => {
  const { destructiveClickBlock } = await import("../src/lib/autoApprove.ts");
  const row = "[공지] 계정 삭제 요청 안내 — 스팸 차단 설정";
  for (const target of [
    t({ name: "열기", context: row, modelContext: row }),
    t({ role: "checkbox", name: "선택", outerText: "선택", context: row, modelContext: row, states: { checked: "false" } }),
    t({ tag: "a", role: "link", name: "자세히", href: "https://mail.example/mail/read?id=123", context: row, modelContext: row }),
  ]) {
    assert.equal(destructiveClickBlock([target]), null, target.name);
    assert.equal(autoApproveBlock("click_element", [target]), null, target.name);
  }
  // 칸 값까지 합친 제출 주소(검색어 '스팸')는 보지 않는다.
  assert.equal(
    autoApproveBlock("click_element", [
      t({ name: "검색", submitTo: "https://mail.example/search", submitUrl: "https://mail.example/search?q=%EC%8A%A4%ED%8C%B8" }),
    ]),
    null,
  );
  // 되돌리기 쉬운 동작은 걸리지 않는다.
  for (const name of ["Undelete", "복원", "Restore", "보관", "Archive", "검색", "다음 페이지"]) {
    assert.equal(destructiveClickBlock([t({ name })]), null, name);
  }
});

test("#62: 신뢰 사이트 안이어도 삭제·스팸 경로로의 이동은 묻는다", () => {
  const trusted = new Set([siteOf("https://mail.example/")]);
  assert.equal(navigateAutoBlock(trusted, "https://mail.example/messages/delete/3"), "되돌리기 어려운 동작(삭제·스팸)");
  assert.equal(navigateAutoBlock(trusted, "https://mail.example/inbox?action=trash&id=3"), "되돌리기 어려운 동작(삭제·스팸)");
  assert.equal(navigateAutoBlock(trusted, "https://mail.example/inbox/3"), null);
});
