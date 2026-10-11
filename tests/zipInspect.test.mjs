import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { zipXmlUncompressedBytes } from "../src/lib/zipInspect.ts";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("zipXmlUncompressedBytes sums XML part sizes from the central directory", () => {
  // 기대값은 Python zipfile로 구한 .xml/.rels 파트 file_size 합계.
  assert.equal(zipXmlUncompressedBytes(fixture("report_ko.docx")), 820_114);
  // 56KB zip이지만 압축을 풀면 8MB: 변환 전에 걸러야 하는 경우.
  assert.equal(zipXmlUncompressedBytes(fixture("paras_200000.docx")), 8_017_836);
});

test("zipXmlUncompressedBytes rejects non-zip and truncated input", () => {
  assert.equal(zipXmlUncompressedBytes(new TextEncoder().encode("not a zip")), null);
  assert.equal(zipXmlUncompressedBytes(new Uint8Array(0)), null);
  const doc = fixture("report_ko.docx");
  assert.equal(zipXmlUncompressedBytes(doc.subarray(0, doc.length - 30)), null);
});

test("zipXmlUncompressedBytes flags ZIP64 markers", () => {
  const doc = fixture("report_ko.docx").slice();
  const view = new DataView(doc.buffer);
  let eocd = doc.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  view.setUint32(eocd + 16, 0xffffffff, true);
  assert.equal(zipXmlUncompressedBytes(doc), "zip64");
});
