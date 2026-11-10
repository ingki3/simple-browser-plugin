// 반복 작업 텔레그램 알림의 확인 결과 요약(#209): 글 만들기(상한·잘림·서로게이트), 보내기 직전 재확인 판정,
// 저장 큐(실제 createSerial)를 지연시킨 상태에서 요약 끄기·알림 끄기·연결 끊기가 보내기 직전 읽기에 반영되는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MASK_FAILED_TEXT,
  REPEAT_SUMMARY_CUT,
  REPEAT_SUMMARY_MAX,
  repeatNoticePlan,
  repeatNoticeText,
  repeatNoticeWants,
  runRepeatNotice,
} from "../src/lib/telegram.ts";
import { createSerial } from "../src/lib/async.ts";

const base = (title) => `반복 작업 ‘${title}’의 조건이 맞았습니다. 패널에서 ‘이어서 진행’을 누르세요.`;
const isLone = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

test("repeatNoticeText: 요약이 없거나 빈 글이면 지금 문구 그대로(이름만)", () => {
  assert.equal(repeatNoticeText("공연 예매", null), base("공연 예매"));
  assert.equal(repeatNoticeText("공연 예매", ""), base("공연 예매"));
  assert.equal(repeatNoticeText("공연 예매", "  \n "), base("공연 예매"));
});

test("repeatNoticeText: 요약을 붙인다(앞뒤 공백은 자름)", () => {
  assert.equal(repeatNoticeText("공연 예매", "  예매 버튼이 열렸습니다. "), `${base("공연 예매")}\n\n확인 결과: 예매 버튼이 열렸습니다.`);
});

test("repeatNoticeText: 정확히 상한이면 자르지 않고, 하나 넘으면 상한에서 자르고 잘림 표시", () => {
  assert.equal(REPEAT_SUMMARY_MAX, 1000);
  const exact = "가".repeat(1000);
  assert.equal(repeatNoticeText("t", exact), `${base("t")}\n\n확인 결과: ${exact}`);
  const over = "가".repeat(1001);
  const out = repeatNoticeText("t", over);
  assert.equal(out, `${base("t")}\n\n확인 결과: ${"가".repeat(1000)}${REPEAT_SUMMARY_CUT}`);
  const body = out.slice(`${base("t")}\n\n확인 결과: `.length);
  assert.ok(body.length <= REPEAT_SUMMARY_MAX + REPEAT_SUMMARY_CUT.length);
  assert.ok(REPEAT_SUMMARY_CUT.includes("잘렸습니다"));
});

test("repeatNoticeText: 이모지(서로게이트 쌍)를 가르지 않는다", () => {
  // 999자 뒤 이모지 → 상한(1000)이 쌍 가운데. 쌍 앞에서 자른다.
  const s = "a".repeat(999) + "😀" + "b".repeat(10);
  const out = repeatNoticeText("t", s);
  const body = out.slice(`${base("t")}\n\n확인 결과: `.length);
  assert.equal(body, "a".repeat(999) + REPEAT_SUMMARY_CUT);
  assert.ok(!isLone(out));
  // 998자 뒤 이모지 → 쌍이 상한 안에 다 든다.
  const s2 = "a".repeat(998) + "😀" + "b".repeat(10);
  const body2 = repeatNoticeText("t", s2).slice(`${base("t")}\n\n확인 결과: `.length);
  assert.equal(body2, "a".repeat(998) + "😀" + REPEAT_SUMMARY_CUT);
  assert.ok(!isLone(body2));
});

const st = (o = {}) => ({ notifyRepeat: true, notifyRepeatSummary: false, chatId: 7, status: "idle", epoch: 1, ...o });
const sig = new AbortController().signal;
const rd = (s, o = {}) => ({ s, alive: true, conn: sig, ...o });

test("repeatNoticeWants: 알림·연결·상태·요약 설정으로 정한다", () => {
  assert.equal(repeatNoticeWants(st()), "name");
  assert.equal(repeatNoticeWants(st({ notifyRepeatSummary: true })), "summary");
  assert.equal(repeatNoticeWants(st({ notifyRepeat: false, notifyRepeatSummary: true })), "none");
  assert.equal(repeatNoticeWants(st({ chatId: null })), "none");
  assert.equal(repeatNoticeWants(st({ status: "stopped_auth" })), "none");
});

