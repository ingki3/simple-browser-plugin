// shims/zlib.mjs가 Node zlib처럼 maxOutputLength를 지키고, 문서 한 건의 합계 한도도 지키는지 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

const MB = 1024 * 1024;
const shim = await import("./shims/zlib.mjs");

test("round-trips and keeps Buffer methods", () => {
  const data = Buffer.from("가나다 hello ".repeat(1000), "utf8");
  assert.equal(shim.inflateRawSync(zlib.deflateRawSync(data)).toString("utf8"), data.toString("utf8"));
  assert.equal(shim.inflateSync(zlib.deflateSync(data)).readUInt16LE(0), data.readUInt16LE(0));
});

test("stops at maxOutputLength with Node's error code", () => {
  const bomb = zlib.deflateRawSync(Buffer.alloc(10 * MB), { level: 9 });
  assert.throws(() => shim.inflateRawSync(bomb, { maxOutputLength: MB }), { code: "ERR_BUFFER_TOO_LARGE" });
  assert.throws(() => zlib.inflateRawSync(bomb, { maxOutputLength: MB }), { code: "ERR_BUFFER_TOO_LARGE" });
});

test("returns what it could read from a truncated stream only with finishFlush", () => {
  const full = zlib.deflateRawSync(Buffer.from("x".repeat(100000) + "y".repeat(100000)));
  const cut = full.subarray(0, full.length - 10);
  assert.throws(() => shim.inflateRawSync(cut));
  assert.ok(shim.inflateRawSync(cut, { finishFlush: 2 }).length > 0);
});

test("caps the total inflated per document at 256MB", () => {
  const chunk = zlib.deflateRawSync(Buffer.alloc(90 * MB), { level: 9 });
  shim.inflateRawSync(chunk, { maxOutputLength: 100 * MB });
  shim.inflateRawSync(chunk, { maxOutputLength: 100 * MB });
  assert.throws(() => shim.inflateRawSync(chunk, { maxOutputLength: 100 * MB }), { code: "ERR_BUFFER_TOO_LARGE" });
});
