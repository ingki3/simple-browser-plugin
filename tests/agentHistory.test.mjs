// 대화 기록 계산(src/background/agent/history.ts, #263 단계 2). 옮기기 전 ChatAgent 메서드 본문과 같은 결과인지 고정한다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const { answerSince, closeDanglingToolCalls, confirmRebases, lastAnswerText } = await import("../src/background/agent/history.ts");

const call = (id, name = "describe_page") => ({ id, type: "function", function: { name, arguments: "{}" } });
const asst = (content, calls) => ({ role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) });
const tool = (id, name = "describe_page") => ({ role: "tool", tool_call_id: id, name, content: "{}" });
const user = (content) => ({ role: "user", content });
const interrupted = (id, name = "describe_page") => ({ role: "tool", tool_call_id: id, name, content: JSON.stringify({ error: "interrupted" }) });

test("closeDanglingToolCalls: 마지막 답에 결과 없는 호출만 '중단됨'으로 채운다", () => {
  assert.deepEqual(closeDanglingToolCalls([]), []);
  assert.deepEqual(closeDanglingToolCalls([user("a")]), []);
  // 마지막 답에 호출이 없으면 채우지 않는다(앞 답의 결과 없는 호출도 보지 않는다 — 마지막 assistant만 본다).
  assert.deepEqual(closeDanglingToolCalls([user("a"), asst("", [call("x")]), user("b"), asst("끝")]), []);
  assert.deepEqual(closeDanglingToolCalls([user("a"), asst("", [])]), []);
  const h = [user("a"), asst("", [call("c1"), call("c2", "find_clickables"), call("c3")]), tool("c1")];
  const before = JSON.stringify(h);
  assert.deepEqual(closeDanglingToolCalls(h), [interrupted("c2", "find_clickables"), interrupted("c3")]);
  assert.equal(JSON.stringify(h), before, "기록은 바꾸지 않는다(넣는 것은 ChatAgent)");
  // 모두 결과가 있으면 채울 것 없음.
  assert.deepEqual(closeDanglingToolCalls([asst("", [call("c1")]), tool("c1")]), []);
});

test("closeDanglingToolCalls: 앞 턴이 쓴 id(call_0)의 결과는 이번 호출의 답으로 세지 않는다(#221)", () => {
  const h = [user("a"), asst("", [call("call_0")]), tool("call_0"), asst("앞 답"), user("b"), asst("", [call("call_0"), call("call_1")])];
  assert.deepEqual(closeDanglingToolCalls(h), [interrupted("call_0"), interrupted("call_1")]);
  // 호출 블록 뒤의 결과만 센다.
  assert.deepEqual(closeDanglingToolCalls([...h, tool("call_1")]), [interrupted("call_0")]);
});

test("answerSince: start 뒤에서 도구 호출 없는 마지막 답, 사용자 글에서 멈춘다", () => {
  const h = [user("q1"), asst("앞 턴 답"), user("q2"), asst("생각", [call("c")]), tool("c"), asst("이번 답"), asst("", [call("d")]), tool("d")];
  assert.equal(answerSince(h, 2), "이번 답", "도구 호출이 있는 답은 건너뛴다");
  assert.equal(answerSince(h, 5), "", "start 자신은 보지 않는다(i > start)");
  // 사용자 글을 만나면 그 앞(앞 턴)의 답은 보지 않는다.
  assert.equal(answerSince([user("q1"), asst("앞 답"), user("q2"), asst("", [call("c")]), tool("c")], 0), "");
  // 빈 글·공백·문자열이 아닌 내용은 답으로 보지 않는다.
  assert.equal(answerSince([user("q"), asst("진짜"), asst("   "), asst([{ type: "text", text: "x" }])], 0), "진짜");
});

test("lastAnswerText: 기록 전체에서 글이 있는 마지막 assistant(도구 호출 여부는 보지 않는다)", () => {
  assert.equal(lastAnswerText([]), "");
  assert.equal(lastAnswerText([user("q"), asst("하나"), user("q2"), asst("생각 글", [call("c")]), tool("c"), asst(" ")]), "생각 글");
  assert.equal(lastAnswerText([asst("앞"), user("뒤")]), "앞", "사용자 글에서 멈추지 않는다");
  assert.equal(lastAnswerText([asst([{ type: "text", text: "x" }])]), "");
});

const offer = (id, nonce) => ({ id, nonce });

test("confirmRebases: pending에서 보낸 것만 빼 새 배열로 돌려주고, confirmed는 같은 Map을 고친다", () => {
  const a = offer("c1", "n1");
  const b = offer("c2", "n2");
  const c = offer("c3", "n3");
  const pending = [a, b, c];
  const confirmed = new Map();
  const rest = confirmRebases(pending, confirmed, [a, c]);
  assert.deepEqual(rest, [b]);
  assert.notEqual(rest, pending, "새 배열");
  assert.deepEqual(pending, [a, b, c], "넘긴 pending은 그대로");
  assert.deepEqual([...confirmed], [["c1", ["n1"]], ["c3", ["n3"]]]);
  // 같은 내용의 다른 객체는 pending에 없는 것으로 본다(객체 동일성으로 찾는다).
  const again = confirmRebases(rest, confirmed, [offer("c2", "n2")]);
  assert.deepEqual(again, [b]);
  assert.equal(confirmed.size, 2);
});

test("confirmRebases: 같은 nonce는 한 번만(뒤로 옮김), 대상마다 최근 8개", () => {
  const confirmed = new Map([["c1", ["n1", "n2"]]]);
  const o = offer("c1", "n1");
  confirmRebases([o], confirmed, [o]);
  assert.deepEqual(confirmed.get("c1"), ["n2", "n1"]);
  const many = Array.from({ length: 9 }, (_, i) => offer("c9", `m${i}`));
  confirmRebases(many, confirmed, many);
  assert.deepEqual(confirmed.get("c9"), ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
});

test("confirmRebases: 대상은 200개까지, 다시 확정한 대상은 최근으로(LRU)", () => {
  const confirmed = new Map();
  const first = Array.from({ length: 200 }, (_, i) => offer(`t${i}`, "n"));
  confirmRebases(first, confirmed, first);
  assert.equal(confirmed.size, 200);
  // t0을 다시 확정하면 가장 최근이 되고, 새 대상이 들어오면 가장 오래된 t1이 빠진다.
  const t0 = offer("t0", "n2");
  const fresh = offer("t200", "n");
  confirmRebases([t0, fresh], confirmed, [t0, fresh]);
  assert.equal(confirmed.size, 200);
  assert.ok(confirmed.has("t0") && confirmed.has("t200") && !confirmed.has("t1"));
  assert.deepEqual(confirmed.get("t0"), ["n", "n2"]);
  assert.deepEqual([...confirmed.keys()].slice(-2), ["t0", "t200"]);
});

test("confirmRebases: 기록을 비운 뒤(새 pending·새 Map)에는 보냈던 기준을 확정하지 않는다", () => {
  const a = offer("c1", "n1");
  const sent = [a];
  // ChatAgent.clearRebases가 요청 중에 pending·confirmed를 새로 만든 상황.
  const pending = [];
  const confirmed = new Map();
  assert.deepEqual(confirmRebases(pending, confirmed, sent), []);
  assert.equal(confirmed.size, 0);
  // 중복 객체가 pending에 둘이면 하나만 뺀다(splice 1개, 옮기기 전과 같음).
  const dup = confirmRebases([a, a], new Map(), [a]);
  assert.deepEqual(dup, [a]);
});
