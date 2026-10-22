import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CSV_MAX_CHARS,
  MAX_CSV_MAX_CHARS,
  MIN_CSV_MAX_CHARS,
  normalizeCsvMaxChars,
  DEFAULT_MAX_TOOL_HOPS,
  MAX_TOOL_HOPS_VERSION,
  normalizeMaxToolHops,
} from "../src/lib/messages.ts";

test("normalizeCsvMaxChars: 없거나 잘못된 값은 기본값, 범위 밖은 끝값", () => {
  assert.equal(normalizeCsvMaxChars(undefined), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars("50000"), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(Number.NaN), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(10), MIN_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(10_000_000), MAX_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(12_345.9), 12_345);
});

test("normalizeMaxToolHops: 버전 표시 없는 예전 기본값 8은 새 기본값, 저장한 8은 그대로", () => {
  assert.equal(DEFAULT_MAX_TOOL_HOPS, 16);
  assert.equal(normalizeMaxToolHops(undefined), 16);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 8 }), 16);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 8, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 8);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 12 }), 12);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 99, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 99);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 100, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 100);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 250, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 100);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 0, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 1);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 0.5 }), 1);
  assert.equal(normalizeMaxToolHops({ maxToolHops: "8" }), 16);
});
