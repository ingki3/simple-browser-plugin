// send_to_telegram(#210)의 순수 부분: 인자 스키마, 잘림 없이 나누기(splitWhole), 조각 보내기 계약(sendParts),
// 연결 세대 판정(sendAllowed), 미리보기 준비(prepareOwnSend)와 실행(runPreparedSend) — 저장·가림·전송을 주입해 시험한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TELEGRAM_SENDS_PER_TURN,
  SEND_TO_TELEGRAM_MAX,
  TELEGRAM_MAX_TEXT,
  ownSendErrorText,
  prepareOwnSend,
  runPreparedSend,
  sendAllowed,
  sendParts,
  splitWhole,
} from "../src/lib/telegram.ts";
import { sendToTelegramArgs } from "../src/lib/telegramSendArgs.ts";
import { createSerial } from "../src/lib/async.ts";
import { maskText } from "../src/lib/secretMask.ts";

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
const okParts = (text, parts) => {
  assert.ok(parts, "null이 아님");
  assert.equal(parts.join(""), text, "이으면 원문");
  for (const p of parts) {
    assert.ok(p.length <= TELEGRAM_MAX_TEXT, `조각 ${p.length}자`);
    assert.ok(p.trim().length > 0, "빈·공백만 조각 없음");
    assert.ok(!isLone(p), "서로게이트 쌍을 가르지 않음");
  }
};

// ---- 스키마 ----

