// 반복 작업(#138)의 상태 전이와 확인 응답 해석.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRunResult,
  beginRun,
  checkPrompt,
  claimContinue,
  defaultMaxRuns,
  endReason,
  followUpText,
  newRepeatTask,
  normalizeRepeatArgs,
  parseVerdict,
  pauseTask,
  resumeTask,
  MAX_ACTIVE_REPEAT_TASKS,
  REPEAT_FAILURE_LIMIT,
  REPEAT_RUN_STALE_MS,
  REPEAT_TRIGGER_STALE_MS,
} from "../src/lib/repeatTask.ts";

const H = 3_600_000;
const args = { title: "예매 확인", url: "https://tickets.example.com/show/1", check: "예매하기 버튼이 활성화됨", then: "R석 2장 예약", intervalMinutes: 10 };

function task(now = 0, over = {}) {
  return newRepeatTask(normalizeRepeatArgs({ ...args, ...over }), { id: "r1", now, request: "10분마다 확인해 줘" });
}

function started(t, now = 1000) {
  const r = beginRun(t, "tok", now);
  assert.equal(r.kind, "start");
  return r.task;
}

test("인자: 기본 기간 24시간, 기본 최대 횟수는 기간/간격(500 이하), 주소는 http(s)만", () => {
  const a = normalizeRepeatArgs(args);
  assert.equal(a.endsInHours, 24);
  assert.equal(a.maxRuns, 144);
  assert.equal(defaultMaxRuns(1, 168), 500);
  assert.equal(normalizeRepeatArgs({ ...args, maxRuns: 3 }).maxRuns, 3);
  assert.throws(() => normalizeRepeatArgs({ ...args, url: "javascript:alert(1)" }));
  assert.throws(() => normalizeRepeatArgs({ ...args, url: "https://user:pw@example.com/" }));
  assert.throws(() => normalizeRepeatArgs({ ...args, url: "https://example.com/\n" }));
});

test("끝 조건: 기간이 지나거나 횟수를 채우면 확인하지 않고 done", () => {
  const t = task(0);
  assert.equal(endReason(t, 24 * H - 1), null);
  assert.match(endReason(t, 24 * H), /기간/);
  const r = beginRun(t, "tok", 24 * H);
  assert.equal(r.kind, "finish");
  assert.equal(r.task.status, "done");
  const full = { ...t, attempts: t.maxRuns };
  assert.equal(beginRun(full, "tok", 1).kind, "finish");
});

test("시작: 시도 수를 올리고, 진행 중이면 건너뛰며, 오래된 실행은 끝난 것으로 본다", () => {
  const t = started(task());
  assert.equal(t.attempts, 1);
  assert.equal(beginRun(t, "tok2", 2000).kind, "skip");
  assert.equal(beginRun(t, "tok2", 1000 + REPEAT_RUN_STALE_MS).kind, "start");
  assert.equal(beginRun(pauseTask(task()), "tok", 1).kind, "skip");
});

test("결과: met → triggered, unmet → 계속, blocked·login_required → 멈춤", () => {
  const t = started(task());
  const at = 2000;
  assert.equal(applyRunResult(t, "tok", { at, verdict: "met", reason: "열림" }, at).status, "triggered");
  const unmet = applyRunResult(t, "tok", { at, verdict: "unmet", reason: "아직" }, at);
  assert.equal(unmet.status, "active");
  assert.equal(unmet.run, null);
  assert.equal(unmet.history.length, 1);
  assert.equal(applyRunResult(t, "tok", { at, verdict: "blocked", reason: "" }, at).status, "paused");
  assert.match(applyRunResult(t, "tok", { at, verdict: "login_required", reason: "" }, at).note, /로그인/);
});

test("결과: 연속 실패가 한도면 멈추고, unmet이면 실패 수를 0으로", () => {
  let t = task();
  for (let i = 0; i < REPEAT_FAILURE_LIMIT; i++) {
    t = applyRunResult(started(t, 1000 + i * REPEAT_RUN_STALE_MS), "tok", { at: 1, verdict: "error", reason: "x" }, 1);
  }
  assert.equal(t.status, "paused");
  let u = applyRunResult(started(task()), "tok", { at: 1, verdict: "unknown", reason: "" }, 1);
  assert.equal(u.failures, 1);
  u = applyRunResult(started(u, 1000 + REPEAT_RUN_STALE_MS), "tok", { at: 1, verdict: "unmet", reason: "" }, 1);
  assert.equal(u.failures, 0);
});

