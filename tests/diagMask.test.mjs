// 진단 복사의 공유 전 가리기(#132).
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskDiagnostics, maskSummary } from "../src/lib/diagMask.ts";

test("주소는 scheme://host만, 사용자 정보는 버림, 경로가 없으면 그대로", () => {
  const r = maskDiagnostics("go https://user:pw@shop.example.com/order/12345?id=9#x then http://a.test/ and chrome-extension://abc/src/x.html");
  assert.equal(r.text, "go https://shop.example.com/… then http://a.test and chrome-extension://abc/…");
  assert.equal(r.counts.url, 3);
});

test("IPv6 호스트·괄호가 든 경로도 주소로 가린다", () => {
  const r = maskDiagnostics("a https://[2001:db8::1]/private/alice?email=alice%40corp.test b https://example.com/docs/(private)/alice?email=x");
  assert.equal(r.text, "a https://[2001:db8::1]/… b https://example.com/…");
  assert.equal(r.counts.url, 2);
});

test("주소 안의 작은따옴표 뒤도 가린다, 긴 글도 빠르게", () => {
  assert.equal(maskDiagnostics("x https://portal.example/users/O'Connor/private?session=short-secret y").text, "x https://portal.example/… y");
  const long = "가".repeat(30_000);
  const t0 = Date.now();
  assert.equal(maskDiagnostics(long).text, long);
  assert.ok(Date.now() - t0 < 300, `30,000자 ${Date.now() - t0}ms`);
});

test("이메일·파일 이름·긴 값·긴 숫자", () => {
  const r = maskDiagnostics("mail me@corp.co.kr file 2024 보고서_최종.hwpx key sk-or-v1-abcdefghijklmnopqrstuvwxyz order 98765432");
  assert.equal(r.text, "mail [이메일] file 2024 [파일].hwpx key [긴 값] order [숫자]");
  assert.deepEqual(r.counts, { url: 0, email: 1, file: 1, token: 1, number: 1 });
});

test("주소 뒤 꼬리는 중괄호·인코딩한 이메일까지 모두 가리고, 앞 글자는 둔다", () => {
  const r = maskDiagnostics("see url=https://example.com/report?filter={status}&amp;email=alice%40corp.test.");
  assert.equal(r.text, "see url=https://example.com/…");
  assert.equal(r.counts.url, 1);
  assert.equal(maskDiagnostics("x alice%40corp.test y").text, "x [이메일] y");
});

test("사용자 정보는 어떤 글자가 있어도 통째로 버린다", () => {
  assert.equal(maskDiagnostics("x https://alice:secret!+$@example.com/private y").text, "x https://example.com/… y");
  assert.equal(maskDiagnostics("https://alice:p@ss@example.com").text, "https://example.com");
  assert.equal(maskDiagnostics("https://@/x").text, "[주소]");
});

test("주소 앞의 이메일도 가리고, 경로 없는 주소 뒤의 선택자 나머지도 가린다", () => {
  assert.equal(maskDiagnostics("query='alice@corp.test|https://shop.test/x'").text, "[이메일]https://shop.test/…");
  assert.equal(
    maskDiagnostics(`selector='a[href="https://shop.test"][data-order="123456789"]'`).text,
    `selector='a[href="https://shop.test/…`,
  );
});

test("긴 파일 이름도 전체를 가리고, 긴 글(주소·이메일 실패 모양)도 빠르다", () => {
  assert.equal(maskDiagnostics(`${"고객_홍길동_" + "가".repeat(130)}.pdf`).text, "[파일].pdf");
  for (const long of ["a.".repeat(60_000), "가".repeat(60_000), "a@".repeat(30_000), `${"!".repeat(60_000)}가`]) {
    const t0 = Date.now();
    maskDiagnostics(long);
    assert.ok(Date.now() - t0 < 300, `${long.slice(0, 4)}… ${Date.now() - t0}ms`);
  }
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