test("스키마: text 하나(1~8000자, trim 뒤 1자 이상), 모르는 키(chat_id·to) 거절", () => {
  assert.ok(sendToTelegramArgs.safeParse({ text: "안녕" }).success);
  assert.ok(sendToTelegramArgs.safeParse({ text: "a".repeat(8000) }).success);
  assert.equal(SEND_TO_TELEGRAM_MAX, 8000);
  for (const bad of [{}, { text: "" }, { text: "   \n " }, { text: "a".repeat(8001) }, { text: "hi", chat_id: 1 }, { text: "hi", to: "@x" }, { text: 3 }]) {
    assert.equal(sendToTelegramArgs.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(MAX_TELEGRAM_SENDS_PER_TURN, 3);
});

// ---- splitWhole ----

test("splitWhole: 한도 안이면 그대로 한 조각", () => {
  assert.deepEqual(splitWhole("짧은 글"), ["짧은 글"]);
  const t = "a".repeat(TELEGRAM_MAX_TEXT);
  assert.deepEqual(splitWhole(t), [t]);
});

test("splitWhole: 3000자 + 빈 줄 + 2000자 → 줄바꿈 바로 뒤에서 자르고 줄바꿈은 앞 조각에 남는다", () => {
  const t = `${"a".repeat(3000)}\n\n${"b".repeat(2000)}`;
  const p = splitWhole(t);
  okParts(t, p);
  assert.equal(p.length, 2);
  assert.equal(p[0], `${"a".repeat(3000)}\n\n`);
  assert.equal(p[1], "b".repeat(2000));
});

test("splitWhole: 연속 줄바꿈 경계에서도 이으면 원문", () => {
  const t = `${"a".repeat(2500)}${"\n".repeat(2000)}${"b".repeat(1000)}`;
  okParts(t, splitWhole(t));
  const t2 = `${"x".repeat(4095)}\n\n\n${"y".repeat(10)}`;
  okParts(t2, splitWhole(t2));
});

test("splitWhole: 줄바꿈 없는 8000자는 한도에서 자른다", () => {
  const t = "가".repeat(8000);
  const p = splitWhole(t);
  okParts(t, p);
  assert.equal(p.length, 2);
  assert.equal(p[0].length, TELEGRAM_MAX_TEXT);
});

test("splitWhole: 줄바꿈이 한도의 절반보다 앞이면 한도에서 자른다", () => {
  const t = `${"a".repeat(100)}\n${"b".repeat(6000)}`;
  const p = splitWhole(t);
  okParts(t, p);
  assert.equal(p[0].length, TELEGRAM_MAX_TEXT);
});

test("splitWhole: 이모지(서로게이트 쌍) 경계에서 가르지 않는다", () => {
  const t = `${"a".repeat(TELEGRAM_MAX_TEXT - 1)}😀${"b".repeat(100)}`;
  const p = splitWhole(t);
  okParts(t, p);
  assert.equal(p[0].length, TELEGRAM_MAX_TEXT - 1);
  const t2 = "😀".repeat(5000);
  okParts(t2, splitWhole(t2));
});

test("splitWhole: 4조각을 넘으면 null(조용히 자르지 않음)", () => {
  assert.equal(splitWhole("a".repeat(TELEGRAM_MAX_TEXT * 4 + 1)), null);
  okParts("a".repeat(TELEGRAM_MAX_TEXT * 4), splitWhole("a".repeat(TELEGRAM_MAX_TEXT * 4)));
  // 조각 수 상한을 주면 그에 따른다.
  assert.equal(splitWhole("a".repeat(30), 10, 2), null);
});

test("splitWhole: 공백·줄바꿈만 남는 조각을 만들지 않는다(경계를 옮긴다), 공백만 글이면 null", () => {
  const t = `${"a".repeat(TELEGRAM_MAX_TEXT)}\n\n\n`;
  const p = splitWhole(t);
  okParts(t, p);
  assert.equal(p.length, 2);
  const t2 = `${"a".repeat(TELEGRAM_MAX_TEXT - 1)}😀   `;
  okParts(t2, splitWhole(t2));
  assert.equal(splitWhole(""), null);
  assert.equal(splitWhole("  \n\t "), null);
});

// ---- sendParts ----

const noWait = () => Promise.resolve();

test("sendParts: 모두 보내면 done, 조각 순서대로", async () => {
  const got = [];
  const r = await sendParts(["a", "b", "c"], new AbortController().signal, { send: async (p) => (got.push(p), "ok"), wait: noWait });
  assert.deepEqual(r, { sent: 3, outcome: "done" });
  assert.deepEqual(got, ["a", "b", "c"]);
});

test("sendParts: 중간 조각 실패 → failed, 앞에 간 수를 센다", async () => {
  let n = 0;
  const r = await sendParts(["a", "b", "c"], new AbortController().signal, {
    send: async () => {
      if (++n === 2) throw new Error("500");
      return "ok";
    },
    wait: noWait,
  });
  assert.deepEqual(r, { sent: 1, outcome: "failed" });
  assert.equal(n, 2, "뒤 조각은 보내지 않음");
});

test("sendParts: 429면 한 번 기다려 다시, 두 번째도 429면 failed", async () => {
  let n = 0;
  const waits = [];
  const r = await sendParts(["a", "b"], new AbortController().signal, {
    send: async () => (++n === 1 ? { retryAfterMs: 1000 } : "ok"),
    wait: async (ms) => void waits.push(ms),
  });
  assert.deepEqual(r, { sent: 2, outcome: "done" });
  assert.deepEqual(waits, [1000]);
  const r2 = await sendParts(["a"], new AbortController().signal, { send: async () => ({ retryAfterMs: 5 }), wait: noWait });
  assert.deepEqual(r2, { sent: 0, outcome: "failed" });
});

test("sendParts: 429 대기 중 중단 → aborted, 다시 보내지 않음", async () => {
  const ctl = new AbortController();
  let n = 0;
  const r = await sendParts(["a", "b"], ctl.signal, {
    send: async () => (++n === 2 ? { retryAfterMs: 1000 } : "ok"),
    wait: async () => ctl.abort(),
  });
  assert.deepEqual(r, { sent: 1, outcome: "aborted" });
  assert.equal(n, 2);
});

test("sendParts: 이미 중단된 신호면 보내지 않는다(0)", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let n = 0;
  const r = await sendParts(["a"], ctl.signal, { send: async () => (n++, "ok"), wait: noWait });
  assert.deepEqual(r, { sent: 0, outcome: "aborted" });
  assert.equal(n, 0);
});

test("sendParts: 보내는 중 중단돼 예외가 나면 aborted", async () => {
  const ctl = new AbortController();
  const r = await sendParts(["a", "b"], ctl.signal, {
    send: async () => {
      ctl.abort();
      throw new Error("aborted");
    },
    wait: noWait,
  });
  assert.deepEqual(r, { sent: 0, outcome: "aborted" });
});

// ---- 연결 세대·준비·실행 ----

const STATE = { token: "1:x", chatId: 7001, chatLabel: "@me", status: "idle", epoch: 3 };

// 저장 큐(실제 createSerial)와 연결 신호를 흉내 낸 텔레그램 상태. disconnect/changeToken은 실제처럼 신호를 바꾼 같은 순간에 저장을 큐에 넣는다.
function fakeStore(initial = STATE) {
  const serial = createSerial();
  let stored = { ...initial };
  let conn = new AbortController();
  const save = (fn, delayMs = 0) =>
    serial(async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      stored = fn(stored);
    });
  return {
    read: async () => {
      const c = conn.signal;
      const s = await serial(async () => ({ ...stored }));
      return { s, conn: c, alive: !c.aborted && c === conn.signal };
    },
    save,
    endSession() {
      conn.abort();
      conn = new AbortController();
    },
    disconnect(delayMs = 0) {
      this.endSession();
      return save((s) => ({ ...s, epoch: s.epoch + 1, chatId: null, chatLabel: "" }), delayMs);
    },
    get state() {
      return stored;
    },
  };
}

