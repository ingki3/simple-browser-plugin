// ChatAgent.requestModel의 요청 준비·대상 확인·연결 경계(#263 단계 4 — 계획 R2·R3, #266 이후 동작).
// 제품 코드에 시험 훅을 두지 않고, ChatAgent를 그대로 불러와 요청 준비·연결이 쓰는 함수(설정 읽기·후보·가림·제공자·targetKey)만
// 대역으로 바꾼다(tests/helpers/agentLoader.mjs). 요청 준비를 agent/requestPrep.ts로 옮기기 전후에 같은 결과여야 한다.
//
// R2: 마지막 대상 확인(targetMoved(latest))이 끝난 뒤 openStream을 부를 때까지 기다림이 없어야 한다(#193 — 확인과 요청 사이에
// 대상이 바뀔 틈이 없다). 확인이 쓰는 동기 대역(targetKey) 안에서 마이크로태스크를 예약해, 그것이 openStream 호출보다 늦게 도는지 본다.
// R3: 준비 실패(후보 삭제·대상 바뀜)는 호출로 세지 않고(recordUsage 0회), 연결 실패만 한 번 센다. 준비 구간의 모든 끝(던짐·stale)은
// 연결 타이머를 지우고, 자기 요청일 때만 activeRequest를 비운다(#266).
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers/agentLoader.mjs";

const { ChatAgent } = await import("../src/background/agent/chatAgent.ts");
const { TARGET_CHANGED_NOTE, TASK_MODE_NOTE } = await import("../src/background/agent/prompts.ts");
// 감싸지 않은 실제 targetKey(대역 안에서 부른다).
const { targetKey: realTargetKey } = await import("../src/lib/settings.ts?real");

const TURN = 1;
const CANDIDATES = '저장 링크 후보\n[{"id":"a","title":"가"}]';
const DELETED_MSG = "저장 링크를 지우거나 꺼서 이 대화에 이미 보낸 후보를 거둘 수 없어 멈췄습니다. 다시 요청하면 새 대화로 시작합니다.";

let S; // 시험마다 새로 만드는 대역 상태
let realSetTimeout;
let realClearTimeout;

function settingsWith(model, extra = {}) {
  return { provider: "openrouter", openRouterApiKey: "k", model, runMode: "auto", apiKeys: {}, providerModels: {}, localServer: {}, ...extra };
}

beforeEach(() => {
  S = {
    connectMs: 7777,
    signs: false,
    // getSettings 호출 순번(1부터) → 설정. 없으면 기본 설정. 함수면 호출 시 실행(던지기·턴 바꾸기 등).
    settings: {},
    settingsCalls: 0,
    candidates: null,
    candidateCalls: [],
    mask: null,
    maskSync: null,
    open: null,
    opens: [],
    // 연결 타이머(지연이 connectMs인 setTimeout)의 생성·해제.
    timers: new Set(),
    cleared: new Set(),
  };
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => {
    const h = realSetTimeout(fn, ms, ...a);
    if (ms === S.connectMs) S.timers.add(h);
    return h;
  };
  globalThis.clearTimeout = (h) => {
    if (S.timers.has(h)) S.cleared.add(h);
    return realClearTimeout(h);
  };
  globalThis.__agentStubs = {
    "storage.getSettings": async () => {
      const n = ++S.settingsCalls;
      const v = S.settings[n];
      if (typeof v === "function") return v();
      return v ?? settingsWith("m");
    },
    "savedPagesStore.candidatesMessage": (tabId, log) => {
      S.candidateCalls.push([tabId, log]);
      return S.candidates ? S.candidates() : Promise.resolve(null);
    },
    "loginSecrets.maskSyncMessages": (messages) => (S.maskSync ? S.maskSync(messages) : { value: messages, masked: false }),
    "loginSecrets.maskMessagesForModel": async (messages) => (S.mask ? S.mask(messages) : { value: messages, masked: false }),
    "debug.debugLog": () => {},
    "providers.providerTimeout": (_id, ms) => (ms === 20_000 ? S.connectMs : ms),
    "providers.providerAdapter": () => ({
      label: "OpenRouter",
      signsContext: S.signs,
      openStream: (auth, req, signal) => {
        S.opens.push({ auth, req, signal });
        if (S.open) return S.open(auth, req, signal);
        return Promise.resolve({ read: async () => {} });
      },
    }),
  };
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete globalThis.__agentStubs;
});

