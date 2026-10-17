// vendor/kordoc 번들(브라우저용으로 고친 kordoc)의 회귀 테스트. kordoc 버전을 올리면 여기부터 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sanitizeOfficeZip } from "../src/lib/zipSanitize.ts";
import { peekZip } from "../src/lib/zipSanitize.ts";
import { sniffFormat } from "../src/lib/fileFormat.ts";
import * as kordoc from "../vendor/kordoc/dist/kordoc-hwp.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/hwp/${name}`, import.meta.url)));
const LIMITS = { maxXmlBytes: 6 * 1024 * 1024, maxTotalBytes: 40 * 1024 * 1024 };
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test("HWP 5 is detected by signature and converted with tables", async () => {
  const bytes = fixture("work_report.hwp");
  assert.deepEqual(sniffFormat(bytes, { names: [], contentType: null }), { ok: true, format: "hwp" });
  assert.equal(kordoc.detectFormat(ab(bytes)), "hwp");
  assert.equal(kordoc.detectOle2Format(ab(bytes)), "hwp");
  const r = await kordoc.parseHwp(ab(bytes), { ocr: false });
  assert.ok(r.success, r.error);
  assert.match(r.markdown, /주간업무보고서/);
  assert.match(r.markdown, /\| 업무내용 \|/);
});

test("HWPX survives zip sanitising and keeps its text", async () => {
  const raw = fixture("chart.hwpx");
  assert.deepEqual(sniffFormat(raw, { names: ["download.do"], contentType: null, zip: peekZip(raw) }), {
    ok: true,
    format: "hwpx",
  });
  const sanitized = (await sanitizeOfficeZip(raw, LIMITS)).bytes;
  assert.equal(kordoc.detectFormat(ab(sanitized)), "hwpx");
  const r = await kordoc.parseHwpx(ab(sanitized), { ocr: false });
  assert.ok(r.success, r.error);
  assert.match(r.markdown, /차트를 조건에 따라 완성하여 제출해 주세요/);
});

test("password-protected HWPX reports ENCRYPTED", async () => {
  const sanitized = (await sanitizeOfficeZip(fixture("password.hwpx"), LIMITS)).bytes;
  const r = await kordoc.parseHwpx(ab(sanitized), { ocr: false });
  assert.equal(r.success, false);
  assert.equal(r.code, "ENCRYPTED");
});

test("an HWP stream that inflates to 150MB stops at kordoc's limit instead of being fully inflated", async () => {
  // BodyText/Section0이 150MB의 0으로 풀리는 문서(157KB). 셰임이 maxOutputLength(100MB)를 지키면 그 구역은
  // ERR_BUFFER_TOO_LARGE로 실패하고 kordoc가 PARTIAL_PARSE 경고를 남긴다. 셰임이 옵션을 버리면 끝까지 풀어 경고가 없다.
  // (메모리 사용량은 GC 시점에 따라 흔들려서 비교하지 않는다.)
  const r = await kordoc.parseHwp(ab(fixture("bomb.hwp")), { ocr: false });
  assert.ok(r.success);
  assert.equal(r.markdown.trim(), "");
  assert.ok(
    r.warnings?.some((w) => w.code === "PARTIAL_PARSE" && /larger than/.test(w.message)),
    JSON.stringify(r.warnings),
  );
});

test("a corrupt second section is reported as a lossy note, not silently dropped", async () => {
  const { lossyNote } = await import("../src/offscreen/engines/hwp.ts");
  const r = await kordoc.parseHwp(ab(fixture("partial.hwp")), { ocr: false });
  assert.ok(r.success);
  assert.match(r.markdown, /주간업무보고서/);
  assert.ok(r.warnings.some((w) => w.code === "PARTIAL_PARSE"));
  assert.match(lossyNote(r.warnings), /건너뛰었습니다.*섹션 2/);
  assert.equal(lossyNote([{ code: "SKIPPED_IMAGE", message: "그림" }]), null);
});
