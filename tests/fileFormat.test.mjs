import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkFileUrl,
  decodeText,
  engineFor,
  filenameFromDisposition,
  sniffFormat,
} from "../src/lib/fileFormat.ts";

const target = (u) => {
  const r = checkFileUrl(u);
  assert.ok(r.ok, `${u}: ${r.reason}`);
  return r.target;
};
const reason = (u) => {
  const r = checkFileUrl(u);
  assert.equal(r.ok, false, u);
  return r.reason;
};

test("checkFileUrl takes the format hint from the path", () => {
  assert.deepEqual(target("https://example.com/files/report.docx"), {
    url: "https://example.com/files/report.docx",
    filename: "report.docx",
    hint: "docx",
  });
  assert.equal(target("http://example.com/a/Budget.XLSX?download=1").hint, "xlsx");
  assert.equal(target("https://example.com/%EB%B3%B4%EA%B3%A0%EC%84%9C.hwp").filename, "보고서.hwp");
  for (const ext of ["pdf", "hwp", "hwpx", "csv", "tsv", "txt", "md", "odt", "ods", "odp", "pptx"]) {
    assert.equal(target(`https://example.com/x.${ext}`).hint, ext);
  }
  assert.equal(target("https://example.com/README.markdown").hint, "md");
});

test("checkFileUrl finds a file name in the query", () => {
  const t = target("https://www.gov.kr/download.do?fileSn=1&fileName=%EA%B3%B5%EA%B3%A0.hwpx");
  assert.equal(t.hint, "hwpx");
  assert.equal(t.filename, "공고.hwpx");
  assert.equal(target("https://example.com/get?path=/a/b/c.pdf").filename, "c.pdf");
});

test("checkFileUrl accepts extension-less download links without a hint", () => {
  assert.deepEqual(target("https://example.com/board/download.do?fileId=123"), {
    url: "https://example.com/board/download.do?fileId=123",
    filename: "",
    hint: null,
  });
  assert.equal(target("https://example.com/files/12345").hint, null);
  assert.equal(target("https://example.com/files/12345").filename, "12345");
  assert.equal(target("https://example.com/fileDown.php?no=9").hint, null);
});

test("checkFileUrl rejects other schemes, non-document extensions and legacy Office", () => {
  assert.match(reason("file:///Users/me/report.docx"), /http/);
  assert.match(reason("chrome-extension://abc/report.docx"), /http/);
  assert.match(reason("https://example.com/report.doc"), /구형 Office/);
  assert.match(reason("https://example.com/a.xls"), /구형 Office/);
  for (const u of ["https://example.com/index.html", "https://example.com/a.png", "https://example.com/a.zip", "https://example.com/setup.exe"]) {
    assert.match(reason(u), /문서 형식이 아닙니다/);
  }
  assert.match(reason("https://user:pw@example.com/a.pdf"), /비밀번호/);
  assert.ok(reason("https://example.com/%E0%A4%A.docx"));
  assert.ok(reason("not a url"));
});

test("filenameFromDisposition handles RFC 6266, quoted, percent-encoded and raw UTF-8/EUC-KR names", () => {
  assert.equal(filenameFromDisposition(null), null);
  assert.equal(filenameFromDisposition("inline"), null);
  assert.equal(filenameFromDisposition(`attachment; filename="a b.pdf"`), "a b.pdf");
  assert.equal(filenameFromDisposition(`attachment; filename=plain.csv`), "plain.csv");
  assert.equal(
    filenameFromDisposition(`attachment; filename="x.pdf"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.hwp`),
    "보고서.hwp",
  );
  assert.equal(filenameFromDisposition(`attachment; filename="%EA%B3%B5%EA%B3%A0.hwpx"`), "공고.hwpx");
  // 서버가 UTF-8 바이트를 그대로 보내면 fetch는 Latin-1 글자로 준다.
  const latin1 = (bytes) => String.fromCharCode(...bytes);
  const utf8 = latin1(new TextEncoder().encode("공고문.hwp"));
  assert.equal(filenameFromDisposition(`attachment; filename="${utf8}"`), "공고문.hwp");
  // EUC-KR "보고서.pdf"
  const euckr = latin1([0xba, 0xb8, 0xb0, 0xed, 0xbc, 0xad, 0x2e, 0x70, 0x64, 0x66]);
  assert.equal(filenameFromDisposition(`attachment; filename="${euckr}"`), "보고서.pdf");
  assert.equal(filenameFromDisposition(`attachment; filename="../../etc/a.txt"`), "a.txt");
});

