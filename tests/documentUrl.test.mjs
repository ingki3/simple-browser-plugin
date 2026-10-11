import test from "node:test";
import assert from "node:assert/strict";

import { parseDocumentUrl } from "../src/lib/documentUrl.ts";

test("parseDocumentUrl accepts http(s) URLs ending in a supported extension", () => {
  assert.deepEqual(parseDocumentUrl("https://example.com/files/report.docx"), {
    url: "https://example.com/files/report.docx",
    filename: "report.docx",
    extension: "docx",
  });
  assert.equal(parseDocumentUrl("http://example.com/a/Budget.XLSX?download=1")?.extension, "xlsx");
  assert.equal(parseDocumentUrl("https://example.com/deck.pptx#slide=3")?.filename, "deck.pptx");
  assert.equal(
    parseDocumentUrl("https://example.com/%EB%B3%B4%EA%B3%A0%EC%84%9C.docx")?.filename,
    "보고서.docx",
  );
});

test("parseDocumentUrl rejects other schemes, extensions and extension-less links", () => {
  assert.equal(parseDocumentUrl("file:///Users/me/report.docx"), null);
  assert.equal(parseDocumentUrl("chrome-extension://abc/report.docx"), null);
  assert.equal(parseDocumentUrl("https://example.com/report.doc"), null);
  assert.equal(parseDocumentUrl("https://example.com/report.pdf"), null);
  assert.equal(parseDocumentUrl("https://example.com/download?file=report.docx"), null);
  assert.equal(parseDocumentUrl("https://example.com/report.docx/"), null);
  assert.equal(parseDocumentUrl("https://example.com/logout"), null);
  assert.equal(parseDocumentUrl("https://example.com/%E0%A4%A.docx"), null);
  assert.equal(parseDocumentUrl("not a url"), null);
});
