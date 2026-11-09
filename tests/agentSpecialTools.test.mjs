// 특수 도구·손 넘기기(#263 단계 5, 계획 R5 보조): 카드 대기(waitApproval)의 등록 순서와, 떼어낸 handOff·scheduleRepeat가
// 대기·해제를 옮기기 전 순서대로 부르는지. 주 시험은 하네스(mcp·telegram의 "원격 요청이 직접 조작할 사이트에서 클릭하면 …").
// 제품 코드에 시험 훅을 두지 않는다(tests/helpers/agentLoader.mjs가 페이지 표시·감시 함수만 대역으로 바꾼다).
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers/agentLoader.mjs";

const { ChatAgent } = await import("../src/background/agent/chatAgent.ts");
const { handOff, finishHandoff } = await import("../src/background/agent/handoffFlow.ts");
const { scheduleRepeat } = await import("../src/background/agent/specialTools.ts");
const { STALE } = await import("../src/background/agent/toolCall.ts");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  globalThis.__agentStubs = { "debug.debugLog": () => {} };
});

function remoteAgent() {
  const posted = [];
  const agent = new ChatAgent({ postMessage: (m) => posted.push(m) }, { channel: "telegram" });
  return { agent, posted };
}

const pendingCard = (callId) => ({ kind: "tool_pending", callId, toolName: "click_element", args: {}, previewSummary: "", previewDetails: "", handoff: true });

test("waitApproval: 대기 등록이 호출 안에서 동기로 끝나고, 원격 send의 거절(setTimeout 0)이 그 대기를 푼다", async () => {
  const { agent, posted } = remoteAgent();
  const deps = agent.handoffDeps;
  deps.send(pendingCard("c1"));
  assert.equal(posted.length, 0, "원격이면 카드를 보내지 않는다");
  const p = deps.waitApproval("c1");
  // 같은 동기 흐름에서 이미 등록돼 있어야 한다(거절 타이머보다 먼저).
  assert.equal(agent.pendingApprovals.has("c1"), true);
  assert.equal(agent.idle(), false, "기다리는 동안은 쉬는 대화가 아니다");
  // async로 감싸지 않은 그 Promise(부르는 쪽이 옮기기 전과 같은 차례로 깨어난다).
  assert.ok(p instanceof Promise);
  assert.equal(await p, false, "거절로 풀림");
  // 지우기는 부르는 쪽의 몫(옮기기 전 delete 자리) — 풀린 뒤에도 그 전까지는 남는다.
  assert.equal(agent.pendingApprovals.has("c1"), true);
  deps.clearApproval("c1");
  assert.equal(agent.pendingApprovals.has("c1"), false);
});

test("waitApproval 대조: 등록이 거절 타이머 뒤면 거절이 닿지 않아 대기가 풀리지 않는다(지켜야 할 순서)", async () => {
  const { agent } = remoteAgent();
  const deps = agent.handoffDeps;
  deps.send(pendingCard("c2"));
  let settled = null;
  setTimeout(() => {
    deps.waitApproval("c2").then((v) => (settled = v));
  }, 10);
  await tick(50);
  assert.equal(settled, null, "풀리지 않음");
  // 정리(뒤 시험에 새지 않게).
  agent.pendingApprovals.get("c2")?.(false);
});

test("waitApproval: 마이크로태스크 하나 늦은 등록은 거절 타이머보다 먼저라 그대로 풀린다(불변식이 매크로태스크 기준인 이유)", async () => {
  const { agent } = remoteAgent();
  const deps = agent.handoffDeps;
  deps.send(pendingCard("c3"));
  await null;
  assert.equal(await deps.waitApproval("c3"), false);
  deps.clearApproval("c3");
});

// handOff 대역: 표시·감시·팝업 감시·탭 확인. 부른 차례를 log에 남긴다.
function handoffStubs(log, { watchOutcome } = {}) {
  let onDone = null;
  Object.assign(globalThis.__agentStubs, {
    "handlers.resolveTurnTab": async () => 7,
    "popups.watchNewTabs": () => {
      log.push("watchNewTabs");
      return {
        stop: () => {
          log.push("popups.stop");
          return [];
        },
      };
    },
    "handoff.showHandoff": async () => {
      log.push("showHandoff");
      return { tabId: 7, documentId: "d", token: "t" };
    },
    "handoff.watchHandoff": (_s, done) => {
      log.push("watchHandoff");
      onDone = done;
      if (watchOutcome) queueMicrotask(() => done(watchOutcome));
      return () => log.push("stopWatch");
    },
    "handoff.endHandoff": async () => {
      log.push("endHandoff");
    },
  });
  return { fire: (o, at) => onDone?.(o, at) };
}

function fakeCall(over = {}) {
  const calls = { failed: [], records: [] };
  return {
    calls,
    call: {
      turn: 1,
      turnTab: { tabId: 7 },
      callId: "k1",
      modelCallId: "m1",
      toolName: "click_element",
      parsedArgs: { id: "c1-x" },
      argsKey: "a",
      failCall: (msg) => calls.failed.push(msg),
      record: (...a) => calls.records.push(a),
      ...over,
    },
  };
}

// ChatAgent의 대기 목록을 흉내 내는 deps(등록·해제·풀기 차례를 log에).
function fakeDeps(log, { remote = false, stale = () => false } = {}) {
  const pending = new Map();
  return {
    pending,
    deps: {
      isStale: (t) => stale(t),
      send: (msg) => {
        log.push(`send:${msg.kind}`);
        if (remote && msg.kind === "tool_pending") setTimeout(() => pending.get(msg.callId)?.(false), 0);
      },
      toolContent: (_tab, payload) => JSON.stringify(payload),
      pushHistory: (m) => log.push(`history:${m.content}`),
      waitApproval: (id) =>
        new Promise((resolve) => {
          log.push("set");
          pending.set(id, (v) => {
            log.push(`resolve:${v}`);
            resolve(v);
          });
        }),
      clearApproval: (id) => {
        log.push("delete");
        pending.delete(id);
      },
      resolveApproval: (id, v) => pending.get(id)?.(v),
      cancelCall: () => log.push("cancelCall"),
      turnRequest: () => "요청 글",
      externalContent: () => false,
      rememberUrl: () => {},
    },
  };
}

