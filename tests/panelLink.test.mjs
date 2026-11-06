import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptResume,
  disconnectDetail,
  heartbeatLate,
  LostNotice,
  PARK_MAX,
  PARK_TTL_MS,
  ParkedConversations,
  prevDisconnectDetail,
  resumeNeeded,
} from "../src/lib/panelLink.ts";

test("ParkedConversations: 같은 id로 한 번만 꺼내고, 다른 id는 없다", () => {
  const dropped = [];
  const p = new ParkedConversations((v) => dropped.push(v));
  p.put("c1", "A", 0);
  assert.deepEqual(p.take("c2", 10), { missing: "missing" });
  assert.deepEqual(p.take("c1", 10), { value: "A" });
  assert.deepEqual(p.take("c1", 20), { missing: "missing" });
  assert.equal(p.size, 0);
  assert.deepEqual(dropped, []);
});

test("ParkedConversations: TTL이 지나면 꺼내지 못하고 정리한다(take·expire)", () => {
  const dropped = [];
  const p = new ParkedConversations((v) => dropped.push(v));
  p.put("c1", "A", 0);
  assert.deepEqual(p.take("c1", PARK_TTL_MS + 1), { missing: "expired" });
  assert.deepEqual(dropped, ["A"]);
  p.put("c2", "B", 0);
  p.put("c3", "C", PARK_TTL_MS);
  p.expire(PARK_TTL_MS + 1);
  assert.deepEqual(dropped, ["A", "B"]);
  assert.equal(p.size, 1);
  assert.deepEqual(p.take("c3", PARK_TTL_MS + 2), { value: "C" });
});

test("ParkedConversations: 최대 개수를 넘으면 가장 오래된 것을 버리고, 같은 id에 다른 값이면 앞 값을 버린다", () => {
  const dropped = [];
  const p = new ParkedConversations((v) => dropped.push(v));
  for (let i = 0; i <= PARK_MAX; i++) p.put(`c${i}`, `v${i}`, i);
  assert.equal(p.size, PARK_MAX);
  assert.deepEqual(dropped, ["v0"]);
  p.put("c1", "new", 10);
  assert.deepEqual(dropped, ["v0", "v1"]);
  assert.deepEqual(p.take("c1", 11), { value: "new" });
  p.clear();
  assert.equal(p.size, 0);
  assert.equal(dropped.length, 2 + PARK_MAX - 1);
});

test("acceptResume: 지금 세대·지금 대화의 답만 받는다", () => {
  const reply = { conversationId: "c1", gen: 3, resumed: true };
  assert.equal(acceptResume(reply, { gen: 3, conversationId: "c1" }), true);
  assert.equal(acceptResume(reply, { gen: 4, conversationId: "c1" }), false);
  assert.equal(acceptResume(reply, { gen: 3, conversationId: "c2" }), false);
});

test("LostNotice: 새 요청 전 반복 유실은 한 번, 새 요청 뒤 다시, 새 대화면 다시", () => {
  const n = new LostNotice();
  assert.equal(n.shouldShow("c1"), true);
  assert.equal(n.shouldShow("c1"), false);
  n.onUserMessage();
  assert.equal(n.shouldShow("c1"), true);
  assert.equal(n.shouldShow("c2"), true);
  assert.equal(n.shouldShow("c2"), false);
});

test("disconnectDetail·prevDisconnectDetail: 수·상태만", () => {
  assert.equal(
    disconnectDetail({ connectedMs: 180_400, beatAgoMs: 19_600, visibility: "hidden", visibilityForMs: 600_000, busy: false }),
    "사유 없음 · 연결 유지 180초 · 마지막 heartbeat 보냄 20초 전 · visibility hidden(그 상태 600초) · 대화 쉬는 중 · 끊김 쪽: 백그라운드(또는 워커 종료)",
  );
  assert.match(disconnectDetail({ lastError: "x", connectedMs: 0, beatAgoMs: null, visibility: "visible", visibilityForMs: 0, busy: true }), /^사유 x · .*heartbeat 보낸 적 없음.*대화 진행 중/);
  assert.equal(prevDisconnectDetail(null, 0), "이 워커에는 이전 끊김 기록 없음(새 워커이거나 첫 연결)");
  assert.equal(
    prevDisconnectDetail({ at: 1_000, connectedMs: 60_000, heartbeatAt: 0, conversationId: "c", busy: false, parked: true }, 2_000),
    "백그라운드가 끊김을 봄 1초 전 · 연결 유지 60초 · 마지막 heartbeat 받음 끊기기 1초 전 · 대화 쉬는 중 · 기록 보관",
  );
  assert.match(prevDisconnectDetail({ at: 0, connectedMs: 0, heartbeatAt: null, conversationId: null, busy: false, parked: false }, 0), /heartbeat 받은 적 없음 · 대화 없음 · 기록 보관 안 함/);
});

test("heartbeatLate: 예정의 두 배를 넘을 때만", () => {
  assert.equal(heartbeatLate(null, 100_000, 20_000), false);
  assert.equal(heartbeatLate(0, 40_000, 20_000), false);
  assert.equal(heartbeatLate(0, 40_001, 20_000), true);
});

test("resumeNeeded: 끊긴 순간 같은 대화에 보낸 요청이 있었을 때만(재연결 직전에 막 추가한 첫 요청은 아님)", () => {
  assert.equal(resumeNeeded(null, "c1"), false);
  assert.equal(resumeNeeded({ conversationId: "c1", hadConversation: false }, "c1"), false);
  assert.equal(resumeNeeded({ conversationId: "c1", hadConversation: true }, "c1"), true);
  // 끊긴 뒤 새 대화로 바꿨으면 잇지 않는다.
  assert.equal(resumeNeeded({ conversationId: "c1", hadConversation: true }, "c2"), false);
});
