// 진단 복사의 공유 전 가리기(#132).
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDiagnostics, maskSummary } from "../src/lib/diagMask.ts";

test("주소는 scheme://host만, 사용자 정보는 버림, 경로가 없으면 그대로", () => {
  const r = maskDiagnostics("go https://user:pw@shop.example.com/order/12345?id=9#x then http://a.test/ and chrome-extension://abc/src/x.html");
  assert.equal(r.text, "go https://shop.example.com/… then http://a.test and chrome-extension://abc/…");
  assert.equal(r.counts.url, 3);
});

test("이메일·파일 이름·긴 값·긴 숫자", () => {
  const r = maskDiagnostics("mail me@corp.co.kr file 2024 보고서_최종.hwpx key sk-or-v1-abcdefghijklmnopqrstuvwxyz order 98765432");
  assert.equal(r.text, "mail [이메일] file 2024 [파일].hwpx key [긴 값] order [숫자]");
  assert.deepEqual(r.counts, { url: 0, email: 1, file: 1, token: 1, number: 1 });
});

test("겹치는 것은 원문에서 한 번에 — 긴 토큰 안의 숫자가 조각으로 남지 않음, 주소 안의 이메일·숫자는 주소로", () => {
  const r = maskDiagnostics("abcdefghijkl123456mnopqrst https://x.test/a/me@b.com/1234567");
  assert.equal(r.text, "[긴 값] https://x.test/…");
  assert.deepEqual(r.counts, { url: 1, email: 0, file: 0, token: 1, number: 0 });
});

test("진단에 쓰는 짧은 값은 남긴다(시각·쉼표 숫자·도구 이름·사용량)", () => {
  const line = "12:34:56.789 [bg] model:usage · 입력 12,345(캐시 읽기 8,000) · 출력 456 · 3.2s · tab 512";
  assert.equal(maskDiagnostics(line).text, line);
  assert.equal(maskSummary(maskDiagnostics(line).counts), "가린 것 없음");
  assert.equal(maskSummary({ url: 3, email: 1, file: 0, token: 0, number: 2 }), "주소 3 · 이메일 1 · 긴 숫자 2");
});
