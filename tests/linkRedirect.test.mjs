import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINK_REDIRECTS,
  RedirectMemory,
  blockedWithoutCookies,
  nextRedirectStep,
  requestUrl,
  sameSiteRedirect,
  structuralReject,
} from "../src/lib/linkRedirect.ts";

const O = "https://news.example.com/a/1";

test("same-site redirects (same registrable domain) are followed", () => {
  assert.deepEqual(nextRedirectStep(O, "https://news.example.com/a/1/", [O]), { kind: "follow", url: "https://news.example.com/a/1/" });
  assert.deepEqual(nextRedirectStep(O, "https://www.example.com/article?id=1#top", [O]), {
    kind: "follow",
    url: "https://www.example.com/article?id=1",
  });
  // co.kr 아래는 등록 도메인으로 비교한다.
  assert.equal(nextRedirectStep("https://n.news.co.kr/x", "https://m.news.co.kr/x", ["https://n.news.co.kr/x"]).kind, "follow");
});

test("http to https upgrade is same site, downgrade is not", () => {
  assert.equal(sameSiteRedirect("http://example.com/a", "https://example.com/a"), true);
  assert.equal(sameSiteRedirect("http://example.com/a", "https://www.example.com/a"), true);
  assert.equal(sameSiteRedirect("https://example.com/a", "http://example.com/a"), false);
  assert.equal(sameSiteRedirect("http://example.com:8080/a", "https://example.com/a"), false);
});

test("cross-site redirects stop with the destination", () => {
  const s = nextRedirectStep(O, "https://other.com/story", [O]);
  assert.deepEqual(s, { kind: "stop", reason: "cross_site", url: "https://other.com/story" });
  // 다른 등록 도메인(co.kr 아래 남의 사이트), 다른 포트, 공유 호스팅의 다른 사용자.
  assert.equal(nextRedirectStep("https://a.co.kr/", "https://b.co.kr/", ["https://a.co.kr/"]).reason, "cross_site");
  assert.equal(nextRedirectStep("http://127.0.0.1:1/", "http://127.0.0.1:2/", ["http://127.0.0.1:1/"]).reason, "cross_site");
  assert.equal(nextRedirectStep("https://a.github.io/", "https://b.github.io/", ["https://a.github.io/"]).reason, "cross_site");
  // 같은 사이트 주소라도 감싼 주소가 밖을 가리키면 다른 사이트로 본다.
  assert.equal(nextRedirectStep(O, "https://news.example.com/out?url=https%3A%2F%2Fevil.com%2F", [O]).reason, "cross_site");
});

test("structural and sensitive destinations are not followed", () => {
  assert.equal(nextRedirectStep(O, "javascript:alert(1)", [O]).reason, "structural");
  assert.equal(nextRedirectStep(O, "https://u:p@news.example.com/", [O]).reason, "structural");
  assert.equal(nextRedirectStep(O, "not a url", [O]).reason, "invalid");
  const pay = nextRedirectStep(O, "https://news.example.com/checkout/pay", [O]);
  assert.equal(pay.kind, "stop");
  assert.equal(pay.reason, "sensitive");
  assert.ok(pay.detail);
  assert.equal(nextRedirectStep(O, "https://news.example.com/sub?email=a%40b.com", [O]).reason, "sensitive");
  // 다른 사이트이면서 민감하면 민감 쪽(기억하지 않는 쪽)으로 멈춘다.
  assert.equal(nextRedirectStep(O, "https://pay.other.com/checkout", [O]).reason, "sensitive");
});

test("loops and hop limit", () => {
  const b = "https://news.example.com/b";
  assert.equal(nextRedirectStep(O, O, [O]).reason, "loop");
  assert.equal(nextRedirectStep(O, O + "#x", [O, b]).reason, "loop");
  const visited = [O];
  for (let i = 0; i < MAX_LINK_REDIRECTS; i++) {
    const s = nextRedirectStep(O, `https://news.example.com/h${i}`, visited);
    assert.equal(s.kind, "follow");
    visited.push(s.url);
  }
  assert.equal(nextRedirectStep(O, "https://news.example.com/last", visited).reason, "too_many");
  // 루프는 한도보다 먼저 알린다.
  assert.equal(nextRedirectStep(O, visited[1], visited).reason, "loop");
});

test("redirect memory: lookup by request url, cap, structural reject", () => {
  const m = new RedirectMemory(2);
  m.remember("https://other.com/a#frag", "https://news.example.com/x");
  assert.equal(m.pageLinkFor("https://other.com/a"), "https://news.example.com/x");
  assert.equal(m.pageLinkFor("https://other.com/a#y"), "https://news.example.com/x");
  assert.equal(m.pageLinkFor("https://other.com/b"), null);
  assert.equal(m.pageLinkFor("garbage"), null);
  m.remember("javascript:alert(1)", "https://news.example.com/x");
  assert.equal(m.size, 1);
  m.remember("https://other.com/b", "p1");
  m.remember("https://other.com/c", "p2");
  assert.equal(m.size, 2);
  assert.equal(m.pageLinkFor("https://other.com/a"), null);
  assert.equal(m.pageLinkFor("https://other.com/c"), "p2");
});

test("helpers", () => {
  assert.equal(requestUrl("https://a.com/x?y=1#z"), "https://a.com/x?y=1");
  assert.equal(requestUrl("::"), null);
  assert.equal(structuralReject("ftp://a.com/"), "웹 주소가 아님");
  assert.equal(structuralReject("https://a.com/"), null);
  assert.equal(blockedWithoutCookies(403), true);
  assert.equal(blockedWithoutCookies(401), true);
  assert.equal(blockedWithoutCookies(429), true);
  assert.equal(blockedWithoutCookies(404), false);
  assert.equal(blockedWithoutCookies(500), false);
});

test("nextRedirectStep: https에서 http로 내려가는 리다이렉트는 따라가지 않는다", () => {
  const visited = ["http://example.com/start", "https://example.com/secure"];
  const step = nextRedirectStep("http://example.com/start", "http://example.com/plain", visited);
  assert.equal(step.kind, "stop");
  assert.equal(step.reason, "downgrade");
  // http → https 승격은 그대로 따라간다.
  assert.equal(nextRedirectStep("http://example.com/start", "https://example.com/secure", ["http://example.com/start"]).kind, "follow");
});
