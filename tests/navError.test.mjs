import test from "node:test";
import assert from "node:assert/strict";

import { describeNavigationError, navErrorKind } from "../src/lib/navError.ts";

test("navErrorKind: classifies Chrome net error codes", () => {
  assert.equal(navErrorKind("net::ERR_NAME_NOT_RESOLVED"), "name");
  assert.equal(navErrorKind("net::ERR_CERT_COMMON_NAME_INVALID"), "cert");
  assert.equal(navErrorKind("net::ERR_CONNECTION_REFUSED"), "connection");
  assert.equal(navErrorKind("net::ERR_TIMED_OUT"), "connection");
  assert.equal(navErrorKind("net::ERR_BLOCKED_BY_CLIENT"), "other");
});

test("describeNavigationError: reports origin and code only, never path or query", () => {
  const msg = describeNavigationError({
    url: "https://www.srt.co.kr/path/secret?phone=01012345678",
    error: "net::ERR_CERT_COMMON_NAME_INVALID",
  });
  assert.match(msg, /https:\/\/www\.srt\.co\.kr /);
  assert.match(msg, /net::ERR_CERT_COMMON_NAME_INVALID/);
  assert.match(msg, /건너뛰어 접속하지 마세요/);
  assert.doesNotMatch(msg, /secret|01012345678/);
});

test("describeNavigationError: odd codes and non-web URLs are not echoed", () => {
  const msg = describeNavigationError({ url: "data:text/html,hi", error: "<b>weird</b>" });
  assert.match(msg, /알 수 없는 오류/);
  assert.doesNotMatch(msg, /weird|data:/);
});
