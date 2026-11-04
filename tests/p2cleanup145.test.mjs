// #145: 반복 작업 버튼 역할, 이어서 진행의 취소·탭 정리, MCP 작업 기록의 한 번 저장.
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotRole } from "../src/lib/repeatTask.ts";
import { runContinue } from "../src/lib/repeatContinue.ts";
import { finishJob, recoverJob, INTERRUPTED_TEXT } from "../src/lib/mcpJobState.ts";

test("snapshotRole: 명시 role·칸 종류는 그대로, 없으면 a·area는 link, 그 밖은 button", () => {
  assert.equal(snapshotRole("button", ""), "button");
  assert.equal(snapshotRole("input", ""), "button");
  assert.equal(snapshotRole("a", ""), "link");
  assert.equal(snapshotRole("area", ""), "link");
  assert.equal(snapshotRole("div", "tab"), "tab");
  assert.equal(snapshotRole("input", "checkbox"), "checkbox");
});

function deps(over = {}) {
  const calls = [];
  const d = {
    cancelled: () => false,
    openTab: async () => (calls.push("open"), 42),
    closeTab: async (id) => void calls.push(`close:${id}`),
    verify: async () => void calls.push("verify"),
    focus: async () => void calls.push("focus"),
    handOver: (id) => void calls.push(`hand:${id}`),
    release: async () => void calls.push("release"),
    ...over,
  };
  return { d, calls };
}

test("runContinue: 정상이면 열고·검증·포커스·넘김, 닫거나 되돌리지 않음", async () => {
  const { d, calls } = deps();
  assert.equal(await runContinue(d), "started");
  assert.deepEqual(calls, ["open", "focus", "verify", "hand:42"]);
});

test("runContinue: 열기 전 취소 → 탭 없이 되돌림", async () => {
  const { d, calls } = deps({ cancelled: () => true });
  assert.equal(await runContinue(d), "cancelled");
  assert.deepEqual(calls, ["release"]);
});

test("runContinue: 탭을 여는 동안 취소 → 연 탭을 닫고 되돌림, 넘기지 않음", async () => {
  let cancel = false;
  const { d, calls } = deps({
    cancelled: () => cancel,
    openTab: async () => {
      calls.push("open");
      cancel = true;
      return 7;
    },
  });
  assert.equal(await runContinue(d), "cancelled");
  assert.deepEqual(calls, ["open", "close:7", "release"]);
});

test("runContinue: 포커스를 기다리는 동안 취소 → 검증·넘기기 없이 탭을 닫음", async () => {
  let cancel = false;
  const { d, calls } = deps({
    cancelled: () => cancel,
    focus: async () => {
      calls.push("focus");
      await new Promise((r) => setTimeout(r, 5));
      cancel = true;
    },
  });
  assert.equal(await runContinue(d), "cancelled");
  assert.deepEqual(calls, ["open", "focus", "close:42", "release"]);
});

test("runContinue: 포커스를 기다리는 동안 작업을 지움 → 그 뒤 검증에서 걸려 넘기지 않음", async () => {
  let deleted = false;
  const { d, calls } = deps({
    focus: async () => {
      calls.push("focus");
      await new Promise((r) => setTimeout(r, 5));
      deleted = true;
    },
    verify: async () => {
      calls.push("verify");
      if (deleted) throw new Error("지워짐");
    },
  });
  await assert.rejects(runContinue(d), /지워짐/);
  assert.deepEqual(calls, ["open", "focus", "verify", "close:42", "release"]);
});

test("runContinue: 검증 실패(작업 지움) → 탭을 닫고 되돌린 뒤 오류", async () => {
  const { d, calls } = deps({
    verify: async () => {
      calls.push("verify");
      throw new Error("지워짐");
    },
  });
  await assert.rejects(runContinue(d), /지워짐/);
  assert.deepEqual(calls, ["open", "focus", "verify", "close:42", "release"]);
});

test("runContinue: 넘기기 실패(포트 전송 실패) → 탭을 닫고 되돌린 뒤 오류", async () => {
  const { d, calls } = deps({
    handOver: () => {
      calls.push("hand");
      throw new Error("port closed");
    },
  });
  await assert.rejects(runContinue(d), /port closed/);
  assert.deepEqual(calls, ["open", "focus", "verify", "hand", "close:42", "release"]);
});

const base = { enabled: true, seen: [] };
const p = { bridgeId: "b1", jobId: "j1", outcome: "ok", text: "답" };

test("finishJob: 그 작업의 기록을 지우고 결과를 한 번에 남긴다(다른 작업 기록은 그대로)", () => {
  assert.deepEqual(finishJob({ ...base, job: { bridgeId: "b1", jobId: "j1" }, pending: null }, "j1", p), { ...base, job: null, pending: p });
  const other = { bridgeId: "b1", jobId: "j2" };
  assert.deepEqual(finishJob({ ...base, job: other, pending: null }, "j1", p), { ...base, job: other, pending: p });
});

test("recoverJob: 맡고 있지 않은 이 다리의 기록만 중단 결과로 바꾼다", () => {
  const st = { ...base, job: { bridgeId: "b1", jobId: "j1" }, pending: null };
  assert.deepEqual(recoverJob(st, "b1", new Set()), { ...base, job: null, pending: { bridgeId: "b1", jobId: "j1", outcome: "error", text: INTERRUPTED_TEXT } });
  // 실행 중이거나 결과를 준비 중인 작업은 건드리지 않는다.
  assert.equal(recoverJob(st, "b1", new Set(["j1"])), null);
  // 다른 다리의 기록·기록 없음.
  assert.equal(recoverJob(st, "b2", new Set()), null);
  assert.equal(recoverJob({ ...base, job: null, pending: p }, "b1", new Set()), null);
});
