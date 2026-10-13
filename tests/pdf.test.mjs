// pdf.js 워커 패치(scripts/pdfjsWorkerPatch.ts)가 압축 폭탄 PDF의 압축 해제를 한도에서 멈추는지 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { patchPdfWorker, PDF_DECODE_BUDGET } from "../scripts/pdfjsWorkerPatch.ts";

const workerSource = readFileSync(new URL("../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), "utf8");
const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url)));

// Node에서는 pdf.js가 workerSrc 모듈을 같은 스레드에서 불러 쓴다(fake worker). 문서마다 새 모듈로 세도록 쿼리를 붙인다.
async function textOf(bytes, source) {
  const dir = mkdtempSync(join(tmpdir(), "pdfw-"));
  const file = join(dir, "pdf.worker.mjs");
  writeFileSync(file, source);
  // 워커 모듈은 globalThis.pdfjsWorker에 자신을 등록하고, pdf.js는 그것이 있으면 다시 쓴다.
  delete globalThis.pdfjsWorker;
  const pdfjs = await import(`../node_modules/pdfjs-dist/legacy/build/pdf.mjs?${dir}`);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(file).href;
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().arrayBuffers)), 5);
  const base = process.memoryUsage().arrayBuffers;
  try {
    const cMapUrl = new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url).pathname;
    const task = pdfjs.getDocument({ data: bytes, verbosity: 0, cMapUrl, cMapPacked: true });
    const doc = await task.promise;
    const content = await (await doc.getPage(1)).getTextContent();
    await task.destroy();
    return { text: content.items.map((i) => i.str).join(""), grew: Math.max(peak, process.memoryUsage().arrayBuffers) - base };
  } catch (err) {
    return { error: String(err), grew: Math.max(peak, process.memoryUsage().arrayBuffers) - base };
  } finally {
    clearInterval(timer);
  }
}

test("the patch applies to the installed pdf.js and fails loudly if pdf.js changes", () => {
  const patched = patchPdfWorker(workerSource);
  assert.equal(patched.split("__decodeCharge(").length - 1, 3); // 정의 1 + 호출 2
  assert.throws(() => patchPdfWorker(workerSource.replace("buffer2.set(buffer);", "buffer2.set(buffer)")), /패치 위치/);
});

test("a 200KB PDF whose content stream inflates to 200MB stops at the decode budget", async () => {
  const bytes = fixture("bomb.pdf");
  assert.ok(bytes.byteLength < 400 * 1024);
  const patched = await textOf(bytes.slice(), patchPdfWorker(workerSource));
  assert.ok(!patched.text, JSON.stringify(patched).slice(0, 200));
  assert.ok(patched.grew < PDF_DECODE_BUDGET + 32 * 1024 * 1024, `grew ${patched.grew}`);
});

test("normal PDFs still read with the patch (Korean CID font via CMap)", async () => {
  const r = await textOf(fixture("cid_ko.pdf"), patchPdfWorker(workerSource));
  assert.equal(r.text, "가나다", JSON.stringify(r));
});

test("without the patch the same PDF inflates far past the budget (the test can tell)", async () => {
  const r = await textOf(fixture("bomb.pdf"), workerSource);
  assert.ok(r.grew > PDF_DECODE_BUDGET + 32 * 1024 * 1024, `grew ${r.grew}`);
});