test("handOff(원격 거절): 팝업 감시 → 표시 → 카드(거절 예약) → 대기 등록 → 거절 → 감시 멈춤 → 대기 지움 → 표시 해제 → 팝업 감시 멈춤 → cancelled", async () => {
  const log = [];
  handoffStubs(log);
  const { deps } = fakeDeps(log, { remote: true });
  const { call } = fakeCall();
  const res = await handOff(call, { details: "" }, null, null, deps);
  assert.deepEqual(res, { kind: "cancelled" });
  assert.deepEqual(log, ["watchNewTabs", "showHandoff", "send:tool_pending", "watchHandoff", "set", "resolve:false", "stopWatch", "delete", "endHandoff", "popups.stop"]);
});

test("handOff(중단): 대기 중 stale이면 감시·대기·표시·팝업 감시를 거두고 STALE, 기록·결과를 남기지 않는다", async () => {
  const log = [];
  handoffStubs(log);
  let stale = false;
  const { deps, pending } = fakeDeps(log, { stale: () => stale });
  const { call, calls } = fakeCall();
  const p = handOff(call, { details: "" }, null, null, deps);
  await tick();
  stale = true;
  pending.get("k1")(false);
  assert.equal(await p, STALE);
  assert.deepEqual(log, ["watchNewTabs", "showHandoff", "send:tool_pending", "watchHandoff", "set", "resolve:false", "stopWatch", "delete", "endHandoff", "popups.stop"]);
  assert.deepEqual(calls.failed, []);
  assert.deepEqual(calls.records, []);
});

test("handOff(사용자가 누름): 감시가 대기를 풀고, 누른 결과면 팝업 감시를 남겨 finishHandoff가 쓴다", async () => {
  const log = [];
  const stub = handoffStubs(log);
  const { deps } = fakeDeps(log);
  const { call, calls } = fakeCall();
  const p = handOff(call, { details: "" }, null, null, deps);
  await tick();
  stub.fire("clicked", 1234);
  const res = await p;
  assert.equal(res.kind, "handoff");
  assert.equal(res.outcome, "clicked");
  assert.equal(res.clickedAt, 1234);
  assert.ok(res.popups, "팝업 감시를 넘김");
  assert.deepEqual(log, ["watchNewTabs", "showHandoff", "send:tool_pending", "watchHandoff", "set", "resolve:true", "stopWatch", "delete", "endHandoff"]);
  // 결과 남기기(팝업 따라가기는 settle이 하므로 여기서는 창 없음 — 대역 stop이 빈 목록).
  log.length = 0;
  const ok = await finishHandoff(call, { ...res, popups: null }, deps);
  assert.equal(ok, true);
  assert.equal(log[0], "send:tool_result");
  assert.ok(log[1].startsWith("history:") && log[1].includes('"handedOff":true'));
  assert.equal(calls.records[0][3], "handoff:clicked");
});

test("scheduleRepeat: 실행 방식과 무관하게 늘 카드로 묻는다 — 거절이면 저장하지 않고 취소, 승인이면 그때 저장", async () => {
  const saved = [];
  globalThis.__agentStubs["storage.getSettings"] = async () => ({ provider: "openrouter", openRouterApiKey: "k", model: "m", runMode: "auto", apiKeys: {}, providerModels: {}, localServer: {} });
  globalThis.__agentStubs["repeatTasks.registerRepeatTask"] = async (args, request) => {
    saved.push(request);
    return { id: "r1", title: args.title, intervalMinutes: args.intervalMinutes, endsAt: Date.now() + 3600_000, maxRuns: args.maxRuns };
  };
  const args = { title: "t", url: "https://example.com/", check: "c", then: "x", intervalMinutes: 10 };
  for (const approve of [false, true]) {
    const log = [];
    const { deps, pending } = fakeDeps(log);
    const sent = [];
    const send = deps.send;
    deps.send = (m) => {
      sent.push(m);
      send(m);
    };
    const { call, calls } = fakeCall({ toolName: "schedule_repeat_task", parsedArgs: args, callId: `r-${approve}` });
    const p = scheduleRepeat(call, deps);
    await tick();
    assert.deepEqual(log, ["send:tool_pending", "set"], "카드를 보내고 기다린다");
    // 카드 안내(#284): 회차당 호출 수와 확인 작전(첫 확인 때 만들고, 설정에서 보고 지울 수 있음).
    const details = sent[0].previewDetails;
    assert.ok(details.includes("최대 ") && details.includes("회차, 회차마다 1~2번"), details);
    assert.ok(details.includes("작전") && details.includes("그 영역 글자만 보냅니다") && details.includes("전체 화면 글자로 다시 확인") && details.includes("설정 → 반복 작업에서 보고 지울 수 있습니다"), details);
    pending.get(`r-${approve}`)(approve);
    assert.equal(await p, true);
    if (!approve) {
      assert.deepEqual(log.slice(2), ["resolve:false", "delete", "cancelCall"]);
      assert.deepEqual(saved, []);
    } else {
      assert.deepEqual(log.slice(2, 4), ["resolve:true", "delete"]);
      assert.deepEqual(saved, ["요청 글"]);
      assert.equal(calls.records[0][3], "repeat:r1");
    }
  }
});
