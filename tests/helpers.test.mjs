import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../src/lib/async.ts";
import { httpOrigin, originLabel } from "../src/lib/url.ts";

test("withTimeout: 제때 끝나면 값, 늦으면 시간 초과 문구로 거부", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "늦음"), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, "입력 응답 없음"), { message: "입력 응답 없음" });
  await assert.rejects(withTimeout(Promise.reject(new Error("원래 오류")), 50, "늦음"), { message: "원래 오류" });
});

test("withTimeout: 중단 신호는 abortMessage로, 이미 중단됐으면 바로 거부하고 리스너를 정리", async () => {
  const c = new AbortController();
  const p = withTimeout(new Promise(() => {}), 1000, "늦음", { signal: c.signal, abortMessage: "중단되어 캡처를 멈췄습니다." });
  c.abort();
  await assert.rejects(p, { message: "중단되어 캡처를 멈췄습니다." });
  const done = new AbortController();
  done.abort();
  await assert.rejects(withTimeout(new Promise(() => {}), 1000, "늦음", { signal: done.signal }), { message: "중단되었습니다." });
  // 끝난 뒤 중단해도 영향 없음(리스너 제거).
  const later = new AbortController();
  assert.equal(await withTimeout(Promise.resolve(1), 1000, "늦음", { signal: later.signal }), 1);
  later.abort();
});

test("httpOrigin: http(s)만 출처, 그 밖·해석 불가·빈 값은 null", () => {
  assert.equal(httpOrigin("https://a.example:8443/p?q=1#h"), "https://a.example:8443");
  assert.equal(httpOrigin("http://127.0.0.1/x"), "http://127.0.0.1");
  assert.equal(httpOrigin("chrome://settings"), null);
  assert.equal(httpOrigin("file:///etc/hosts"), null);
  assert.equal(httpOrigin("not a url"), null);
  assert.equal(httpOrigin(""), null);
  assert.equal(httpOrigin(undefined), null);
});

test("originLabel: 해석되면 출처(scheme 무관), 아니면 앞 40자", () => {
  assert.equal(originLabel("https://a.example/p"), "https://a.example");
  assert.equal(originLabel("about:blank"), "null");
  assert.equal(originLabel("x".repeat(50)), "x".repeat(40));
});
