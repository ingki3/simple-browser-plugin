import { test } from "node:test";
import assert from "node:assert/strict";
import { internalNavigateAutoBlock, isBrowserInternalUrl, userNamedSites } from "../src/lib/siteTrust.ts";

test("bare domains in Korean text become https origins", () => {
  assert.deepEqual(userNamedSites("naver.com으로 이동해서 날씨 알려줘"), ["https://naver.com"]);
  assert.deepEqual(userNamedSites("www.coupang.com 가서 주문 내역 봐줘."), ["https://www.coupang.com"]);
  assert.deepEqual(userNamedSites("shopping.naver.com/home 열어줘"), ["https://shopping.naver.com"]);
  assert.deepEqual(userNamedSites("GMARKET.CO.KR 들어가줘"), ["https://gmarket.co.kr"]);
  assert.deepEqual(userNamedSites("주소:example.org:8443 열어"), ["https://example.org:8443"]);
});

test("full URLs keep their origin, and http also allows https", () => {
  assert.deepEqual(userNamedSites("https://www.11st.co.kr/main 로 가줘"), ["https://www.11st.co.kr"]);
  assert.deepEqual(userNamedSites("http://example.com/a 열어줘"), ["http://example.com", "https://example.com"]);
  assert.deepEqual(userNamedSites("https://www.naver.com으로 가줘"), ["https://www.naver.com"]);
});

test("e-mail addresses, URL parameters and IPs are not sites", () => {
  assert.deepEqual(userNamedSites("내 메일 ingki3@gmail.com 로 알려줘"), []);
  assert.deepEqual(userNamedSites("https://a.example.com/r?u=evil.com 열어"), ["https://a.example.com"]);
  assert.deepEqual(userNamedSites("naver.com/search?q=evil.com 열어"), ["https://naver.com"]);
  assert.deepEqual(userNamedSites("192.168.0.1 열어줘"), []);
  assert.deepEqual(userNamedSites("버전 3.5 이야기"), []);
  // 공개 접미사 목록으로 확인되지 않는 접미사는 뽑지 않는다.
  assert.deepEqual(userNamedSites("report.pdfx 파일"), []);
});

test("names without a domain shape are not sites (no meaning inference)", () => {
  assert.deepEqual(userNamedSites("네이버로 이동해줘"), []);
  assert.deepEqual(userNamedSites("go to google"), []);
});

test("internal page navigation: inside named or approved sites only", () => {
  const named = userNamedSites("naver.com 가서 날씨");
  assert.equal(internalNavigateAutoBlock([], named, "https://www.naver.com/"), null);
  assert.equal(internalNavigateAutoBlock([], named, "https://weather.naver.com/today"), null);
  assert.ok(internalNavigateAutoBlock([], named, "https://www.daum.net/"));
  assert.ok(internalNavigateAutoBlock([], [], "https://www.naver.com/"));
  assert.equal(internalNavigateAutoBlock(["https://www.daum.net"], named, "https://news.daum.net/"), null);
  // 감싼 주소가 밖이면 묻는다.
  assert.ok(internalNavigateAutoBlock([], named, "https://www.naver.com/r?u=https://evil.example/"));
  // 같은 사이트여도 개인정보·결제 주소는 묻는다.
  assert.ok(internalNavigateAutoBlock([], named, "https://www.naver.com/cb?access_token=abc"));
  // 공유 호스팅은 같은 호스트를 적어도 자동 실행하지 않는다(기존 경계와 같음).
  assert.ok(internalNavigateAutoBlock([], userNamedSites("foo.github.io 열어"), "https://foo.github.io/"));
  assert.equal(internalNavigateAutoBlock([], named, "chrome://settings"), "웹 주소가 아님");
});

test("browser internal pages", () => {
  for (const u of ["chrome://newtab/", "about:blank", "edge://settings", "chrome-search://local-ntp/"]) {
    assert.equal(isBrowserInternalUrl(u), true, u);
  }
  for (const u of ["https://www.naver.com/", "", undefined, "file:///tmp/a.html"]) {
    assert.equal(isBrowserInternalUrl(u), false, String(u));
  }
});

test("hosts inside a path or query parameter are not named sites", () => {
  assert.deepEqual(userNamedSites("naver.com/redirect?next=https://attacker.com/ 열어줘"), ["https://naver.com"]);
  assert.deepEqual(userNamedSites("https://naver.com/r?u=https://attacker.com/x 열어"), ["https://naver.com"]);
  assert.deepEqual(userNamedSites("next=https://attacker.com 로 가"), []);
  assert.deepEqual(userNamedSites("“naver.com”으로 가줘"), ["https://naver.com"]);
  // 사용자가 적은 주소 속 매개변수의 사이트로는 자동 이동하지 않는다.
  const named = userNamedSites("naver.com/redirect?next=https://attacker.com/ 열어줘");
  assert.notEqual(internalNavigateAutoBlock([], named, "https://attacker.com/collect?d=x"), null);
});

test("only the leading non-ASCII prefix is stripped", () => {
  assert.deepEqual(userNamedSites("naver.com/검색https://attacker.com 열어"), ["https://naver.com"]);
});

test("hosts inside brackets in a path, or cut at a fullwidth dot, are not named sites", () => {
  assert.deepEqual(userNamedSites("https://naver.com/(attacker.com)/ 열어줘"), ["https://naver.com"]);
  // 전각 마침표는 URL 파서가 '.'로 정규화한다: attacker.com.example.org(등록 도메인 example.org)이지 attacker.com이 아니다.
  const named = userNamedSites("https://attacker.com。example.org/ 열어줘");
  assert.ok(!named.includes("https://attacker.com"));
  assert.notEqual(internalNavigateAutoBlock([], named, "https://attacker.com/collect"), null);
  assert.deepEqual(userNamedSites("(naver.com) 가줘"), ["https://naver.com"]);
  assert.deepEqual(userNamedSites("ref:attacker.com 참고"), []);
});

test("internationalized hosts are not cut, and long inputs stay fast", () => {
  assert.ok(!userNamedSites("https://attacker.com.한국").includes("https://attacker.com"));
  assert.notEqual(internalNavigateAutoBlock([], userNamedSites("https://attacker.com.한국"), "https://attacker.com/x"), null);
  assert.ok(!userNamedSites("attacker.com.한국 열어").includes("https://attacker.com"));
  assert.deepEqual(userNamedSites("naver.com으로 가줘"), ["https://naver.com"]);
  const t0 = Date.now();
  userNamedSites("https://example.com/" + "가".repeat(20000) + "1 " + "naver.com" + "가".repeat(20000) + ")".repeat(5000));
  assert.ok(Date.now() - t0 < 200, `slow: ${Date.now() - t0}ms`);
});

test("characters that normalize to ASCII are never removed from a host", () => {
  // 전각 m: 브라우저는 example.com으로 본다. example.co로 잘리면 안 된다.
  assert.deepEqual(userNamedSites("https://example.coｍ 열어줘"), ["https://example.com"]);
  assert.ok(!userNamedSites("https://example.coｍ").includes("https://example.co"));
  assert.notEqual(internalNavigateAutoBlock([], userNamedSites("https://example.coｍ"), "https://example.co/x"), null);
  assert.deepEqual(userNamedSites("ｅxample.com 가줘"), ["https://example.com"]);
  assert.deepEqual(userNamedSites("주소:example.org:8443 열어"), ["https://example.org:8443"]);
});
