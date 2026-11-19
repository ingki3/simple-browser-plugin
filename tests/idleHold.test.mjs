// 대화용 참조(#307, src/lib/idleHold.ts): renew는 처음에만 잡고 기한을 다시 걸며, release·만료는 잡고 있을 때만 한 번 놓는다.
// 가짜 타이머로 본다(실제 시간·네트워크를 쓰지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleHold } from "../src/lib/idleHold.ts";

globalThis.fetch = () => {
  throw new Error("단위 시험에서 네트워크를 쓰지 않는다");
};

function make(ms = 1000) {
  const calls = { begin: 0, end: 0, logs: [] };
  // 걸린 타이머(handle → { fn, ms }). fire(handle)로 만료시킨다.
  const timers = new Map();
  let next = 1;
  const hold = new IdleHold({
    begin: () => calls.begin++,
    end: () => calls.end++,
    setTimer: (fn, t) => {
      const h = next++;
      timers.set(h, { fn, ms: t });
      return h;
    },
    clearTimer: (h) => timers.delete(h),
    ms,
    log: (state, reason) => calls.logs.push(reason ? `${state} · ${reason}` : state),
  });
  const fire = () => {
    const [h, t] = [...timers.entries()].at(-1);
    timers.delete(h);
    t.fn();
  };
  return { hold, calls, timers, fire };
}

test("renew 두 번이면 begin은 1회, 타이머는 다시 걸린다(앞 타이머는 풀림)", () => {
  const { hold, calls, timers } = make(500);
  hold.renew();
  const first = [...timers.keys()];
  hold.renew();
  assert.equal(calls.begin, 1);
  assert.equal(calls.end, 0);
  assert.equal(timers.size, 1, "타이머는 하나만");
  assert.notDeepEqual([...timers.keys()], first, "새 타이머");
  assert.equal([...timers.values()][0].ms, 500);
  assert.equal(hold.held, true);
  assert.deepEqual(calls.logs, ["on"]);
});

test("만료되면 end 1회, 그 뒤 release를 불러도 다시 놓지 않는다", () => {
  const { hold, calls, fire } = make();
  hold.renew();
  fire();
  assert.equal(calls.end, 1);
  assert.equal(hold.held, false);
  hold.release("drop");
  assert.equal(calls.end, 1);
  assert.deepEqual(calls.logs, ["on", "off · 만료"]);
});

test("release를 두 번 불러도 end는 1회이고 타이머는 풀린다", () => {
  const { hold, calls, timers } = make();
  hold.renew();
  hold.release("drop");
  hold.release("수신 중지");
  assert.equal(calls.end, 1);
  assert.equal(timers.size, 0);
  assert.deepEqual(calls.logs, ["on", "off · drop"]);
});

test("잡지 않았을 때 release는 아무것도 하지 않는다", () => {
  const { hold, calls } = make();
  hold.release("drop");
  assert.equal(calls.begin + calls.end, 0);
  assert.deepEqual(calls.logs, []);
});

test("release 뒤 renew하면 begin이 다시 1회", () => {
  const { hold, calls } = make();
  hold.renew();
  hold.release("drop");
  hold.renew();
  hold.renew();
  assert.equal(calls.begin, 2);
  assert.equal(calls.end, 1);
  assert.equal(hold.held, true);
});

test("다시 건 뒤 지난 타이머가 늦게 불려도 놓지 않는다", () => {
  const calls = { end: 0 };
  const fns = [];
  const hold = new IdleHold({ begin: () => {}, end: () => calls.end++, setTimer: (fn) => (fns.push(fn), fns.length), clearTimer: () => {}, ms: 10 });
  hold.renew();
  hold.renew();
  fns[0]();
  assert.equal(calls.end, 0, "지난 타이머는 무시");
  fns[1]();
  assert.equal(calls.end, 1);
});

test("ms가 함수면 renew할 때마다 읽는다", () => {
  let ms = 100;
  const seen = [];
  const hold = new IdleHold({ begin: () => {}, end: () => {}, setTimer: (_fn, t) => seen.push(t), clearTimer: () => {}, ms: () => ms });
  hold.renew();
  ms = 200;
  hold.renew();
  assert.deepEqual(seen, [100, 200]);
});
