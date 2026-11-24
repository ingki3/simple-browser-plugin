// 시간 제한이 있는 fetch(src/background/auth/http.ts, #319 공용 인증 층). fetch는 대역이고 실제 네트워크로 나가지 않는다.
// 대역의 응답 본문은 실제 fetch처럼 요청 신호와 이어져 있다: 신호가 abort되면 본문 스트림이 오류로 끝난다
// (신호와 이어지지 않은 스트림은 abort돼도 계속 기다린다).
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const { fetchLimited, AUTH_FETCH_LIMIT_MS } = await import("../src/background/auth/http.ts");

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// 본문이 끝나지 않는 응답. 요청 신호가 abort되면 스트림을 오류로 끝낸다.
function stalledBody(status, signal) {
  const stream = new ReadableStream({
    start(controller) {
      const fail = () => controller.error(new DOMException("aborted", "AbortError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    },
  });
  return new Response(stream, { status });
}
// 헤더가 오지 않는 요청. 신호가 abort되면 거부한다.
const neverResponds = (signal) =>
  new Promise((_, reject) => {
    const fail = () => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
// 바깥 신호에 걸린 abort 리스너 수를 센다.
function countingSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  let listeners = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, fn, o) => {
    if (type === "abort") listeners += 1;
    return add(type, fn, o);
  };
  signal.removeEventListener = (type, fn, o) => {
    if (type === "abort") listeners -= 1;
    return remove(type, fn, o);
  };
  return { controller, signal, listeners: () => listeners };
}
// 카카오가 쓰는 read: 상태는 살리고 본문 읽기 실패는 null로.
const statusAndJson = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

test("N2 제한 시간 상수는 25초(서비스 워커가 30초 넘는 fetch 대기에서 내려가지 않게)", () => {
  assert.equal(AUTH_FETCH_LIMIT_MS, 25_000);
});

test("N2 정상 응답: init을 그대로 넘기고 신호를 붙이며, read가 돌려준 값을 돌려준다", async () => {
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  };
  const out = await fetchLimited("https://example.test/a", { method: "POST", headers: { "x-test": "1" }, body: "k=v" }, { timeoutMs: 1000 }, statusAndJson);
  assert.deepEqual(out, { status: 200, body: { ok: 1 } });
  assert.equal(seen.url, "https://example.test/a");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, "k=v");
  assert.deepEqual(seen.init.headers, { "x-test": "1" });
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.equal(seen.init.signal.aborted, false, "끝난 뒤에도 신호를 abort하지 않는다");
});

test("N2 헤더 전 시간 초과: fetch에 준 신호가 abort되고 fetch의 거부가 그대로 나온다", async () => {
  let signal;
  globalThis.fetch = (_url, init) => {
    signal = init.signal;
    return neverResponds(init.signal);
  };
  let readCalled = false;
  await assert.rejects(
    fetchLimited("https://example.test/a", {}, { timeoutMs: 20 }, async () => {
      readCalled = true;
    }),
    (err) => err.name === "AbortError",
  );
  assert.equal(signal.aborted, true);
  assert.equal(readCalled, false);
});

test("N2 헤더 뒤 본문이 멈춤: 제한 시간에 신호가 abort되고, read가 실패를 삼키면 그 값이 그대로 나온다(401 + 멈춘 본문)", async () => {
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return stalledBody(401, init.signal);
  };
  const out = await fetchLimited("https://example.test/a", {}, { timeoutMs: 20 }, statusAndJson);
  assert.deepEqual(out, { status: 401, body: null }, "이미 받은 상태 코드는 살아 있다");
  assert.equal(signal.aborted, true, "본문 읽기도 제한 안에 든다");
});

test("N2 read가 던지면 같은 예외 객체가 그대로 나온다", async () => {
  globalThis.fetch = async () => new Response("x", { status: 200 });
  const boom = new Error("read failed");
  await assert.rejects(
    fetchLimited("https://example.test/a", {}, { timeoutMs: 1000 }, async () => {
      throw boom;
    }),
    (err) => err === boom,
  );
  // 본문이 멈춘 응답을 read가 삼키지 않으면 그 읽기 실패가 나온다.
  globalThis.fetch = async (_url, init) => stalledBody(200, init.signal);
  await assert.rejects(
    fetchLimited("https://example.test/a", {}, { timeoutMs: 20 }, (res) => res.arrayBuffer()),
    (err) => err.name === "AbortError",
  );
});

test("N2 fetch가 거부하면(연결 실패) 같은 예외 객체가 그대로 나온다", async () => {
  const boom = new TypeError("Failed to fetch");
  globalThis.fetch = async () => {
    throw boom;
  };
  await assert.rejects(fetchLimited("https://example.test/a", {}, { timeoutMs: 1000 }, statusAndJson), (err) => err === boom);
});

test("N2 바깥 신호: 진행 중 끊기면 요청이 끊기고, 이미 끊긴 신호면 바로 끊긴 신호로 요청한다", async () => {
  let signal;
  globalThis.fetch = (_url, init) => {
    signal = init.signal;
    return neverResponds(init.signal);
  };
  const outer = countingSignal();
  const p = fetchLimited("https://example.test/a", {}, { timeoutMs: 60_000, signal: outer.signal }, statusAndJson);
  assert.equal(outer.listeners(), 1);
  outer.controller.abort();
  await assert.rejects(p, (err) => err.name === "AbortError");
  assert.equal(signal.aborted, true);
  assert.equal(outer.listeners(), 0, "끝나면 바깥 신호의 리스너를 뗀다");

  const dead = new AbortController();
  dead.abort();
  await assert.rejects(fetchLimited("https://example.test/a", {}, { timeoutMs: 60_000, signal: dead.signal }, statusAndJson), (err) => err.name === "AbortError");
  assert.equal(signal.aborted, true);
});

test("N2 끝나면 타이머와 리스너를 정리한다: 성공·fetch 거부·read 실패 모두", async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSet(fn, ms, ...rest);
    live.add(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    live.delete(id);
    return realClear(id);
  };
  try {
    const cases = [
      async () => new Response("{}", { status: 200 }),
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const f of cases) {
      const outer = countingSignal();
      globalThis.fetch = f;
      await fetchLimited("https://example.test/a", {}, { timeoutMs: 60_000, signal: outer.signal }, statusAndJson).catch(() => {});
      assert.equal(live.size, 0, "타이머가 남지 않는다");
      assert.equal(outer.listeners(), 0, "리스너가 남지 않는다");
    }
    const outer = countingSignal();
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    await fetchLimited("https://example.test/a", {}, { timeoutMs: 60_000, signal: outer.signal }, async () => {
      throw new Error("read failed");
    }).catch(() => {});
    assert.equal(live.size, 0);
    assert.equal(outer.listeners(), 0);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