const sendDeps = (store, over = {}) => {
  const sent = [];
  return {
    sent,
    deps: {
      read: store.read,
      mask: async (t) => t,
      send: async (s, part) => {
        sent.push({ chatId: s.chatId, part });
        return "ok";
      },
      wait: noWait,
      ...over,
    },
  };
};

test("sendAllowed: 같은 연결 세대·채팅·idle·살아 있는 신호일 때만", () => {
  const conn = new AbortController().signal;
  const prepared = { raw: "a", safeText: "a", epoch: 3, chatId: 7001, conn };
  const read = (over = {}, alive = true, c = conn) => ({ s: { ...STATE, ...over }, conn: c, alive });
  assert.equal(sendAllowed(prepared, read()), true);
  assert.equal(sendAllowed(prepared, read({ epoch: 4 })), false, "세대 바뀜");
  assert.equal(sendAllowed(prepared, read({ chatId: 9 })), false, "다른 채팅");
  assert.equal(sendAllowed(prepared, read({ chatId: null })), false, "끊김");
  assert.equal(sendAllowed(prepared, read({ status: "stopped_auth" })), false, "상태 이상");
  assert.equal(sendAllowed(prepared, read({ token: "" })), false, "토큰 없음");
  assert.equal(sendAllowed(prepared, read({}, false)), false, "신호 죽음");
  assert.equal(sendAllowed(prepared, read({}, true, new AbortController().signal)), false, "다른 연결 신호");
});

test("prepareOwnSend: 미연결·상태 이상이면 not_connected, 가림 실패면 mask_failed, 가린 뒤 길면 too_long", async () => {
  const mask = async (t) => t;
  for (const over of [{ token: "" }, { chatId: null }, { status: "stopped_conflict" }]) {
    const store = fakeStore({ ...STATE, ...over });
    assert.deepEqual(await prepareOwnSend({ read: store.read, mask }, "글"), { ok: false, why: "not_connected" }, JSON.stringify(over));
  }
  const store = fakeStore();
  assert.deepEqual(await prepareOwnSend({ read: store.read, mask: async () => { throw new Error("x"); } }, "글"), { ok: false, why: "mask_failed" });
  // 가린 뒤 8000자를 넘으면(가림 표시가 원문보다 길 수 있다) 거절.
  const longer = async (t) => t.replaceAll("pw", "[가린 값]");
  assert.deepEqual(await prepareOwnSend({ read: store.read, mask: longer }, "pw".repeat(3000)), { ok: false, why: "too_long" });
  // 공백만 남으면(가림으로는 생기지 않지만) 조각이 없어 거절.
  assert.deepEqual(await prepareOwnSend({ read: store.read, mask: async () => "   " }, "x"), { ok: false, why: "too_long" });
  const ok = await prepareOwnSend({ read: store.read, mask: async (t) => t.replaceAll("Secret1", "[가린 값]") }, "값 Secret1 끝");
  assert.equal(ok.ok, true);
  assert.equal(ok.prepared.raw, "값 Secret1 끝");
  assert.equal(ok.prepared.safeText, "값 [가린 값] 끝");
  assert.equal(ok.prepared.epoch, 3);
  assert.equal(ok.prepared.chatId, 7001);
  assert.equal(ok.chatLabel, "@me");
});