test("결과: 마지막 시도였으면 done, 기간이 지난 뒤 끝난 확인은 met이어도 done, 다른 실행·멈춤·지우기 뒤의 늦은 결과는 버린다", () => {
  const last = started({ ...task(), maxRuns: 1 });
  assert.equal(applyRunResult(last, "tok", { at: 1, verdict: "unmet", reason: "" }, 1).status, "done");
  const late = applyRunResult(started(task()), "tok", { at: 1, verdict: "met", reason: "" }, 24 * H);
  assert.equal(late.status, "done");
  assert.equal(late.triggeredAt, null);
  const t = started(task());
  assert.equal(applyRunResult(t, "other", { at: 1, verdict: "met", reason: "" }, 1), null);
  assert.equal(applyRunResult(pauseTask(t), "tok", { at: 1, verdict: "met", reason: "" }, 1), null);
});

test("다시 시작: 끝 조건과 동시 한도를 다시 본다", () => {
  const p = pauseTask(task());
  assert.equal(resumeTask(p, 1, 0).task.status, "active");
  assert.ok("error" in resumeTask(p, 1, MAX_ACTIVE_REPEAT_TASKS));
  assert.ok("error" in resumeTask(p, 25 * H, 0));
  assert.ok("error" in resumeTask(task(), 1, 0));
});

test("이어서 진행: 조건이 맞은 작업만 한 번, 오래된 결과는 진행하지 않는다", () => {
  const trig = applyRunResult(started(task()), "tok", { at: 5, verdict: "met", reason: "" }, 5);
  const c = claimContinue(trig, 10);
  assert.ok(c.ok);
  assert.equal(c.task.status, "started");
  assert.equal(claimContinue(c.task, 11).ok, false);
  assert.equal(claimContinue(task(), 10).ok, false);
  const stale = claimContinue(trig, 5 + REPEAT_TRIGGER_STALE_MS + 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.task.status, "paused");
});

test("응답 해석: 형태가 맞을 때만, 아니면 unknown", () => {
  assert.deepEqual(parseVerdict('{"verdict":"met","reason":"버튼이 열림"}'), { verdict: "met", reason: "버튼이 열림" });
  assert.equal(parseVerdict('결과: {"verdict":"unmet","reason":"아직 {준비} 중"} 끝').verdict, "unmet");
  assert.equal(parseVerdict('{"verdict":"MET"}').verdict, "unknown");
  assert.equal(parseVerdict('{"verdict":"met"').verdict, "unknown");
  assert.equal(parseVerdict("").verdict, "unknown");
  assert.equal(parseVerdict('["met"]').verdict, "unknown");
  assert.equal(parseVerdict('{"verdict":true}').verdict, "unknown");
  assert.equal(parseVerdict('{"verdict":"met","reason":123}').verdict, "unknown");
  assert.equal(parseVerdict('{"verdict":"met"}').verdict, "unknown");
  assert.equal(parseVerdict('{"verdict":"met","reason":"","extra":1}').verdict, "unknown");
  assert.equal(parseVerdict(`{"verdict":"unmet","reason":"${"가".repeat(500)}"}`).reason.length, 200);
});

test("이어서 진행 글은 저장된 작업 내용으로만 만든다", () => {
  const t = task();
  const text = followUpText(t);
  assert.ok(text.includes(t.then) && text.includes(t.check) && text.includes(t.url));
  const p = checkPrompt(t, { title: 'A"B', url: t.url, text: "본문", clickables: [{ text: "예매하기", role: "button", states: { disabled: "true" } }, { text: "", role: "link" }] });
  assert.ok(p.includes("조건: 예매하기 버튼이 활성화됨"));
  assert.ok(p.includes("- [button] 예매하기 (disabled=true)"));
  assert.ok(p.includes("title=\"A'B\""));
});
