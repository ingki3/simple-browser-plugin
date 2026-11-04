// 로컬·호환 서버 제공자(#193): 주소 검사, 요청 본문, 거부 재시도와 기억, 리다이렉트 거절, 오류 가림, 생각 분리, 도구 호출 번호, 설정.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localAdapter,
  localEndpoint,
  localError,
  localPayload,
  localStreamMapper,
  localToolIndexer,
  listLocalModels,
  privateHost,
  resetLocalMemory,
  scrubLocal,
  stripThink,
  LOCAL_CONNECT_ERROR,
} from "../src/lib/providers/local.ts";
import { ProviderHttpError } from "../src/lib/openrouter.ts";
import { activeModel, mergeSettingsPatch, normalizeSettings, targetKey } from "../src/lib/settings.ts";
import { providerTimeout } from "../src/lib/providers/index.ts";
import { friendlyError, MissingKeyError } from "../src/lib/friendlyError.ts";

test("localEndpoint: http는 이 컴퓨터·내부망만, 그 밖은 https, 사용자 정보·쿼리 거부, 끝 / 제거", () => {
  for (const ok of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1/", "http://10.0.0.5:8000/v1", "http://172.20.1.1/v1", "http://192.168.0.9:8080", "http://[::1]:8080/v1", "http://[fd00::1]/v1", "http://ollama.localhost/v1", "https://llm.example.com/v1"]) {
    assert.ok(localEndpoint(ok).ok, ok);
  }
  assert.equal(localEndpoint("http://127.0.0.1:1234/v1/").base, "http://127.0.0.1:1234/v1");
  for (const bad of ["", "   ", "ftp://localhost/v1", "http://example.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://[2001:db8::1]/v1", "http://u:p@localhost/v1", "http://localhost/v1?x=1", "http://localhost/v1#a", "not a url"]) {
    assert.equal(localEndpoint(bad).ok, false, bad);
  }
  assert.equal(privateHost("192.168.1.1"), true);
  // fc00::/7만(앞자리 0을 생략한 fc::1·fd1::1은 대역 밖).
  for (const h of ["[fc00::1]", "[fd12:3456::1]", "[fdff::1]"]) assert.equal(privateHost(h), true, h);
  for (const h of ["[fc::1]", "[fd1::1]", "[fe80::1]", "[2001:db8::1]", "[::ffff:7f00:1]"]) assert.equal(privateHost(h), false, h);
  assert.equal(privateHost("169.254.1.1"), false);
});

