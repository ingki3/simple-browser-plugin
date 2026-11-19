// keepalive 알람 큐(#307, src/background/keepalive.ts): 알람 만들기·지우기를 한 줄로 세우고, 각 작업은 실행될 때의 참조 수에 맞춘다.
// chrome.alarms 대역은 일부러 늦게 끝나(겹치면 드러나게) 동시에 도는 작업 수와 작업 순서를 남긴다. 네트워크는 쓰지 않는다.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

globalThis.fetch = () => {
  throw new Error("단위 시험에서 네트워크를 쓰지 않는다");
};

const ALARM = "openrouter-heartbeat";
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

let alarms;
function installChrome() {
  alarms = { exists: false, ops: [], active: 0, maxActive: 0, failClear: 0, listeners: [] };
  const op = async (name, fn) => {
    alarms.active++;
    alarms.maxActive = Math.max(alarms.maxActive, alarms.active);
    try {
      await tick(5);
      if (name === "clear" && alarms.failClear > 0) {
        alarms.failClear--;
        alarms.ops.push("clear:fail");
        throw new Error("clear 실패");
      }
      alarms.ops.push(name);
      fn();
    } finally {
      alarms.active--;
    }
  };
  globalThis.chrome = {
    alarms: {
      create: (n, info) => {
        assert.equal(n, ALARM);
        assert.equal(info.periodInMinutes, 0.5);
        return op("create", () => (alarms.exists = true));
      },
      clear: (n) => {
        assert.equal(n, ALARM);
        return op("clear", () => (alarms.exists = false)).then(() => true);
      },
      onAlarm: { addListener: (fn) => alarms.listeners.push(fn) },
    },
    runtime: { getPlatformInfo: async () => ({}) },
  };
}

let n = 0;
let loaded = null;
async function load() {
  installChrome();
  // 모듈 상태(참조 수·큐)가 시험마다 새로 시작하게 매번 새로 불러온다.
  loaded = await import(`../src/background/keepalive.ts?t=${++n}`);
  return loaded;
}
const fireAlarm = (name = ALARM) => alarms.listeners.forEach((fn) => fn({ name }));

beforeEach(() => {
  delete globalThis.chrome;
});
// 시험이 중간에 실패해도 20초 핑 타이머가 남아 시험 실행이 끝나지 않는 일이 없게 참조를 모두 놓는다(0에서 end는 아무 일 없음).
afterEach(() => {
  for (let i = 0; i < 10; i++) loaded?.endKeepalive();
  loaded = null;
});

test("begin/end/알람 수신을 빠르게 섞어도 작업은 겹치지 않고 최종 상태가 참조 상태와 같다", async () => {
  const k = await load();
  // 같은 순간에 넣은 작업은 모두 실행될 때의 참조 수(1)에 맞춘다 — 지우기가 끼어들지 않는다.
  k.beginKeepalive();
  k.endKeepalive();
  k.beginKeepalive();
  fireAlarm();
  k.beginKeepalive();
  k.endKeepalive();
  fireAlarm();
  await tick(100);
  assert.equal(alarms.maxActive, 1, "작업은 한 번에 하나");
  assert.equal(alarms.exists, true, "참조 1이면 알람이 있다");
  assert.ok(!alarms.ops.includes("clear"), `참조가 남았으니 지우지 않음(${alarms.ops})`);
  // 작업 사이사이에 끼워 넣어도(앞 작업이 도는 중) 최종 상태는 마지막 참조 상태다.
  k.endKeepalive();
  await tick(2);
  k.beginKeepalive();
  await tick(2);
  fireAlarm();
  k.endKeepalive();
  await tick(2);
  fireAlarm();
  await tick(100);
  assert.equal(alarms.maxActive, 1, "작업은 한 번에 하나");
  assert.equal(alarms.exists, false, "참조 0이면 알람이 없다");
  assert.equal(alarms.ops.at(-1), "clear");
});

test("end 뒤 바로 begin: 마지막 작업이 마지막 참조 상태를 반영한다(지우기가 만들기 뒤로 가지 않음)", async () => {
  const k = await load();
  k.beginKeepalive();
  await tick(30);
  k.endKeepalive();
  k.beginKeepalive();
  await tick(60);
  // end가 넣은 작업도 실행될 때는 참조가 1이라 만들기로 맞춘다.
  assert.deepEqual(alarms.ops, ["create", "create", "create"]);
  assert.equal(alarms.exists, true);
  k.endKeepalive();
  await tick(30);
  assert.equal(alarms.exists, false);
});

test("첫 clear가 실패해도 다음 create와 마지막 clear가 각각 실행된다", async () => {
  const k = await load();
  k.beginKeepalive();
  await tick(30);
  alarms.failClear = 1;
  k.endKeepalive(); // → clear(실패)
  await tick(1); // 지우기가 도는 중에
  k.beginKeepalive(); // → create
  await tick(30);
  k.endKeepalive(); // → clear
  await tick(30);
  assert.deepEqual(alarms.ops, ["create", "clear:fail", "create", "clear"]);
  assert.equal(alarms.exists, false);
  assert.equal(alarms.maxActive, 1);
});

test("참조 0에서 알람을 받으면 지운다(다른 알람 이름은 무시)", async () => {
  await load();
  alarms.exists = true;
  fireAlarm("telegram-poll");
  await tick(30);
  assert.deepEqual(alarms.ops, []);
  fireAlarm();
  await tick(30);
  assert.deepEqual(alarms.ops, ["clear"]);
  assert.equal(alarms.exists, false);
});

test("참조가 있을 때 받은 알람은 다시 만들지도 지우지도 않는다", async () => {
  const k = await load();
  k.beginKeepalive();
  await tick(30);
  fireAlarm();
  fireAlarm();
  await tick(30);
  assert.deepEqual(alarms.ops, ["create"]);
  k.endKeepalive();
  await tick(30);
  assert.deepEqual(alarms.ops, ["create", "clear"]);
});

test("짝이 맞지 않는 end는 참조를 음수로 만들지 않는다", async () => {
  const k = await load();
  k.endKeepalive();
  k.beginKeepalive();
  await tick(30);
  assert.equal(alarms.exists, true);
  k.endKeepalive();
  await tick(30);
  assert.equal(alarms.exists, false);
});
