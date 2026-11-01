import { test } from "node:test";
import assert from "node:assert/strict";
import { HREF_MAX, ROLE_MAX, resultHref, resultRole } from "../src/lib/clickResult.ts";

test("resultHref: 상한 이하면 그대로, 넘으면 비우고 길이·scheme", () => {
  const ok = `https://a.example/${"x".repeat(HREF_MAX - 18)}`;
  assert.equal(ok.length, HREF_MAX);
  assert.deepEqual(resultHref(ok), { href: ok });
  const long = `${ok}y`;
  assert.deepEqual(resultHref(long), { href: "", hrefTooLong: { length: HREF_MAX + 1, scheme: "https:" } });
  assert.deepEqual(resultHref(`DATA:image/png;base64,${"A".repeat(3000)}`).hrefTooLong, { length: 3022, scheme: "data:" });
  assert.equal(resultHref("").href, "");
});

test("resultHref: 긴 사용자 정의 scheme·scheme 없음은 scheme을 싣지 않는다", () => {
  const custom = `${"a".repeat(20000)}:x`;
  assert.deepEqual(resultHref(custom), { href: "", hrefTooLong: { length: 20002 } });
  assert.deepEqual(resultHref(`/${"p".repeat(3000)}`), { href: "", hrefTooLong: { length: 3001 } });
  assert.equal(resultHref(`a${"b".repeat(19)}:${"x".repeat(3000)}`).hrefTooLong.scheme, `a${"b".repeat(19)}:`);
  assert.equal(resultHref(`a${"b".repeat(20)}:${"x".repeat(3000)}`).hrefTooLong.scheme, undefined);
});

test("resultRole: 길이 상한", () => {
  assert.equal(resultRole("button"), "button");
  assert.equal(resultRole("r".repeat(5000)).length, ROLE_MAX);
});