const msgs = [{ role: "system", content: "s" }, { role: "user", content: [{ type: "text", text: "q" }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AAAA" } }] }];
const tools = [{ type: "function", function: { name: "describe_page", parameters: {} } }];

test("localPayload: max_tokens, 선택 필드(stream_options·response_format)만 빼거나 넣고, 모를 수 있는 필드는 보내지 않음", () => {
  const b = localPayload({ model: "qwen3", messages: msgs, tools, toolChoice: "auto", parallelToolCalls: false, reasoning: "agent", maxTokens: 512, temperature: 0, responseFormat: { type: "json_object" } }, true);
  assert.equal(b.max_tokens, 512);
  assert.deepEqual(b.stream_options, { include_usage: true });
  assert.deepEqual(b.response_format, { type: "json_object" });
  for (const k of ["parallel_tool_calls", "reasoning_effort", "reasoning", "max_completion_tokens"]) assert.ok(!(k in b), k);
  assert.ok(!JSON.stringify(b).includes("base64"), "파일 조각은 안내 글자로");
  // 마무리 요청(toolChoice none)은 도구 목록·tool_choice를 보내지 않는다(tool_choice를 모르는 서버에서도 도구를 못 고르게).
  const wrap = localPayload({ model: "m", messages: msgs, tools, toolChoice: "none", maxTokens: 1, reasoning: "agent_low" }, true);
  assert.ok(!("tools" in wrap) && !("tool_choice" in wrap));
  const d = localPayload({ model: "m", messages: msgs, maxTokens: 1, reasoning: "off", responseFormat: { type: "json_object" } }, true, new Set(["stream_options", "response_format"]));
  assert.ok(!("stream_options" in d) && !("response_format" in d) && d.stream === true);
});

function fakeFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}
const realFetch = globalThis.fetch;
const auth = { apiKey: "", baseUrl: "http://localhost:11434/v1" };
const req = { model: "qwen3", messages: [{ role: "user", content: "q" }], maxTokens: 10, reasoning: "off", responseFormat: { type: "json_object" } };
const okBody = { choices: [{ message: { content: "{\"a\":1}" } }] };

test("거부(400)면 선택 필드를 빼고 한 번만 다시, 성공했을 때만 (주소, 모델)별로 기억", async () => {
  resetLocalMemory();
  try {
    let calls = fakeFetch([{ status: 400, body: { error: { message: "unknown field" } } }, { body: okBody }, { body: okBody }, { body: okBody }]);
    assert.equal(await localAdapter.complete(auth, req), "{\"a\":1}");
    assert.ok("response_format" in calls[0].body && !("response_format" in calls[1].body), "다시 보낼 때 뺌");
    await localAdapter.complete(auth, req);
    assert.ok(!("response_format" in calls[2].body), "같은 (주소, 모델)은 기억해 처음부터 뺌");
    await localAdapter.complete(auth, { ...req, model: "other" });
    assert.ok("response_format" in calls[3].body, "다른 모델에는 그대로");
    // 다시 보낸 것도 실패하면 기억하지 않는다.
    resetLocalMemory();
    calls = fakeFetch([{ status: 400, body: {} }, { status: 400, body: {} }, { body: okBody }]);
    await assert.rejects(localAdapter.complete(auth, req));
    await localAdapter.complete(auth, req);
    assert.ok("response_format" in calls[2].body, "실패한 재시도는 기억 안 함");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("재시도 전에 멈췄으면 다시 보내지 않는다, 리다이렉트는 따르지 않는다, 키가 없으면 Authorization 없음", async () => {
  resetLocalMemory();
  try {
    const ctl = new AbortController();
    const calls = fakeFetch([{ status: 400, body: {} }, { body: okBody }]);
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (u, i) => {
      const r = await origFetch(u, i);
      ctl.abort();
      return r;
    };
    await assert.rejects(localAdapter.complete(auth, req, ctl.signal));
    assert.equal(calls.length, 1, "두 번째 요청 없음");
    const c2 = fakeFetch([{ body: okBody }, { body: { data: [{ id: "a" }, { id: "b" }, { id: "a" }, { x: 1 }] } }]);
    await localAdapter.complete({ apiKey: "", baseUrl: "http://localhost:11434/v1" }, { ...req, responseFormat: undefined });
    assert.equal(c2[0].init.redirect, "error");
    assert.ok(!("Authorization" in c2[0].init.headers), "키 없으면 머리글 없음");
    assert.deepEqual(await listLocalModels({ apiKey: "k", baseUrl: "http://localhost:11434/v1/" }), ["a", "b"]);
    assert.equal(c2[1].url, "http://localhost:11434/v1/models");
    assert.equal(c2[1].init.redirect, "error");
    assert.equal(c2[1].init.headers.Authorization, "Bearer k");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("오류 가림: 짧은 키도, 서버 주소도 가리고 300자로 자름", () => {
  const a = { apiKey: "abc", baseUrl: "http://10.0.0.5:8000/v1/" };
  const out = scrubLocal("bad abc at http://10.0.0.5:8000/v1/chat and http://10.0.0.5:8000/v1 abc", a, "http://10.0.0.5:8000/v1");
  assert.ok(!out.includes("abc") && !out.includes("10.0.0.5"), out);
  assert.ok(scrubLocal("x".repeat(500), a).length <= 301);
});

test("localError: 403은 Ollama 허용 출처 안내, 도구를 보낸 400은 도구 지원 안내, 연결 실패는 중립 안내(종류는 유지)", () => {
  const base = "http://localhost:11434/v1";
  const e403 = localError(new ProviderHttpError("forbidden", 403), auth, base, true);
  assert.ok(e403 instanceof ProviderHttpError && e403.status === 403 && e403.message.includes("OLLAMA_ORIGINS"));
  const e400 = localError(new ProviderHttpError("model does not support tools", 400), auth, base, true);
  assert.ok(e400.message.includes("도구 호출(tools)") && e400.message.includes("does not support tools"));
  assert.equal(localError(new ProviderHttpError("bad", 400), auth, base, false).message, "bad");
  const net = localError(new TypeError("Failed to fetch"), auth, base, true);
  assert.ok(!(net instanceof TypeError) && net.message.startsWith(LOCAL_CONNECT_ERROR));
  const abort = new DOMException("aborted", "AbortError");
  assert.equal(localError(abort, auth, base, true), abort);
});

const run = (parts, finish = "stop") => {
  const m = localStreamMapper();
  const out = [...parts.map((p) => ({ choices: [{ delta: typeof p === "string" ? { content: p } : p }] })), { choices: [{ delta: {}, finish_reason: finish }] }].flatMap((c) => m.map(c));
  return { out: [...out, ...m.flush()], text: () => out.concat(m.flush()).map((c) => c.choices?.[0]?.delta?.content ?? "").join(""), thought: () => out.map((c) => c.choices?.[0]?.delta?.reasoning ?? "").join("") };
};
const join = (chunks, key) => chunks.map((c) => c.choices?.[0]?.delta?.[key] ?? "").join("");

test("스트림: reasoning_content는 생각으로, 맨 앞 <think>…</think>는 갈라져 와도 생각으로, 중간의 <think>는 답 그대로", () => {
  let r = run([{ reasoning_content: "음" }, "답"]);
  assert.equal(join(r.out, "reasoning"), "음");
  assert.equal(join(r.out, "content"), "답");
  r = run(["  <th", "ink>생각", "중</thi", "nk>\n\n최종", " 답"]);
  assert.equal(join(r.out, "reasoning"), "생각중");
  assert.equal(join(r.out, "content"), "최종 답");
  r = run(["앞 <think>x</think>"]);
  assert.equal(join(r.out, "content"), "앞 <think>x</think>");
  assert.equal(join(r.out, "reasoning"), "");
});

test("스트림 끝 처리: 짧은 답·미완성 시작 태그는 답으로, 닫히지 않은 생각은 생각으로(flush)", () => {
  assert.equal(join(run(["네"]).out, "content"), "네");
  assert.equal(join(run(["<thi"]).out, "content"), "<thi");
  const r = run(["<think>끝나지 않은 생각"]);
  assert.equal(join(r.out, "reasoning"), "끝나지 않은 생각");
  assert.equal(join(r.out, "content"), "");
  // finish_reason 없이 끝나도(EOF) flush가 남은 것을 낸다.
  const m = localStreamMapper();
  const a = m.map({ choices: [{ delta: { content: "응" } }] });
  assert.equal(join([...a, ...m.flush()], "content"), "응");
  // usage만 있는 조각(choices 빈 것)은 그대로.
  const u = { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } };
  assert.deepEqual(localStreamMapper().map(u), [u]);
});

test("도구 호출 번호: 인덱스 없이 id·이름·인자가 따로 와도 한 호출, 새 id가 오면 다음 호출", () => {
  const ix = localToolIndexer();
  const seq = [[{ id: "a" }], [{ function: { name: "describe_" } }], [{ function: { name: "page", arguments: "{}" } }], [{ id: "b", function: { name: "x" } }], [{ function: { arguments: "{}" } }]];
  assert.deepEqual(seq.map((c) => ix(c)[0].index), [0, 0, 0, 1, 1]);
  const ix2 = localToolIndexer();
  assert.deepEqual([[{ index: 3, id: "z" }], [{ function: { arguments: "{" } }]].map((c) => ix2(c)[0].index), [3, 3]);
});

test("stripThink: 비스트림 답의 맨 앞 생각을 뗀다(생각 속 JSON이 아닌 본문 JSON)", () => {
  assert.equal(stripThink('<think>{"verdict":"met"}</think>\n{"verdict":"unmet"}'), '{"verdict":"unmet"}');
  assert.equal(stripThink("<think>끝나지 않음"), "");
  assert.equal(stripThink('{"a":1}'), '{"a":1}');
});

test("설정: local 주소·모델·키(선택), ready·missing, 대상 식별은 주소가 다르면 다름, 하위 필드 합치기", () => {
  const s = normalizeSettings({ provider: "local", localServer: { baseUrl: "http://localhost:11434/v1/", model: " qwen3 " } });
  assert.deepEqual(activeModel(s), { provider: "local", apiKey: "", model: "qwen3", baseUrl: "http://localhost:11434/v1", ready: true, missing: null });
  assert.equal(activeModel(normalizeSettings({ provider: "local", localServer: { baseUrl: "http://example.com/v1", model: "m" } })).missing, "endpoint");
  assert.equal(activeModel(normalizeSettings({ provider: "local", localServer: { baseUrl: "http://localhost/v1", model: "" } })).missing, "model");
  const other = normalizeSettings({ provider: "local", localServer: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3" } });
  assert.notEqual(targetKey(activeModel(s)), targetKey(activeModel(other)));
  const merged = mergeSettingsPatch(mergeSettingsPatch(s, { localServer: { baseUrl: "http://127.0.0.1:1234/v1" } }), { localServer: { model: "llama" } });
  assert.deepEqual(merged.localServer, { baseUrl: "http://127.0.0.1:1234/v1", model: "llama" });
  assert.equal(normalizeSettings({ apiKeys: { local: " k " } }).apiKeys.local, "k");
});

test("제한 시간 배수와 준비 부족 안내", () => {
  assert.equal(providerTimeout("local", 30_000), 60_000);
  assert.equal(providerTimeout("openai", 30_000), 30_000);
  assert.match(friendlyError(new MissingKeyError("x", "endpoint")).message, /로컬 서버 주소와 모델/);
  assert.match(friendlyError(new MissingKeyError("x")).message, /API 키가 없습니다/);
});
