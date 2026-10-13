import { test } from "node:test";
import assert from "node:assert/strict";

import { csvToMarkdown, detectDelimiter } from "../src/lib/csvTable.ts";

test("converts CSV to a Markdown table with quotes, escapes and padding", () => {
  const csv = '이름,부서,매출\r\n김철수,영업1팀,"1,200"\n"이 ""영희""",영업2팀\n\n"줄\n바꿈",a|b,3\n';
  const t = csvToMarkdown(csv, ",", 10_000);
  assert.equal(
    t.markdown,
    [
      "| 이름 | 부서 | 매출 |",
      "| --- | --- | --- |",
      "| 김철수 | 영업1팀 | 1,200 |",
      '| 이 "영희" | 영업2팀 |  |',
      "| 줄<br>바꿈 | a\\|b | 3 |",
    ].join("\n"),
  );
  assert.deepEqual([t.rows, t.shownRows, t.truncated], [4, 4, false]);
});

test("detects the delimiter outside quotes", () => {
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n"), ";");
  assert.equal(detectDelimiter('a,b\n"x;y;z",2\n'), ",");
  assert.equal(detectDelimiter("a\tb\n1\t2\n"), "\t");
  assert.equal(detectDelimiter("a|b|c\n1|2|3"), "|");
  assert.equal(detectDelimiter("only one column\nvalue"), ",");
});

test("stops at maxChars and keeps counting rows", () => {
  const csv = "id,name\n" + Array.from({ length: 5000 }, (_, i) => `${i},이름${i}`).join("\n");
  const t = csvToMarkdown(csv, ",", 2000);
  assert.ok(t.markdown.length <= 2000, String(t.markdown.length));
  assert.equal(t.rows, 5001);
  assert.ok(t.truncated && t.shownRows > 10 && t.shownRows < 5001);
});

test("millions of cells in one row stay within maxChars and run fast", () => {
  // Codex 재현: docling은 이 4MB 입력에 WASM 메모리를 434MiB까지 썼다.
  const csv = "a,".repeat(2_000_000) + "a\n";
  const before = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  const t = csvToMarkdown(csv, ",", 40_000);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(t.markdown, "");
  assert.equal(t.rows, 1);
  assert.ok(process.memoryUsage().heapUsed - before < 64 * 1024 * 1024);
});

test("one huge quoted field doesn't grow past maxChars", () => {
  const t = csvToMarkdown('h\n"' + "x".repeat(3_000_000) + '"\nlast\n', ",", 1000);
  assert.equal(t.markdown, "| h |\n| --- |");
  assert.equal(t.rows, 3);
  assert.ok(t.truncated);
});