const bytes = (...parts) => {
  const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0];
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0, 0];
const sniff = (b, hints = {}) => sniffFormat(b, { names: [], contentType: null, ...hints });

test("sniffFormat trusts signatures over names", () => {
  assert.deepEqual(sniff(bytes("%PDF-1.7\n..."), { names: ["report.docx"] }), { ok: true, format: "pdf" });
  assert.deepEqual(sniff(bytes("\n\n%PDF-1.4")), { ok: true, format: "pdf" });
  assert.deepEqual(sniff(bytes("HWP Document File V3.00 \x1a\x01\x02")), { ok: true, format: "hwp" });
  assert.deepEqual(sniff(bytes(OLE)), { ok: true, format: "hwp" });
  assert.deepEqual(sniff(bytes(OLE), { names: ["a.hwp"] }), { ok: true, format: "hwp" });
  assert.equal(sniff(bytes(OLE), { names: ["a.xls"] }).ok, false);
  assert.equal(sniff(bytes(OLE), { contentType: "application/msword" }).ok, false);
});

test("sniffFormat tells zip formats apart by their contents", () => {
  const zip = (names, mimetype = null) => sniff(bytes(ZIP), { names: ["download.do"], zip: { names, mimetype } });
  assert.equal(zip(["[Content_Types].xml", "word/document.xml"]).format, "docx");
  assert.equal(zip(["[Content_Types].xml", "xl/workbook.xml"]).format, "xlsx");
  assert.equal(zip(["[Content_Types].xml", "ppt/presentation.xml"]).format, "pptx");
  assert.equal(zip(["mimetype", "Contents/section0.xml"], "application/hwp+zip").format, "hwpx");
  assert.equal(zip(["Contents/content.hpf"]).format, "hwpx");
  assert.equal(zip(["mimetype", "content.xml"], "application/vnd.oasis.opendocument.text").format, "odt");
  assert.equal(zip(["mimetype", "content.xml"], "application/vnd.oasis.opendocument.spreadsheet").format, "ods");
  assert.equal(zip(["mimetype", "content.xml"], "application/vnd.oasis.opendocument.presentation").format, "odp");
  assert.equal(zip(["a.png", "b.png"]).ok, false);
  assert.equal(sniff(bytes(ZIP)).ok, false);
});

test("sniffFormat picks text formats from names, then Content-Type", () => {
  const text = bytes("이름,나이\n홍길동,30\n");
  assert.equal(sniff(text, { names: ["a.csv"] }).format, "csv");
  assert.equal(sniff(text, { names: ["data.tsv"] }).format, "tsv");
  assert.equal(sniff(text, { names: ["notes.md"] }).format, "md");
  // Content-Disposition 이름이 URL 이름보다 앞선다.
  assert.equal(sniff(text, { names: ["a.csv", "download.txt"] }).format, "csv");
  assert.equal(sniff(text, { contentType: "text/csv; charset=euc-kr" }).format, "csv");
  assert.equal(sniff(text, { contentType: "text/markdown" }).format, "md");
  assert.equal(sniff(text, { contentType: "application/octet-stream" }).format, "txt");
  assert.equal(sniff(text).format, "txt");
  assert.equal(sniff(text, { contentType: "application/json" }).ok, false);
});