test("repeatNoticePlan: 보내기 직전 상태로 다시 판단한다", () => {
  const on = st({ notifyRepeatSummary: true });
  assert.equal(repeatNoticePlan(rd(on), rd(on), true), "summary");
  // 요약이 없으면(가림 실패·빈 이유) 이름만.
  assert.equal(repeatNoticePlan(rd(on), rd(on), false), "name");
  // 가림 대기 중 요약만 끔 → 이름만, 알림을 끔 → 보내지 않음.
  assert.equal(repeatNoticePlan(rd(on), rd(st()), true), "name");
  assert.equal(repeatNoticePlan(rd(on), rd(st({ notifyRepeat: false, notifyRepeatSummary: true })), true), "none");
  // 처음엔 요약 꺼짐, 그 사이 켬 → 준비한 요약이 없으니 이름만.
  assert.equal(repeatNoticePlan(rd(st()), rd(on), false), "name");
  // 연결이 바뀜(세대·신호) → 보내지 않음.
  assert.equal(repeatNoticePlan(rd(on), rd(st({ notifyRepeatSummary: true, epoch: 2 })), true), "none");
  assert.equal(repeatNoticePlan(rd(on), rd(on, { alive: false }), true), "none");
  assert.equal(repeatNoticePlan(rd(on), rd(on, { conn: new AbortController().signal }), true), "none");
  assert.equal(repeatNoticePlan(rd(on), rd(st({ notifyRepeatSummary: true, chatId: null })), true), "none");
  assert.equal(repeatNoticePlan(rd(on, { alive: false }), rd(on), true), "none");
});

// ---- runRepeatNotice: 저장·가림·전송을 주입 ----

function deferred() {
  let resolve;
  const p = new Promise((r) => (resolve = r));
  return { p, resolve };
}

// telegram.ts와 같은 모양의 가짜 저장소: 저장 큐(실제 createSerial)·연결 신호(끊기면 새로 만든다).
function fakeStore(init) {
  const serial = createSerial();
  let store = { ...init };
  let gen = new AbortController();
  const sent = [];
  return {
    sent,
    serial,
    get store() {
      return store;
    },
    // 앞선 저장이 밀린 상태를 만든다(이 저장이 끝나야 뒤 작업이 돈다).
    slowSave() {
      const d = deferred();
      void serial(() => d.p);
      return d.resolve;
    },
    set(patch) {
      return serial(async () => {
        store = { ...store, ...patch };
      });
    },
    // telegramDisconnect: 신호를 먼저 끊고 바꾼 뒤, 저장을 큐에 넣는다.
    disconnect() {
      gen.abort();
      gen = new AbortController();
      return serial(async () => {
        store = { ...store, epoch: store.epoch + 1, chatId: null };
      });
    },
    read: async () => {
      const conn = gen.signal;
      const s = await serial(async () => ({ ...store }));
      return { s, conn, alive: !conn.aborted && conn === gen.signal };
    },
    send: async (s, text, signal) => {
      sent.push({ chatId: s.chatId, text, aborted: signal.aborted });
    },
  };
}

const identity = async (x) => x;
const T = { id: "1", title: "공연 예매", reason: "예매 버튼이 열렸습니다." };

test("runRepeatNotice: 요약 꺼짐이면 지금과 같은 글(이름만)", async () => {
  const f = fakeStore(st());
  const r = await runRepeatNotice({ read: f.read, mask: identity, send: f.send }, T);
  assert.equal(r.kind, "name");
  assert.deepEqual(f.sent, [{ chatId: 7, text: base("공연 예매"), aborted: false }]);
});

test("runRepeatNotice: 요약 켜짐이면 이름 + 요약, 가린 글로", async () => {
  const f = fakeStore(st({ notifyRepeatSummary: true }));
  const mask = async (x) => x.replaceAll("열렸", "[가린 값]");
  const r = await runRepeatNotice({ read: f.read, mask, send: f.send }, T);
  assert.equal(r.kind, "summary");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, `${base("공연 예매")}\n\n확인 결과: 예매 버튼이 [가린 값]습니다.`);
});

test("runRepeatNotice: 이유가 비어 있으면(저장 때 가림 실패) 이름만", async () => {
  const f = fakeStore(st({ notifyRepeatSummary: true }));
  await runRepeatNotice({ read: f.read, mask: identity, send: f.send }, { ...T, reason: "  " });
  assert.deepEqual(f.sent.map((m) => m.text), [base("공연 예매")]);
});

