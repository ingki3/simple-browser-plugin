// 요청 준비(src/background/agent/requestPrep.ts, #263 단계 4). ChatAgent를 거친 결과는 agentRequestModel.test.mjs가 본다.
// 여기서는 준비 함수의 경계를 가짜 deps로 본다: 마지막 대상 확인은 하지 않고(설정 읽기 두 번까지), 상태는 getter로 옮기기 전에
// this를 읽던 시점에 읽고, 쓰기는 콜백으로만 한다. 설정 읽기·후보·가림은 tests/helpers/agentLoader.mjs의 대역으로 바꾼다.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers/agentLoader.mjs";

const { prepareRequest } = await import("../src/background/agent/requestPrep.ts");

const CANDIDATES = '저장 링크 후보\n[{"id":"a","title":"가"}]';
let S;

beforeEach(() => {
  S = { events: [], settings: {}, settingsCalls: 0, candidates: async () => null, mask: null };
  globalThis.__agentStubs = {
    "storage.getSettings": async () => {
      const n = ++S.settingsCalls;
      S.events.push(`getSettings${n}`);
      const v = S.settings[n];
      return typeof v === "function" ? v() : { provider: "openrouter", openRouterApiKey: "k", model: "m", runMode: "auto", apiKeys: {}, providerModels: {}, localServer: {} };
    },
    "savedPagesStore.candidatesMessage": (...a) => {
      S.events.push(`candidates(${a.join(",")})`);
      return S.candidates();
    },
    "loginSecrets.maskSyncMessages": (messages) => ({ value: messages, masked: false }),
    "loginSecrets.maskMessagesForModel": async (messages) => {
      S.events.push("mask");
      return S.mask ? S.mask(messages) : { value: messages, masked: false };
    },
    "debug.debugLog": (tag) => S.events.push(`log:${tag}`),
  };
});

afterEach(() => {
  delete globalThis.__agentStubs;
});

function deps(over = {}) {
  const ev = (e) => S.events.push(e);
  const state = { stale: false, moved: false, signs: false, history: [{ role: "user", content: "질문" }], committed: null, taskApproved: false, rebase: [] };
  const d = {
    systemPrompt: "SYS",
    logCandidates: true,
    candidateTabId: 7,
    isStale: () => state.stale,
    targetMoved: () => (ev("targetMoved"), state.moved),
    stopForTarget: () => (ev("stopForTarget"), new Error("target")),
    releasePrep: () => ev("releasePrep"),
    forceNewConversation: () => ev("forceNewConversation"),
    markMasked: () => ev("markMasked"),
    signsContext: () => (ev("signs"), state.signs),
    history: () => state.history,
    committedCandidates: () => state.committed,
    effectiveRunMode: (m) => m,
    taskApproved: () => state.taskApproved,
    rebasePending: () => state.rebase,
    ...over,
  };
  return { d, state };
}

test("준비는 마지막 대상 확인을 하지 않는다 — 설정 읽기 두 번, 대상 확인 한 번, 정리 없음", async () => {
  const { d } = deps();
  const r = await prepareRequest(d);
  assert.ok(r);
  assert.deepEqual(S.events, ["candidates(7,true)", "getSettings1", "targetMoved", "signs", "signs", "getSettings2", "mask"]);
  assert.equal(r.afterToolResult, false);
  assert.equal(r.outgoing.value[0].content, "SYS");
});

test("후보 조회 뒤 새 턴에 밀리면 정리하고 null — 설정을 읽지 않는다", async () => {
  const { d, state } = deps();
  S.candidates = async () => ((state.stale = true), null);
  assert.equal(await prepareRequest(d), null);
  assert.deepEqual(S.events, ["candidates(7,true)", "releasePrep"]);
});

test("첫 설정 읽기 뒤 새 턴에 밀리면 정리하고 null — 대상 확인 전", async () => {
  const { d, state } = deps();
  S.settings[1] = () => ((state.stale = true), { provider: "openrouter", openRouterApiKey: "k", model: "m" });
  assert.equal(await prepareRequest(d), null);
  assert.deepEqual(S.events, ["candidates(7,true)", "getSettings1", "releasePrep"]);
});

test("대상이 바뀌었으면 stopForTarget의 오류를 던진다(정리는 그 콜백이 한다)", async () => {
  const { d, state } = deps();
  state.moved = true;
  await assert.rejects(prepareRequest(d), { message: "target" });
  assert.deepEqual(S.events, ["candidates(7,true)", "getSettings1", "targetMoved", "stopForTarget"]);
});

test("서명 제공자에서 보낸 후보를 지웠으면 정리 → 새 대화 표시 → 던짐 순서", async () => {
  const { d, state } = deps();
  state.signs = true;
  state.committed = { text: CANDIDATES, ids: new Set(["a"]) };
  await assert.rejects(prepareRequest(d), /거둘 수 없어 멈췄습니다/);
  assert.deepEqual(S.events.slice(-4), ["signs", "signs", "releasePrep", "forceNewConversation"]);
  assert.equal(S.settingsCalls, 1);
});

test("기록은 쓰는 시점마다 다시 읽는다: 도구 결과 판정은 맡기기 설정을 읽기 전, 보낼 기록은 그 뒤", async () => {
  const { d, state } = deps();
  state.signs = true;
  state.history = [{ role: "tool", content: "결과", tool_call_id: "c" }];
  S.settings[2] = () => {
    state.history = [...state.history, { role: "user", content: "새 기록" }];
    return { runMode: "auto" };
  };
  const r = await prepareRequest(d);
  assert.equal(r.afterToolResult, true);
  assert.deepEqual(r.sentNotes, []);
  assert.deepEqual(r.outgoing.value.map((m) => m.content), ["SYS", "결과", "새 기록"]);
});

test("마지막 가림이 가렸을 때만 표시 콜백과 로그", async () => {
  const { d } = deps();
  S.mask = (messages) => ({ value: messages, masked: true });
  await prepareRequest(d);
  assert.deepEqual(S.events.slice(-3), ["mask", "markMasked", "log:login:masked"]);
  S.events = [];
  S.mask = null;
  await prepareRequest(d);
  assert.ok(!S.events.includes("markMasked"));
});

test("실은 기준은 준비 시점의 복사본이다(그 뒤 생긴 기준은 들지 않음)", async () => {
  const { d, state } = deps();
  const a = { id: "t", nonce: "n1" };
  state.rebase = [a];
  S.mask = (messages) => {
    state.rebase.push({ id: "t", nonce: "n2" });
    return { value: messages, masked: false };
  };
  const r = await prepareRequest(d);
  assert.deepEqual(r.sentRebases, [a]);
  assert.equal(r.sentRebases[0], a);
});
