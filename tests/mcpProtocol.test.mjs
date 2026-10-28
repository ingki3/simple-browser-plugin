// MCP 다리(#140): 확장 쪽 프로토콜(src/lib/mcpProtocol.ts)과 다리(mcp/sbp-mcp.mjs)의 계산이 서로 맞는지, 다리의 JSON-RPC·작업 처리.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ext from "../src/lib/mcpProtocol.ts";
import * as br from "../mcp/sbp-mcp.mjs";

const secret = ext.newSecret();

test("키·서명·봉인을 두 구현이 서로 맞춰 쓴다", async () => {
  const ke = await ext.deriveKeys(secret);
  const kb = await br.deriveKeys(secret);
  const header = ext.makeHeader(Date.now());
  const mac = await ext.signRequest(ke, "GET", "/v1/next", header);
  assert.ok(await br.verifyRequest(kb, "GET", "/v1/next", header, mac));
  assert.ok(!(await br.verifyRequest(kb, "POST", "/v1/next", header, mac)), "다른 메서드");
  assert.ok(!(await br.verifyRequest(kb, "GET", "/v1/next", ext.makeHeader(Date.now()), mac)), "다른 머리");
  const aad = ext.aadOf("POST", "/v1/result", header);
  const sealed = await ext.seal(ke.extEnc, aad, { jobId: "j", text: "답" });
  assert.deepEqual(await br.open(kb.extEnc, aad, sealed), { jobId: "j", text: "답" });
  await assert.rejects(br.open(kb.extEnc, ext.aadOf("POST", "/v1/result", ext.makeHeader(1)), sealed), "다른 요청에 묶인 본문");
  await assert.rejects(br.open(kb.bridgeEnc, aad, sealed), "방향이 다른 키");
  const back = await br.seal(kb.bridgeEnc, aad, { ok: true });
  assert.deepEqual(await ext.open(ke.bridgeEnc, aad, back), { ok: true });
  const other = await ext.deriveKeys(ext.newSecret());
  await assert.rejects(ext.open(other.bridgeEnc, aad, back), "다른 비밀");
  assert.equal(ext.parseHeader("eyJ2IjoyfQ"), null);
  await assert.rejects(ext.deriveKeys("short"));
});

test("다음 작업 응답은 형태를 엄격히 본다", () => {
  assert.equal(ext.parseNext({ bridgeId: "b", version: "1" }).job, undefined);
  assert.equal(ext.parseNext({ bridgeId: "b", version: "1", job: { jobId: "j", request: "", deadline: 1 } }), null);
  assert.equal(ext.parseNext({ bridgeId: "b", version: "1", cancel: [1] }), null);
  assert.deepEqual(ext.parseNext({ bridgeId: "b", version: "1", job: { jobId: "j", request: "할 일", deadline: 5 } }).job, { jobId: "j", request: "할 일", deadline: 5 });
});

async function bridge() {
  const out = [];
  const keys = await br.deriveKeys(secret);
  const b = br.createBridge({ keys, write: (m) => out.push(m) });
  return { b, out, keys, ke: await ext.deriveKeys(secret) };
}