test("sniffFormat rejects binary junk, HTML pages and names that don't match the content", () => {
  assert.equal(sniff(bytes([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { names: ["a.txt"] }).ok, false);
  assert.match(sniff(bytes("  <!DOCTYPE html><html>"), { names: ["a.txt"] }).reason, /웹 페이지/);
  assert.match(sniff(bytes("<html><body>login"), { contentType: "text/html" }).reason, /웹 페이지/);
  assert.match(sniff(bytes("just text"), { names: ["a.pdf"] }).reason, /\.pdf/);
  assert.match(sniff(bytes("just text"), { names: ["a.hwp"] }).reason, /\.hwp/);
  // UTF-16 BOM 텍스트는 NUL이 있어도 텍스트다.
  assert.equal(sniff(bytes([0xff, 0xfe, 0x41, 0, 0x42, 0]), { names: ["a.txt"] }).format, "txt");
});

test("decodeText falls back to EUC-KR (CP949) and honours BOMs", () => {
  assert.deepEqual(decodeText(bytes("가나다")), { text: "가나다", encoding: "utf-8" });
  assert.deepEqual(decodeText(bytes([0xef, 0xbb, 0xbf], "a,b")), { text: "a,b", encoding: "utf-8" });
  // CP949 "이름,나이"
  assert.deepEqual(decodeText(bytes([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb3, 0xaa, 0xc0, 0xcc])), {
    text: "이름,나이",
    encoding: "euc-kr",
  });
  assert.equal(decodeText(bytes([0xff, 0xfe, 0x41, 0, 0x42, 0])).text, "AB");
  assert.equal(decodeText(bytes([0xfe, 0xff, 0, 0x41])).text, "A");
});

test("engineFor routes formats to converters", () => {
  assert.equal(engineFor("docx"), "docling");
  assert.equal(engineFor("csv"), "table");
  assert.equal(engineFor("tsv"), "table");
  assert.equal(engineFor("pdf"), "pdf");
  assert.equal(engineFor("hwp"), "hwp");
  assert.equal(engineFor("hwpx"), "hwp");
  assert.equal(engineFor("txt"), "text");
  assert.equal(engineFor("md"), "text");
});

test("saveOnlyExtension: 읽을 수 없지만 저장할 수 있는 파일만(#48), 읽기 판정은 그대로", async () => {
  const { saveOnlyExtension } = await import("../src/lib/fileFormat.ts");
  assert.equal(saveOnlyExtension("https://a.com/files/%EC%9E%90%EB%A3%8C.zip"), "zip");
  assert.equal(saveOnlyExtension("https://a.com/old.xls"), "xls");
  assert.equal(saveOnlyExtension("https://a.com/photo.jpg?x=1"), "jpg");
  // 웹 페이지·스크립트·데이터는 저장 후보가 아니다.
  assert.equal(saveOnlyExtension("https://a.com/index.html"), null);
  assert.equal(saveOnlyExtension("https://a.com/app.js"), null);
  // 읽을 수 있는 것과 확장자 없는 다운로드 링크는 이 함수의 대상이 아니다(read_document 경로).
  assert.equal(saveOnlyExtension("https://a.com/a.pdf"), null);
  assert.equal(saveOnlyExtension("https://a.com/download.do?fileId=1"), null);
  assert.equal(saveOnlyExtension("javascript:void(0)"), null);
  assert.equal(checkFileUrl("https://a.com/files/x.zip").ok, false);
});

test("계정 정보가 실린 주소는 저장 전용 경로로도 다시 허용하지 않는다(#48 리뷰)", async () => {
  const { saveOnlyExtension, hasUrlCredentials } = await import("../src/lib/fileFormat.ts");
  assert.equal(checkFileUrl("https://alice:secret@example.com/archive.zip").ok, false);
  assert.equal(saveOnlyExtension("https://alice:secret@example.com/archive.zip"), null);
  assert.equal(saveOnlyExtension("https://alice@example.com/old.xls"), null);
  assert.equal(saveOnlyExtension("https://:pw@example.com/a.jpg"), null);
  assert.equal(saveOnlyExtension("ftp://example.com/a.zip"), null);
  assert.equal(hasUrlCredentials("https://alice:secret@example.com/a.png"), true);
  assert.equal(hasUrlCredentials("https://example.com/a.png?user=alice"), false);
  assert.equal(hasUrlCredentials("not a url"), false);
});