test("runRepeatNotice: 요약 가림이 실패하면 대체 문구가 아니라 이름만", async () => {
  const f = fakeStore(st({ notifyRepeatSummary: true }));
  const mask = async (x) => {
    if (x === T.reason) throw new Error("목록 못 읽음");
    return x;
  };
  const r = await runRepeatNotice({ read: f.read, mask, send: f.send }, T);
  assert.equal(r.kind, "name");
  assert.deepEqual(f.sent.map((m) => m.text), [base("공연 예매")]);
});

test("runRepeatNotice: 전체 글 가림이 실패하면 지금처럼 대체 문구", async () => {
  for (const summary of [false, true]) {
    const f = fakeStore(st({ notifyRepeatSummary: summary }));
    const mask = async () => {
      throw new Error("목록 못 읽음");
    };
    await runRepeatNotice({ read: f.read, mask, send: f.send }, T);
    assert.deepEqual(f.sent.map((m) => m.text), [MASK_FAILED_TEXT]);
    assert.equal(MASK_FAILED_TEXT, "결과를 안전하게 보내지 못했습니다. 패널에서 확인해 주세요.");
  }
});

test("runRepeatNotice: 알림이 꺼져 있거나 연결이 없으면 가리지도 보내지도 않는다", async () => {
  for (const s of [st({ notifyRepeat: false, notifyRepeatSummary: true }), st({ chatId: null }), st({ status: "stopped_conflict" })]) {
    const f = fakeStore(s);
    let masked = 0;
    const r = await runRepeatNotice({ read: f.read, mask: async (x) => (masked++, x), send: f.send }, T);
    assert.equal(r.kind, "none");
    assert.equal(f.sent.length, 0);
    assert.equal(masked, 0);
  }
});

// 가림이 붙잡힌 사이, 앞선 저장이 밀린 큐 뒤에 설정 변경을 넣는다. 보내기 직전 읽기는 그 변경 뒤의 상태를 봐야 한다.
async function raceCase(init, change) {
  const f = fakeStore(init);
  const gate = deferred();
  let maskCalls = 0;
  const mask = async (x) => {
    maskCalls++;
    if (maskCalls === 1) await gate.p;
    return x;
  };
  const run = runRepeatNotice({ read: f.read, mask, send: f.send }, T);
  // 첫 읽기가 끝나고 가림에서 붙잡힐 때까지.
  while (maskCalls === 0) await new Promise((r) => setTimeout(r, 1));
  const release = f.slowSave();
  const changed = change(f);
  gate.resolve();
  // 앞 저장이 밀려 있는 동안에는 보내지 않는다(큐를 거쳐 읽으므로).
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.sent.length, 0, "앞 저장이 끝나기 전에 보냄");
  release();
  await changed;
  const r = await run;
  return { f, r };
}

test("runRepeatNotice(저장 큐 지연): 가림 대기 중 요약을 끄면 이름만", async () => {
  const { f, r } = await raceCase(st({ notifyRepeatSummary: true }), (f) => f.set({ notifyRepeatSummary: false }));
  assert.equal(r.kind, "name");
  assert.deepEqual(f.sent.map((m) => m.text), [base("공연 예매")]);
});

test("runRepeatNotice(저장 큐 지연): 가림 대기 중 알림을 끄면 보내지 않음", async () => {
  const { f, r } = await raceCase(st({ notifyRepeatSummary: true }), (f) => f.set({ notifyRepeat: false }));
  assert.equal(r.kind, "none");
  assert.equal(f.sent.length, 0);
});

test("runRepeatNotice(저장 큐 지연): 가림 대기 중 연결을 끊으면 보내지 않음", async () => {
  for (const summary of [false, true]) {
    const { f, r } = await raceCase(st({ notifyRepeatSummary: summary }), (f) => f.disconnect());
    assert.equal(r.kind, "none");
    assert.equal(f.sent.length, 0);
  }
});

test("runRepeatNotice(저장 큐 지연): 끊고 다시 연결해 다른 채팅이 돼도 보내지 않음", async () => {
  const { f, r } = await raceCase(st({ notifyRepeatSummary: true }), async (f) => {
    await f.disconnect();
    await f.set({ chatId: 99 });
  });
  assert.equal(r.kind, "none");
  assert.equal(f.sent.length, 0);
});