function makeAgent() {
  const sent = [];
  const agent = new ChatAgent({ postMessage: (m) => sent.push(m) });
  Object.assign(agent, { provider: "openrouter", apiKey: "k", model: "m", currentTurn: TURN, turnTab: { tabId: 7 } });
  const usage = [];
  agent.recordUsage = (...a) => usage.push(a);
  return { agent, sent, usage };
}

const request = (agent, opts = {}) => agent.requestModel("k", "m", "SYS", TURN, opts);

// 연결 타이머가 정확히 하나 만들어졌고 지워졌는지.
function assertTimerCleared() {
  assert.equal(S.timers.size, 1, "연결 타이머 하나");
  assert.equal(S.cleared.size, 1, "연결 타이머 해제");
}

// ── R2 ───────────────────────────────────────────────────────────────

test("R2: 마지막 대상 확인과 openStream 호출 사이에 마이크로태스크가 끼지 않는다", async () => {
  const { agent } = makeAgent();
  const order = [];
  const calls = []; // targetKey 호출마다 그때까지의 getSettings 호출 수
  let atOpen = -1;
  globalThis.__agentStubs["settings.targetKey"] = (a) => {
    const id = calls.push(S.settingsCalls);
    queueMicrotask(() => order.push(`micro${id}`));
    return realTargetKey(a);
  };
  S.open = () => {
    atOpen = calls.length;
    order.push("open");
    return Promise.resolve({ read: async () => {} });
  };
  const reply = await request(agent);
  assert.ok(reply);
  assert.equal(S.opens.length, 1);
  // openStream 직전의 targetKey 호출은 마지막 대상 확인(세 번째 getSettings 뒤)의 것이다.
  assert.ok(atOpen > 0);
  assert.equal(calls[atOpen - 1], 3, "openStream 직전의 대상 확인은 마지막 설정 읽기 뒤");
  // 그 확인 안에서 예약한 마이크로태스크는 openStream을 부른 뒤에야 돈다.
  assert.ok(order.indexOf("open") < order.indexOf(`micro${atOpen}`), `순서: ${order.join(",")}`);
  assert.ok(order.indexOf("open") < order.indexOf(`micro${atOpen - 1}`), `순서: ${order.join(",")}`);
});

test("R2 대조: 마지막 확인 중 예약된 대상 변경은 요청을 연 뒤에야 닿는다(열 때는 대상이 그대로)", async () => {
  const { agent } = makeAgent();
  let n = 0;
  globalThis.__agentStubs["settings.targetKey"] = (a) => {
    // 세 번째 설정 읽기 뒤(마지막 확인)의 대역 안에서, 설정 변경 알림이 하는 일(표시·중단)을 마이크로태스크로 예약한다.
    if (S.settingsCalls === 3 && n++ === 0) {
      queueMicrotask(() => {
        agent.targetChangedTurn = agent.currentTurn;
        agent.activeRequest?.abort();
      });
    }
    return realTargetKey(a);
  };
  let atOpen;
  S.open = (_auth, _req, signal) => {
    atOpen = { changed: agent.targetChangedTurn === TURN, aborted: signal.aborted };
    return Promise.resolve({ read: async () => {} });
  };
  await assert.rejects(request(agent), { message: TARGET_CHANGED_NOTE });
  assert.equal(S.opens.length, 1);
  assert.deepEqual(atOpen, { changed: false, aborted: false });
});

// ── R3 ───────────────────────────────────────────────────────────────

test("R3①: 서명 제공자에서 기록에 보낸 후보를 지웠으면 멈추고 새 대화 표시 — 호출로 세지 않음, 타이머·activeRequest 정리", async () => {
  const { agent, usage } = makeAgent();
  S.signs = true;
  agent.committedCandidates = { text: CANDIDATES, ids: new Set(["a"]) };
  S.candidates = async () => null;
  await assert.rejects(request(agent), { message: DELETED_MSG });
  assert.equal(usage.length, 0);
  assert.equal(S.opens.length, 0);
  assertTimerCleared();
  assert.equal(agent.activeRequest, null);
  assert.equal(agent.forceNewConversation, true);
  // 대상 확인 하나만 지났다(가림·두 번째 설정 읽기 전에 멈춤).
  assert.equal(S.settingsCalls, 1);
});

