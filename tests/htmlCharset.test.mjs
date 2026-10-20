import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeHtml, htmlCharset } from "../src/lib/htmlCharset.ts";

const enc = (s) => new TextEncoder().encode(s);

test("charset from header, then meta, else null", () => {
  assert.equal(htmlCharset("text/html; charset=EUC-KR", enc("<p>x")), "euc-kr");
  assert.equal(htmlCharset('text/html; charset="utf-8"', enc("<p>x")), "utf-8");
  assert.equal(htmlCharset("text/html", enc('<html><head><meta charset="euc-kr">')), "euc-kr");
  assert.equal(htmlCharset("text/html", enc('<meta http-equiv="Content-Type" content="text/html; charset=ks_c_5601-1987">')), "ks_c_5601-1987");
  assert.equal(htmlCharset("text/html", enc("<p>plain</p>")), null);
  assert.equal(htmlCharset("text/html; charset=<script>", enc("")), null);
});

test("decodes EUC-KR declared in meta and falls back for undeclared non-UTF-8", () => {
  // "한글" in EUC-KR
  const euckr = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]);
  const withMeta = new Uint8Array([...enc('<meta charset="euc-kr"><p>'), ...euckr]);
  assert.match(decodeHtml("text/html", withMeta), /한글/);
  assert.match(decodeHtml("text/html", new Uint8Array([...enc("<p>"), ...euckr])), /한글/);
  assert.match(decodeHtml("text/html; charset=utf-8", enc("<p>한글")), /한글/);
  assert.match(decodeHtml("text/html; charset=bogus-label", enc("<p>한글")), /한글/);
});
