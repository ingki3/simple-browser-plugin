import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CSV_MAX_CHARS,
  MAX_CSV_MAX_CHARS,
  MIN_CSV_MAX_CHARS,
  normalizeCsvMaxChars,
} from "../src/lib/messages.ts";

test("normalizeCsvMaxChars: 없거나 잘못된 값은 기본값, 범위 밖은 끝값", () => {
  assert.equal(normalizeCsvMaxChars(undefined), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars("50000"), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(Number.NaN), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(10), MIN_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(10_000_000), MAX_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(12_345.9), 12_345);
});