test("R3②: 마지막 대상 확인에서 대상이 바뀌었으면 멈춤 — 호출로 세지 않음, 이 턴에 표시", async () => {
  const { agent, usage } = makeAgent();
  S.settings[3] = settingsWith("m2");
  await assert.rejects(request(agent), { message: TARGET_CHANGED_NOTE });
  assert.equal(usage.length, 0);
  assert.equal(S.opens.length, 0);
  assertTimerCleared();
  assert.equal(agent.activeRequest, null);
  assert.equal(agent.targetChangedTurn, TURN);
});

test("R3②′: 첫 대상 확인(후보 조회 뒤)에서 바뀌었어도 같은 방식으로 멈춘다", async () => {
  const { agent, usage } = makeAgent();
  S.settings[1] = settingsWith("m2");
  await assert.rejects(request(agent), { message: TARGET_CHANGED_NOTE });
  assert.equal(usage.length, 0);
  assert.equal(S.settingsCalls, 1);
  assertTimerCleared();
  assert.equal(agent.activeRequest, null);
  assert.equal(agent.targetChangedTurn, TURN);
});

test("R3②″: 이 턴에 이미 대상 바뀜 표시가 있으면 설정이 같아도 멈춘다", async () => {
  const { agent, usage } = makeAgent();
  agent.targetChangedTurn = TURN;
  await assert.rejects(request(agent), { message: TARGET_CHANGED_NOTE });
  assert.equal(usage.length, 0);
  assert.equal(S.opens.length, 0);
  assertTimerCleared();
});

test("R3③: 연결 실패는 한 번 센다(사용량 모름) — 원래 오류, activeRequest 정리", async () => {
  const { agent, usage } = makeAgent();
  S.open = () => Promise.reject(new Error("boom"));
  await assert.rejects(request(agent), { message: "boom" });
  assert.equal(usage.length, 1);
  assert.equal(usage[0][0], TURN);
  assert.equal(usage[0][1], null);
  assert.equal(usage[0][3], "오류");
  assertTimerCleared();
  assert.equal(agent.activeRequest, null);
});

test("R3④: 연결 시간 초과는 시간 초과 문구로 바꾸고 한 번 센다", async () => {
  const { agent, usage } = makeAgent();
  S.connectMs = 15;
  S.open = (_a, _r, signal) =>
    new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
  await assert.rejects(request(agent), { message: /^OpenRouter 연결이 0초 안에 열리지 않았습니다\./ });
  assert.equal(usage.length, 1);
  assert.equal(usage[0][1], null);
  assert.equal(usage[0][3], "오류");
  assert.equal(agent.activeRequest, null);
});

test("R3⑤: 연결 중 대상 바뀜 표시가 되면 TARGET_CHANGED_NOTE — 한 번 센다", async () => {
  const { agent, usage } = makeAgent();
  S.open = (_a, _r, signal) => {
    agent.targetChangedTurn = TURN;
    agent.activeRequest?.abort();
    return signal.aborted ? Promise.reject(new Error("aborted")) : Promise.reject(new Error("unexpected"));
  };
  await assert.rejects(request(agent), { message: TARGET_CHANGED_NOTE });
  assert.equal(usage.length, 1);
  assert.equal(usage[0][3], "오류");
  assert.equal(agent.activeRequest, null);
});

test("R3⑤′: 연결 중 새 턴에 밀렸으면 null — 한 번 센다(중단)", async () => {
  const { agent, usage } = makeAgent();
  S.open = () => {
    agent.currentTurn += 1;
    return Promise.reject(new Error("aborted"));
  };
  assert.equal(await request(agent), null);
  assert.equal(usage.length, 1);
  assert.equal(usage[0][3], "중단");
});

for (const where of ["후보 조회 뒤", "첫 설정 읽기 뒤", "마지막 설정 읽기 뒤"]) {
  test(`R3⑥: 준비 중(${where}) 새 턴에 밀리면 null — 타이머 해제, activeRequest 정리(#266), 세지 않음`, async () => {
    const { agent, usage } = makeAgent();
    const bump = () => {
      agent.currentTurn += 1;
    };
    if (where === "후보 조회 뒤") S.candidates = async () => (bump(), null);
    if (where === "첫 설정 읽기 뒤") S.settings[1] = () => (bump(), settingsWith("m"));
    if (where === "마지막 설정 읽기 뒤") S.settings[3] = () => (bump(), settingsWith("m"));
    assert.equal(await request(agent), null);
    assert.equal(usage.length, 0);
    assert.equal(S.opens.length, 0);
    assertTimerCleared();
    assert.equal(agent.activeRequest, null);
  });
}

