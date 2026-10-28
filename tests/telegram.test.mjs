// 텔레그램 연동(#139)의 순수 함수: 업데이트 해석, 확인 코드, 오래된 메시지, 오류 문구, 글 나누기.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  checkPairing,
  newPairing,
  parseUpdate,
  remoteErrorText,
  splitMessage,
  staleMessage,
  PAIRING_MAX_TRIES,
  PAIRING_TTL_MS,
  TELEGRAM_MAX_AGE_MS,
} from "../src/lib/telegram.ts";

const msg = (text, { chat = 7, from = 7, type = "private", date = 1000, isBot = false } = {}) => ({
  update_id: 1,
  message: { chat: { id: chat, type, username: "me" }, from: { id: from, is_bot: isBot }, text, date },
});

test("연결 전: 개인 대화의 여섯 자리 코드만 후보", () => {
  assert.deepEqual(parseUpdate(msg("123456"), null), { kind: "pair", chatId: 7, label: "@me", code: "123456", at: 1_000_000 });
  assert.equal(parseUpdate(msg("/start 654321"), null).code, "654321");
  assert.equal(parseUpdate(msg("안녕"), null).kind, "ignore");
  assert.equal(parseUpdate(msg("123456", { type: "group" }), null).kind, "ignore");
  assert.equal(parseUpdate(msg("123456", { from: 8 }), null).kind, "ignore");
  assert.equal(parseUpdate(msg("123456", { isBot: true }), null).kind, "ignore");
});

test("연결 뒤: 그 채팅의 개인 대화만, 명령은 정확한 글자", () => {
  assert.deepEqual(parseUpdate(msg("요약해 줘"), 7), { kind: "text", text: "요약해 줘", at: 1_000_000 });
  assert.equal(parseUpdate(msg("요약해 줘", { chat: 9, from: 9 }), 7).kind, "ignore");
  assert.equal(parseUpdate(msg("/stop"), 7).command, "stop");
  assert.equal(parseUpdate(msg("/new@my_bot"), 7).command, "new");
  assert.equal(parseUpdate(msg("/start"), 7).command, "help");
  assert.equal(parseUpdate(msg("/stop 지금"), 7).kind, "text");
  assert.equal(parseUpdate({ update_id: 2, message: { chat: { id: 7, type: "private" }, from: { id: 7 }, photo: [] } }, 7).kind, "ignore");
  assert.equal(parseUpdate(null, 7).kind, "ignore");
});

test("버튼: 그 채팅·그 사용자만", () => {
  const cb = (from, chat) => ({ update_id: 3, callback_query: { id: "q", data: "x", from: { id: from }, message: { chat: { id: chat, type: "private" } } } });
  assert.equal(parseUpdate(cb(7, 7), 7).kind, "callback");
  assert.equal(parseUpdate(cb(8, 7), 7).kind, "ignore");
  assert.equal(parseUpdate(cb(7, 7), null).kind, "ignore");
});

test("확인 코드: 만료·틀린 횟수 초과면 폐기", () => {
  const p = newPairing(0, () => 0.0123);
  assert.equal(p.code, "012300");
  assert.ok(checkPairing(p, "012300", 1).ok);
  assert.equal(checkPairing(p, "012300", PAIRING_TTL_MS + 1).ok, false);
  let cur = p;
  for (let i = 0; i < PAIRING_MAX_TRIES - 1; i++) {
    const r = checkPairing(cur, "999999", 1);
    assert.equal(r.ok, false);
    cur = r.next;
    assert.ok(cur);
  }
  assert.equal(checkPairing(cur, "999999", 1).next, null);
  assert.equal(checkPairing(null, "012300", 1).ok, false);
});

test("오래된 메시지: 연결 전에 보냈거나 10분 넘음", () => {
  assert.equal(staleMessage(100_000, 50_000, 120_000), false);
  assert.equal(staleMessage(10_000, 50_000, 60_000), true);
  assert.equal(staleMessage(100_000, 0, 100_000 + TELEGRAM_MAX_AGE_MS + 1), true);
});

test("오류 문구는 고정(원문 없음)", () => {
  assert.match(remoteErrorText("settings"), /API 키와 모델/);
  assert.match(remoteErrorText("usage"), /사용량/);
  assert.match(remoteErrorText(undefined), /잠시 뒤/);
});

test("글 나누기: 4096자, 줄바꿈에서, 서로게이트를 자르지 않고, 넘치면 잘림 안내", () => {
  assert.deepEqual(splitMessage("짧은 답"), ["짧은 답"]);
  assert.deepEqual(splitMessage("  "), ["(빈 답)"]);
  const long = ("가".repeat(3000) + "\n").repeat(3);
  const parts = splitMessage(long);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 4096));
  const emoji = "a" + "😀".repeat(3000);
  for (const p of splitMessage(emoji)) assert.ok(!/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p));
  const huge = splitMessage("x".repeat(4096 * 5), 4096, 4);
  assert.equal(huge.length, 4);
  assert.ok(huge[3].endsWith("(길어서 잘렸습니다)") && huge[3].length <= 4096);
});

test("재시도 간격은 1초부터 두 배, 최대 5분", () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(20), 300_000);
});