const call = (id, request, extra = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_task", arguments: { request, ...extra } } });

test("JSON-RPC: 초기화 전 거절, 버전 협상, 알림 무응답, 알 수 없는 메서드", async () => {
  const { b, out } = await bridge();
  b.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(out.pop().error.code, -32002);
  b.handleRpc({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const init = out.pop().result;
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.ok(init.capabilities.tools && init.serverInfo.name);
  b.handleRpc({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(out.pop().result.protocolVersion, br.SUPPORTED_MCP_VERSIONS[0]);
  b.handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(out.length, 0);
  b.handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.equal(out.pop().result.tools[0].name, "browser_task");
  b.handleRpc({ jsonrpc: "2.0", id: 5, method: "nope" });
  assert.equal(out.pop().error.code, -32601);
  b.handleRpc({ jsonrpc: "2.0", id: 6, method: "ping" });
  assert.deepEqual(out.pop().result, {});
  b.handleRpc(call(7, ""));
  assert.equal(out.pop().error.code, -32602);
  b.handleRpc(call(8, "x", { other: 1 }));
  assert.equal(out.pop().error.code, -32602);
});

async function nextOf(h, b, ke, signal) {
  const header = ext.makeHeader(Date.now());
  const mac = await ext.signRequest(ke, "GET", "/v1/next", header);
  const auth = await b.authenticate("GET", "/v1/next", header, mac);
  assert.ok(auth);
  const body = await b.next(auth, signal);
  return ext.parseNext(await ext.open(ke.bridgeEnc, ext.aadOf("GET", "/v1/next", header), body));
}

async function resultOf(b, ke, value) {
  const header = ext.makeHeader(Date.now());
  const mac = await ext.signRequest(ke, "POST", "/v1/result", header);
  const auth = await b.authenticate("POST", "/v1/result", header, mac);
  assert.ok(auth);
  return b.result(auth, await ext.seal(ke.extEnc, ext.aadOf("POST", "/v1/result", header), value));
}

test("작업: 가져가기 → 결과 한 번, 진행 중 두 번째 호출은 busy, 늦은 결과는 무시", async () => {
  const { b, out, ke } = await bridge();
  b.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  out.length = 0;
  b.handleRpc(call(10, "날씨 알려 줘"));
  b.handleRpc(call(11, "또"));
  assert.ok(out.pop().result.isError, "busy");
  const n = await nextOf(null, b, ke);
  assert.equal(n.job.request, "날씨 알려 줘");
  await resultOf(b, ke, { jobId: n.job.jobId, outcome: "ok", text: "맑음" });
  const done = out.pop();
  assert.equal(done.id, 10);
  assert.deepEqual(done.result.content, [{ type: "text", text: "맑음" }]);
  await resultOf(b, ke, { jobId: n.job.jobId, outcome: "ok", text: "다시" });
  assert.equal(out.length, 0, "같은 작업의 두 번째 결과는 무시");
});

test("취소: 클라이언트 취소는 확장에 알리고 응답하지 않는다, 인증 실패·재사용 nonce 거절", async () => {
  const { b, out, ke } = await bridge();
  b.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  out.length = 0;
  b.handleRpc(call(20, "오래 걸리는 일"));
  const n = await nextOf(null, b, ke);
  b.handleRpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 20 } });
  assert.equal(out.length, 0);
  const c = await nextOf(null, b, ke);
  assert.deepEqual(c.cancel, [n.job.jobId]);
  await resultOf(b, ke, { jobId: n.job.jobId, outcome: "cancelled", text: "" });
  assert.equal(out.length, 0, "취소한 작업의 결과는 응답하지 않음");
  assert.deepEqual(b.state().cancels, [], "취소 확인 뒤 목록에서 지움");

  const header = ext.makeHeader(Date.now());
  const mac = await ext.signRequest(ke, "GET", "/v1/next", header);
  assert.ok(await b.authenticate("GET", "/v1/next", header, mac));
  assert.equal(await b.authenticate("GET", "/v1/next", header, mac), null, "nonce 재사용");
  const wrong = await ext.deriveKeys(ext.newSecret());
  const h2 = ext.makeHeader(Date.now());
  assert.equal(await b.authenticate("GET", "/v1/next", h2, await ext.signRequest(wrong, "GET", "/v1/next", h2)), null, "다른 비밀");
  const old = ext.makeHeader(Date.now() - 5 * 60_000);
  assert.equal(await b.authenticate("GET", "/v1/next", old, await ext.signRequest(ke, "GET", "/v1/next", old)), null, "오래된 시각");
});

test("줄 읽기: 여러 줄·갈린 UTF-8·너무 긴 줄", () => {
  const lines = [];
  let over = 0;
  const feed = br.lineReader((l) => lines.push(l), () => over++);
  const bytes = Buffer.from('{"a":"가"}\n{"b":1}\n', "utf8");
  feed(bytes.subarray(0, 7));
  feed(bytes.subarray(7));
  assert.deepEqual(lines, ['{"a":"가"}', '{"b":1}']);
  feed(Buffer.alloc(1024 * 1024 + 10, 0x61));
  assert.equal(over, 1);
});

test("받았다는 확인이 없으면 같은 작업을 다시 보내고, 확인 뒤에는 보내지 않는다, 취소 중에는 슬롯을 붙잡는다", async () => {
  let t = 1_000_000;
  const out = [];
  const keys = await br.deriveKeys(secret);
  const ke = await ext.deriveKeys(secret);
  const b = br.createBridge({ keys, write: (m) => out.push(m), now: () => t });
  b.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  b.handleRpc(call(30, "할 일"));
  const sign = async (method, path) => {
    const header = ext.makeHeader(t);
    return { header, auth: await b.authenticate(method, path, header, await ext.signRequest(ke, method, path, header)) };
  };
  const next = async () => {
    const { header, auth } = await sign("GET", "/v1/next");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const body = await b.next(auth, ac.signal);
    return body ? ext.parseNext(await ext.open(ke.bridgeEnc, ext.aadOf("GET", "/v1/next", header), body)) : null;
  };
  const post = async (value) => {
    const { header, auth } = await sign("POST", "/v1/result");
    return b.result(auth, await ext.seal(ke.extEnc, ext.aadOf("POST", "/v1/result", header), value));
  };
  const first = await next();
  assert.ok(first.job);
  t += 6_000;
  const again = await next();
  assert.equal(again?.job?.jobId, first.job.jobId, "확인이 없으면 다시 보냄");
  await post({ jobId: first.job.jobId, outcome: "accepted", text: "" });
  t += 6_000;
  assert.equal((await next())?.job, undefined, "확인 뒤에는 다시 보내지 않음");
  b.handleRpc({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 30 } });
  out.length = 0;
  b.handleRpc(call(31, "다음 일"));
  assert.ok(out.pop().result.isError, "취소 확인 전에는 busy");
  await post({ jobId: first.job.jobId, outcome: "cancelled", text: "" });
  b.handleRpc(call(32, "다음 일"));
  assert.equal(out.length, 0, "확인 뒤에는 새 작업을 받음");
  b.shutdown();
});

test("도구 이름이 글자가 아니면 오류로 답하고 죽지 않는다", async () => {
  const { b, out } = await bridge();
  b.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  b.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: { toString: null }, arguments: {} } });
  assert.equal(out.pop().error.code, -32602);
});