test("prepareOwnSend: 가리는 사이 연결을 끊으면 not_connected", async () => {
  const store = fakeStore();
  const r = await prepareOwnSend({ read: store.read, mask: async (t) => (store.endSession(), t) }, "글");
  assert.deepEqual(r, { ok: false, why: "not_connected" });
});

test("runPreparedSend: 승인한 글(safeText)을 연결한 chatId로만 보낸다", async () => {
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, "보낼 글");
  const { sent, deps } = sendDeps(store);
  const r = await runPreparedSend(deps, prep.prepared, new AbortController().signal);
  assert.deepEqual(r, { ok: true, parts: 1 });
  assert.deepEqual(sent, [{ chatId: 7001, part: "보낼 글" }]);
});

test("runPreparedSend: 카드 대기 중 끊고 다른 채팅을 연결하면 전송 0(connection_changed)", async () => {
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, "글");
  await store.disconnect();
  await store.save((s) => ({ ...s, chatId: 9999, chatLabel: "@other" }));
  const { sent, deps } = sendDeps(store);
  const r = await runPreparedSend(deps, prep.prepared, new AbortController().signal);
  assert.deepEqual(r, { ok: false, why: "connection_changed", sent: 0 });
  assert.equal(sent.length, 0);
});

test("runPreparedSend: 토큰 바꾸기(세대 올림·같은 채팅 다시 연결)여도 전송 0", async () => {
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, "글");
  store.endSession();
  await store.save((s) => ({ ...s, epoch: s.epoch + 1, token: "2:y" }));
  const { sent, deps } = sendDeps(store);
  assert.equal((await runPreparedSend(deps, prep.prepared, new AbortController().signal)).why, "connection_changed");
  assert.equal(sent.length, 0);
});

test("runPreparedSend: 저장 큐가 밀린 상태에서 끊기를 부르면 실행의 읽기는 끊긴 뒤 상태를 본다(전송 0)", async () => {
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, "글");
  // 앞 저장이 오래 걸리는 동안 끊기(신호는 바로 바뀌고 저장은 큐 뒤에 선다)를 부르고, 그 사이 실행이 읽는다.
  const slow = store.save((s) => s, 50);
  const off = store.disconnect();
  const { sent, deps } = sendDeps(store);
  const r = await runPreparedSend(deps, prep.prepared, new AbortController().signal);
  await Promise.all([slow, off]);
  assert.equal(r.why, "connection_changed");
  assert.equal(store.state.chatId, null);
  assert.equal(sent.length, 0);
});

test("runPreparedSend: 저장 큐가 밀린 상태에서 신호를 바꾸지 않고 세대만 올리는 저장도 반영된다", async () => {
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, "글");
  const slow = store.save((s) => s, 50);
  const bump = store.save((s) => ({ ...s, epoch: s.epoch + 1 }));
  const { sent, deps } = sendDeps(store);
  const r = await runPreparedSend(deps, prep.prepared, new AbortController().signal);
  await Promise.all([slow, bump]);
  assert.equal(r.why, "connection_changed");
  assert.equal(sent.length, 0);
});

