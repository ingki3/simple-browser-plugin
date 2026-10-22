import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_GRANT_TOOLS,
  chatGrantDecision,
  downloadScope,
  GRANT_IMAGE_LIMITS,
  grantImageCountBlock,
  grantImageResponseBlock,
  imageSaveGrantBlock,
  isChatGrantTool,
  linkReadGrantBlock,
} from "../src/lib/chatGrant.ts";
import { TOOL_POLICY } from "../src/lib/toolPolicy.ts";

const call = (tool, extra = {}) => ({ tool, protected: false, block: null, scope: "", ...extra });
const none = new Map();

test("only the three low-risk tools are grantable", () => {
  assert.deepEqual([...CHAT_GRANT_TOOLS].sort(), ["download_images", "read_linked_pages", "translate_page"]);
  for (const tool of Object.keys(TOOL_POLICY)) {
    if (CHAT_GRANT_TOOLS.includes(tool)) continue;
    assert.equal(isChatGrantTool(tool), false, tool);
    // 대상 밖 도구는 허락이 있어도(가짜 맵) 덮지 않고 제안도 없다.
    const d = chatGrantDecision(new Map([[tool, ""]]), call(tool));
    assert.deepEqual(d, { covered: false, offer: false, reason: null }, tool);
  }
  assert.equal(isChatGrantTool("toString"), false);
  assert.equal(isChatGrantTool("__proto__"), false);
});

test("offer before grant, cover after grant", () => {
  for (const tool of CHAT_GRANT_TOOLS) {
    assert.deepEqual(chatGrantDecision(none, call(tool)), { covered: false, offer: true, reason: null }, tool);
    assert.deepEqual(chatGrantDecision(new Map([[tool, ""]]), call(tool)), { covered: true, offer: false, reason: null }, tool);
  }
});

test("a call with a structural warning is neither covered nor offered", () => {
  const blocked = call("read_linked_pages", { block: "다른 사이트 링크가 섞임" });
  assert.deepEqual(chatGrantDecision(none, blocked), { covered: false, offer: false, reason: null });
  assert.deepEqual(chatGrantDecision(new Map([["read_linked_pages", ""]]), blocked), {
    covered: false,
    offer: false,
    reason: "다른 사이트 링크가 섞임",
  });
});

test("external-content protection suspends grants for tools that send model data out", () => {
  for (const tool of ["translate_page", "download_images"]) {
    const d = chatGrantDecision(new Map([[tool, ""]]), call(tool, { protected: true }));
    assert.deepEqual(d, { covered: false, offer: false, reason: "외부 문서 내용을 읽은 대화" }, tool);
    assert.equal(chatGrantDecision(none, call(tool, { protected: true })).offer, false, tool);
  }
  // 링크 읽기는 페이지가 준 주소만 쿠키 없이 받으므로(모델 유래 값을 보내지 않음) 보호 중에도 허락을 쓴다.
  // 경고 링크가 섞이면 위의 block으로 묻는다.
  assert.equal(chatGrantDecision(new Map([["read_linked_pages", ""]]), call("read_linked_pages", { protected: true })).covered, true);
});

test("download grant applies only to the same folder", () => {
  const grants = new Map([["download_images", "shop"]]);
  assert.equal(chatGrantDecision(grants, call("download_images", { scope: "shop" })).covered, true);
  const other = chatGrantDecision(grants, call("download_images", { scope: "other" }));
  assert.equal(other.covered, false);
  assert.equal(other.offer, true);
  assert.match(other.reason, /shop/);
  assert.equal(downloadScope("shop"), downloadScope("shop"));
  assert.equal(downloadScope(""), "downloads");
  // 실제 저장 폴더 이름(startImageDownloads의 정리)으로 비교한다.
  assert.equal(downloadScope("a/b"), "a_b");
  assert.notEqual(downloadScope("shop"), downloadScope("shop2"));
});

test("linked-page read grant: any warned link means a card", () => {
  const ok = { url: "https://news.example.com/a/1", otherSite: false, redirected: false };
  assert.equal(linkReadGrantBlock([ok, { ...ok, url: "https://news.example.com/a/2" }], 0), null);
  assert.match(linkReadGrantBlock([ok, { ...ok, url: "https://news.example.com/checkout/pay" }], 0), /결제/);
  assert.match(linkReadGrantBlock([ok, { ...ok, url: "https://news.example.com/a?email=a%40b.com" }], 0), /개인정보/);
  assert.match(linkReadGrantBlock([ok, { ...ok, url: "https://other.example.org/x", otherSite: true }], 0), /다른 사이트/);
  assert.match(linkReadGrantBlock([ok, { ...ok, url: "https://other.example.org/x", redirected: true }], 0), /리다이렉트/);
  assert.match(linkReadGrantBlock([ok], 1), /페이지에 없는/);
});

test("image save grant: only images present on the page, no sensitive URLs", () => {
  const page = new Set(["https://img.example.com/a.png", "https://img.example.com/b.png?u=alice%40example.com"]);
  assert.equal(imageSaveGrantBlock(["https://img.example.com/a.png"], page), null);
  assert.match(imageSaveGrantBlock(["https://evil.example/x.png?q=secret"], page), /페이지에 없는/);
  assert.match(imageSaveGrantBlock(["https://img.example.com/b.png?u=alice%40example.com"], page), /개인정보/);
  assert.match(imageSaveGrantBlock([], page), /없음/);
});

test("granted image fetch: no redirects, image content type only, size and count caps", () => {
  const ok = { status: 200, redirected: false, contentType: "image/png", bytes: 1000 };
  assert.equal(grantImageResponseBlock(ok), null);
  assert.equal(grantImageResponseBlock({ ...ok, bytes: null }), null);
  assert.equal(grantImageResponseBlock({ ...ok, contentType: "IMAGE/JPEG; charset=binary" }), null);
  // redirect: "manual"의 opaqueredirect(status 0)와 따라간 응답 모두 리다이렉트로 본다.
  assert.match(grantImageResponseBlock({ ...ok, status: 0, redirected: true }), /리다이렉트/);
  assert.match(grantImageResponseBlock({ ...ok, status: 302 }), /리다이렉트/);
  assert.match(grantImageResponseBlock({ ...ok, status: 401 }), /401/);
  assert.match(grantImageResponseBlock({ ...ok, contentType: "text/html" }), /이미지가 아닌/);
  assert.match(grantImageResponseBlock({ ...ok, contentType: "" }), /이미지가 아닌/);
  assert.match(grantImageResponseBlock({ ...ok, bytes: GRANT_IMAGE_LIMITS.maxBytes + 1 }), /너무 큰/);
  assert.equal(grantImageCountBlock(GRANT_IMAGE_LIMITS.maxCount), null);
  assert.match(grantImageCountBlock(GRANT_IMAGE_LIMITS.maxCount + 1), /많음/);
});
