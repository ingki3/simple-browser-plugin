// chrome.identity 접근(src/background/auth/identity.ts, #319 공용 인증 층). chrome은 대역이다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const { identityApi, expectedRedirectUri } = await import("../src/background/auth/identity.ts");

test.after(() => {
  delete globalThis.chrome;
});

test("N3 identityApi: 권한이 없으면 null, 생기면 그 객체, 사라지면 다시 null(부를 때마다 읽는다)", () => {
  globalThis.chrome = { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" } };
  assert.equal(identityApi(), null);
  const identity = { getRedirectURL: () => "x", launchWebAuthFlow: async () => "y" };
  globalThis.chrome.identity = identity;
  assert.equal(identityApi(), identity);
  delete globalThis.chrome.identity;
  assert.equal(identityApi(), null);
});

test("N3 expectedRedirectUri: identity 없이도 확장 ID로 만든다", () => {
  globalThis.chrome = { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" } };
  assert.equal(expectedRedirectUri(), "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/");
  // identity가 다른 값을 돌려줘도 이 함수는 확장 ID만 본다(대조는 부르는 쪽이 한다).
  globalThis.chrome.identity = { getRedirectURL: () => "https://other.chromiumapp.org/" };
  assert.equal(expectedRedirectUri(), "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/");
});