test("R3⑥′: stale로 끝난 옛 요청은 새 요청의 activeRequest를 지우지 않는다(소유 확인)", async () => {
  const { agent } = makeAgent();
  const other = new AbortController();
  S.settings[3] = () => {
    agent.currentTurn += 1;
    agent.activeRequest = other;
    return settingsWith("m");
  };
  assert.equal(await request(agent), null);
  assertTimerCleared();
  assert.equal(agent.activeRequest, other);
  assert.equal(other.signal.aborted, false);
});

test("R3⑦: 마지막 가림이 던지면 그대로 던지고 타이머·activeRequest를 정리한다(#266) — 세지 않음", async () => {
  const { agent, usage } = makeAgent();
  S.mask = () => {
    throw new Error("mask failed");
  };
  await assert.rejects(request(agent), { message: "mask failed" });
  assert.equal(usage.length, 0);
  assert.equal(S.opens.length, 0);
  assertTimerCleared();
  assert.equal(agent.activeRequest, null);
});

test("R3⑦′: 준비 중 설정 읽기가 던져도 같은 방식으로 정리한다", async () => {
  for (const n of [1, 2, 3]) {
    S.settingsCalls = 0;
    S.timers.clear();
    S.cleared.clear();
    const { agent, usage } = makeAgent();
    S.settings = {
      [n]: () => {
        throw new Error(`settings ${n}`);
      },
    };
    await assert.rejects(request(agent), { message: `settings ${n}` });
    assert.equal(usage.length, 0);
    assertTimerCleared();
    assert.equal(agent.activeRequest, null);
  }
});

// ── 준비 규칙(후보·안내·가림) ─────────────────────────────────────────

const contents = (msgs) => msgs.map((m) => `${m.role}:${typeof m.content === "string" ? m.content.slice(0, 20) : "[parts]"}`);