test("runPreparedSend: 가림 검증 — 원문을 다시 가려 승인한 글과 같을 때만(가림 표시와 겹치는 값이 있어도 목록이 그대로면 통과)", async () => {
  // 리뷰의 멱등성 반례: 목록에 가림 표시의 일부("린 값")가 있으면 가린 글을 다시 가리면 달라진다. 원문을 다시 가리면 같다.
  let secrets = ["Secret1", "린 값"];
  const mask = async (t) => maskText(t, secrets).text;
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask }, "값 Secret1 끝");
  assert.equal(prep.ok, true);
  assert.notEqual(await mask(prep.prepared.safeText), prep.prepared.safeText, "가린 글을 다시 가리면 달라지는 반례");
  const { sent, deps } = sendDeps(store, { mask });
  assert.deepEqual(await runPreparedSend(deps, prep.prepared, new AbortController().signal), { ok: true, parts: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].part, prep.prepared.safeText);

  // 승인 뒤 목록에 글 속 낱말이 더해지면 mask_changed(전송 0).
  const prep2 = await prepareOwnSend({ read: store.read, mask }, "값 Secret1 그리고 끝말");
  secrets = [...secrets, "그리고"];
  const b = sendDeps(store, { mask });
  assert.deepEqual(await runPreparedSend(b.deps, prep2.prepared, new AbortController().signal), { ok: false, why: "mask_changed", sent: 0 });
  assert.equal(b.sent.length, 0);

  // 실행 때 가림 목록을 못 읽으면 mask_failed(전송 0).
  const c = sendDeps(store, { mask: async () => { throw new Error("x"); } });
  assert.deepEqual(await runPreparedSend(c.deps, prep2.prepared, new AbortController().signal), { ok: false, why: "mask_failed", sent: 0 });
  assert.equal(c.sent.length, 0);
});

test("runPreparedSend: 여러 조각, 중간 실패면 send_failed와 간 수, 턴 중단이면 aborted", async () => {
  const store = fakeStore();
  const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, text);
  const ok = sendDeps(store);
  assert.deepEqual(await runPreparedSend(ok.deps, prep.prepared, new AbortController().signal), { ok: true, parts: 2 });
  assert.equal(ok.sent.map((x) => x.part).join(""), text);

  let n = 0;
  const bad = sendDeps(store, { send: async () => { if (++n === 2) throw new Error("500"); return "ok"; } });
  assert.deepEqual(await runPreparedSend(bad.deps, prep.prepared, new AbortController().signal), { ok: false, why: "send_failed", sent: 1 });

  const ctl = new AbortController();
  ctl.abort();
  const stopped = sendDeps(store);
  assert.deepEqual(await runPreparedSend(stopped.deps, prep.prepared, ctl.signal), { ok: false, why: "aborted", sent: 0 });
  assert.equal(stopped.sent.length, 0);
});

test("runPreparedSend: 보내는 중 연결을 끊으면 남은 조각을 보내지 않는다", async () => {
  const store = fakeStore();
  const prep = await prepareOwnSend({ read: store.read, mask: async (t) => t }, `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
  const parts = [];
  const r = await runPreparedSend(
    { read: store.read, mask: async (t) => t, wait: noWait, send: async (_s, p) => { parts.push(p); store.endSession(); return "ok"; } },
    prep.prepared,
    new AbortController().signal,
  );
  assert.deepEqual(r, { ok: false, why: "aborted", sent: 1 });
  assert.equal(parts.length, 1);
});

test("ownSendErrorText: 고정 문구, 부분 전송이면 앞의 n개는 이미 갔다고 알린다(보낸 글·원문 없음)", () => {
  for (const why of ["not_connected", "mask_failed", "mask_changed", "too_long", "connection_changed", "send_failed", "aborted"]) {
    const t = ownSendErrorText(why, 0);
    assert.ok(t.length > 0 && !t.includes("이미 갔"), why);
  }
  assert.match(ownSendErrorText("send_failed", 2), /앞의 2개 메시지는 이미 갔습니다/);
  assert.match(ownSendErrorText("aborted", 1), /앞의 1개 메시지는 이미 갔습니다/);
  assert.match(ownSendErrorText("not_connected", 0), /텔레그램 연동/);
});
