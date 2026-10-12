import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { sanitizeOfficeZip, ZipRejected } from "../src/lib/zipSanitize.ts";
import initDocling, { convert } from "docling.rs-wasm/web";

const require = createRequire(import.meta.url);
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const LIMITS = { maxXmlBytes: 6 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 };

await initDocling({ module_or_path: readFileSync(require.resolve("docling.rs-wasm/web/docling_wasm_bg.wasm")) });

// 중앙 디렉터리에서 이름이 name인 항목의 "압축 해제 크기" 필드를 value로 바꾼다.
function forgeUncompressedSize(bytes, name, value) {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const target = new TextEncoder().encode(name);
  for (let i = 0; i < out.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const len = view.getUint16(i + 28, true);
    if (len === target.length && out.subarray(i + 46, i + 46 + len).every((b, k) => b === target[k])) {
      view.setUint32(i + 24, value, true);
      return out;
    }
  }
  throw new Error(`entry not found: ${name}`);
}

test("sanitized zip converts to the same Markdown as the original", async () => {
  const original = fixture("report_ko.docx");
  const result = await sanitizeOfficeZip(original, LIMITS);
  assert.equal(result.xmlBytes, 820_114);
  assert.equal(convert(result.bytes, "report_ko.docx", "md"), convert(original, "report_ko.docx", "md"));
});

test("real inflated size is enforced even when the central directory lies", async () => {
  const bomb = fixture("paras_200000.docx");
  await assert.rejects(sanitizeOfficeZip(bomb, LIMITS), ZipRejected);
  const forged = forgeUncompressedSize(bomb, "word/document.xml", 1);
  await assert.rejects(sanitizeOfficeZip(forged, LIMITS), /본문 XML이 6MB를 넘습니다/);
});

// 이름이 같은 길이의 다른 이름으로 바뀐 사본(로컬·중앙 헤더 모두)을 만든다.
function renameEntry(bytes, from, to) {
  const a = new TextEncoder().encode(from);
  const b = new TextEncoder().encode(to);
  assert.equal(a.length, b.length);
  const out = bytes.slice();
  let hits = 0;
  for (let i = 0; i <= out.length - a.length; i++) {
    if (a.every((x, k) => out[i + k] === x)) {
      out.set(b, i);
      hits++;
    }
  }
  assert.ok(hits >= 2);
  return out;
}

test("part names don't decide what counts toward the XML budget", async () => {
  const renamed = renameEntry(fixture("paras_200000.docx"), "word/document.xml", "word/document.png");
  await assert.rejects(sanitizeOfficeZip(renamed, LIMITS), /본문 XML이 6MB를 넘습니다/);
});

test("binary media is emptied and not counted as XML", async () => {
  const result = await sanitizeOfficeZip(fixture("report_ko.docx"), LIMITS);
  assert.ok(result.totalBytes > result.xmlBytes);
});

test("content that doesn't match the original CRC is rejected", async () => {
  const doc = fixture("report_ko.docx").slice();
  const view = new DataView(doc.buffer);
  for (let i = 0; i < doc.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 16, view.getUint32(i + 16, true) ^ 1, true);
      break;
    }
  }
  await assert.rejects(sanitizeOfficeZip(doc, LIMITS), /CRC 불일치/);
});

test("limits are configurable and non-zip input is rejected", async () => {
  await assert.rejects(
    sanitizeOfficeZip(fixture("report_ko.docx"), { maxXmlBytes: 100_000, maxTotalBytes: LIMITS.maxTotalBytes }),
    ZipRejected,
  );
  await assert.rejects(sanitizeOfficeZip(new TextEncoder().encode("not a zip"), LIMITS), /zip 형식이 아닙니다/);
});

test("encrypted entries are rejected", async () => {
  const doc = fixture("report_ko.docx").slice();
  const view = new DataView(doc.buffer);
  for (let i = 0; i < doc.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true);
      break;
    }
  }
  await assert.rejects(sanitizeOfficeZip(doc, LIMITS), /암호/);
});