test("준비: 사용자 요청 직후 요청은 현재 시각·후보 안내를 붙이고, 마지막 가림을 거친 글을 보낸다", async () => {
  const { agent } = makeAgent();
  agent.history = [{ role: "user", content: "질문" }];
  S.candidates = async () => CANDIDATES;
  const masked = [];
  S.maskSync = (messages) => ({ value: messages.map((m) => ({ ...m, content: `[s]${m.content}` })), masked: false });
  S.mask = (messages) => {
    masked.push(messages);
    return { value: messages.map((m) => ({ ...m, content: `[f]${m.content}` })), masked: true };
  };
  const reply = await request(agent);
  assert.equal(masked.length, 1);
  const sent = S.opens[0].req.messages;
  assert.deepEqual(contents(sent).map((c) => c.slice(0, 8)), ["system:[", "user:[f]", "user:[f]", "user:[f]"]);
  assert.equal(sent[0].content, "[f]SYS");
  assert.equal(sent[1].content, "[f]질문");
  assert.match(sent[2].content, /^\[f\]\[s\]\[확장 안내 — 사용자 글 아님\] 현재 시각/);
  assert.equal(sent[3].content, `[f][s]${CANDIDATES}`);
  // 기록에 남길 안내는 가린 값(sync 가림 뒤)이고, 후보 글자는 가리기 전 값이다.
  assert.equal(reply.sentNotes.length, 2);
  assert.match(reply.sentNotes[0].content, /^\[s\]\[확장 안내/);
  assert.equal(reply.sentCandidates, CANDIDATES);
  assert.equal(agent.secretsMasked, true);
  assert.equal(S.opens[0].req.toolChoice, "auto");
  assert.equal(S.opens[0].req.reasoning, "agent");
  assert.deepEqual(S.opens[0].auth, { apiKey: "k" });
  // 후보 조회는 턴 탭으로, 턴의 첫 요청에서만 로그.
  assert.deepEqual(S.candidateCalls, [[7, true]]);
  await request(agent);
  assert.deepEqual(S.candidateCalls, [[7, true], [7, false]]);
});

test("준비: 마무리 요청은 후보를 싣지 않고 마무리 안내를 붙이며 도구를 부르지 못하게 한다", async () => {
  const { agent } = makeAgent();
  S.candidates = async () => CANDIDATES;
  const reply = await request(agent, { wrapUpNote: "마무리", lowReasoning: true });
  const sent = S.opens[0].req.messages;
  assert.deepEqual(sent.map((m) => m.content).slice(2), ["마무리"]);
  assert.equal(reply.sentCandidates, null);
  assert.equal(S.opens[0].req.toolChoice, "none");
  assert.equal(S.opens[0].req.reasoning, "agent_low");
  // 마무리 요청에도 후보는 조회한다(지운 후보 검사용).
  assert.equal(S.candidateCalls.length, 1);
});

test("준비: 맡기기 방식이면 맡기기 안내를 붙인다(맡긴 뒤에는 붙이지 않음)", async () => {
  const { agent } = makeAgent();
  S.settings[2] = settingsWith("m", { runMode: "task" });
  await request(agent);
  assert.ok(S.opens[0].req.messages.some((m) => m.content === TASK_MODE_NOTE));
  S.settingsCalls = 0;
  agent.taskApproved = true;
  S.settings[2] = settingsWith("m", { runMode: "task" });
  await request(agent);
  assert.ok(!S.opens[1].req.messages.some((m) => m.content === TASK_MODE_NOTE));
});

test("준비: 서명 제공자는 도구 결과 다음 요청에 현재 시각·후보·맡기기 안내를 붙이지 않는다(마무리 안내는 붙임)", async () => {
  const { agent } = makeAgent();
  S.signs = true;
  S.candidates = async () => CANDIDATES;
  S.settings[2] = settingsWith("m", { runMode: "task" });
  agent.history = [{ role: "user", content: "질문" }, { role: "assistant", content: "", tool_calls: [] }, { role: "tool", content: "결과", tool_call_id: "c" }];
  const reply = await request(agent, { wrapUpNote: "마무리" });
  assert.deepEqual(S.opens[0].req.messages.slice(4).map((m) => m.content), ["마무리"]);
  assert.equal(reply.sentCandidates, null);
  assert.deepEqual(reply.sentNotes.map((m) => m.content), ["마무리"]);
});

test("준비: 서명 제공자에서 기록에 보낸 후보와 같은 글이면 다시 싣지 않는다", async () => {
  const { agent } = makeAgent();
  S.signs = true;
  agent.committedCandidates = { text: CANDIDATES, ids: new Set(["a"]) };
  S.candidates = async () => CANDIDATES;
  const reply = await request(agent);
  assert.ok(!S.opens[0].req.messages.some((m) => typeof m.content === "string" && m.content.includes("저장 링크 후보")));
  assert.equal(reply.sentCandidates, null);
  assert.equal(agent.forceNewConversation, false);
});

test("준비: 서명 제공자가 아니면 기록에 보낸 후보가 지워져도 멈추지 않는다", async () => {
  const { agent } = makeAgent();
  agent.committedCandidates = { text: CANDIDATES, ids: new Set(["a"]) };
  S.candidates = async () => null;
  assert.ok(await request(agent));
  assert.equal(agent.forceNewConversation, false);
});

test("준비: 후보 조회가 실패하면 후보 없이 보낸다", async () => {
  const { agent } = makeAgent();
  S.candidates = () => Promise.reject(new Error("store"));
  const reply = await request(agent);
  assert.equal(reply.sentCandidates, null);
  assert.equal(S.opens.length, 1);
});

test("준비: 이 요청에 실은 기준(rebasePending)은 응답을 다 받은 뒤 확정한다", async () => {
  const { agent } = makeAgent();
  agent.rebasePending = [{ id: "t", nonce: "n1" }];
  S.open = () => {
    // 요청을 연 뒤 생긴 기준은 이 요청의 것이 아니다.
    agent.rebasePending.push({ id: "t", nonce: "n2" });
    return Promise.resolve({ read: async () => {} });
  };
  await request(agent);
  assert.deepEqual(agent.rebaseConfirmed.get("t"), ["n1"]);
  assert.deepEqual(agent.rebasePending, [{ id: "t", nonce: "n2" }]);
});
