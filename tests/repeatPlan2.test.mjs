// 반복 작업 확인 작전(#284 2단계): 변화 없으면 생략, 검산 회차, 연속 안 맞음·검산 불일치·확인 불일치 뒤 자동으로 다시 만들기,
// 다시 만들기 한도(포기), 작전 이벤트(고정 사유 코드, 최근 20개), 1단계 ready의 기본값 정규화.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_EVENTS,
  PLAN_MAX_BUILDS,
  PLAN_MISS_LIMIT,
  PLAN_VERIFY_EVERY,
  PLAN_VERIFY_MS,
  SKIP_REASON,
  clearPlan,
  makePlan,
  missRegen,
  normalizePlanEvents,
  normalizePlanState,
  observationHash,
  parsePlan,
  planEffect,
  planKey,
  pushPlanEvent,
  readyState,
  regionObservation,
  regionRoundOutcome,
  requestPlan,
  roundMode,
  roundsToVerify,
  shouldSkip,
} from "../src/lib/repeatPlan.ts";
import { applyRunResult, beginRun, newRepeatTask, normalizeRepeatArgs, normalizeTask } from "../src/lib/repeatTask.ts";

const H = 3_600_000;
const args = { title: "예매 확인", url: "https://tickets.example.com/show/1", check: "예매하기 버튼이 활성화됨", then: "R석 2장 예약", intervalMinutes: 10 };
const task = (over = {}) => ({ ...newRepeatTask(normalizeRepeatArgs(args), { id: "r1", now: 0, request: "확인해 줘" }), ...over });
const draft = () =>
  parsePlan(
    JSON.stringify({
      region: { selector: "section#tickets", anchor: { text: "예매 현황", where: "heading" }, shape: "제목과 버튼" },
      criteria: "예매하기 버튼이 disabled가 아니면 조건 맞음",
      pageOnly: true,
      mismatch: "제목이 없음",
    }),
  ).draft;
const shape = { tag: "section", role: "", skeleton: "abc12345" };
const plan = (over = {}) => ({ ...makePlan(draft(), { id: "p1", now: 5, shape, fullChars: 5000, regionChars: 20 }), ...over });
const probe = (over = {}) => ({ found: true, text: "예매 현황 오픈 예정 예매하기", cut: false, shape, clickables: [{ text: "예매하기", role: "button", states: { disabled: "true" } }], ...over });
const ready = (over = {}, p = plan()) => ({ ...readyState(p, 100), ...over });
const withReady = (st, over = {}) => task({ plan: st, ...over });
const HASH = "a".repeat(64);
const effect = (t, outcome, now = 1000) => planEffect(t, planKey(t.plan), outcome, now);
const kinds = (t) => t.planEvents.map((e) => e.kind);

test("상수: 검산 10회차·6시간, 연속 안 맞음 2, 다시 만들기 3, 이벤트 20", () => {
  assert.equal(PLAN_VERIFY_EVERY, 10);
  assert.equal(PLAN_VERIFY_MS, 6 * H);
  assert.equal(PLAN_MISS_LIMIT, 2);
  assert.equal(PLAN_MAX_BUILDS, 3);
  assert.equal(PLAN_EVENTS, 20);
});

test("readyState: 새 작전은 안 맞음 0, 해시 없음, 전체 판단 뒤 0회차, 마지막 전체 판단 = 지금, 생략 0", () => {
  assert.deepEqual(readyState(plan(), 77), { state: "ready", plan: plan(), misses: 0, lastUnmetHash: null, sinceFull: 0, lastFullAt: 77, skips: 0 });
});

test("normalizePlanState: 1단계에 저장된 ready(추가 필드 없음)는 기본값(lastFullAt = 작전 만든 때)", () => {
  const p = plan({ createdAt: 4242 });
  assert.deepEqual(normalizePlanState({ state: "ready", plan: p }, false), { state: "ready", plan: p, misses: 0, lastUnmetHash: null, sinceFull: 0, lastFullAt: 4242, skips: 0 });
  // 맞는 값은 그대로, 틀린 값은 기본값으로.
  const st = { state: "ready", plan: p, misses: 1, lastUnmetHash: HASH, sinceFull: 4, lastFullAt: 9000, skips: 3 };
  assert.deepEqual(normalizePlanState(st, false), st);
  const bad = normalizePlanState({ ...st, misses: -1, lastUnmetHash: "x", sinceFull: "9", lastFullAt: null, skips: NaN }, false);
  assert.deepEqual(bad, { state: "ready", plan: p, misses: 0, lastUnmetHash: null, sinceFull: 0, lastFullAt: 4242, skips: 0 });
  // 해시는 소문자 16진 64자만.
  assert.equal(normalizePlanState({ ...st, lastUnmetHash: "A".repeat(64) }, false).lastUnmetHash, null);
});

test("normalizeTask: planEvents가 없으면 [], 모르는 종류·사유는 버리고 최근 20개만", () => {
  const t = task();
  assert.deepEqual(t.planEvents, []);
  const { planEvents, ...old } = t;
  assert.deepEqual(normalizeTask(old).planEvents, []);
  const many = Array.from({ length: 30 }, (_, i) => ({ at: i, kind: "miss", why: "no_match" }));
  const n = normalizeTask({ ...t, planEvents: [...many, { at: 99, kind: "evil", why: "x" }, { at: 100, kind: "miss", why: "모델 글자" }, "x"] });
  assert.equal(n.planEvents.length, PLAN_EVENTS);
  assert.deepEqual(n.planEvents.at(-1), { at: 100, kind: "miss" }, "모르는 사유 코드는 버림");
  assert.ok(n.planEvents.every((e) => e.kind === "miss"));
  assert.deepEqual(normalizePlanEvents("x"), []);
});

test("pushPlanEvent: 최근 20개, 이어진 생략은 한 줄로 합쳐 횟수를 센다", () => {
  let list = [];
  for (let i = 0; i < 25; i++) list = pushPlanEvent(list, { at: i, kind: "miss", why: "no_match" });
  assert.equal(list.length, PLAN_EVENTS);
  assert.equal(list[0].at, 5);
  list = pushPlanEvent(list, { at: 30, kind: "skip" });
  list = pushPlanEvent(list, { at: 31, kind: "skip" });
  list = pushPlanEvent(list, { at: 32, kind: "skip" });
  assert.equal(list.length, PLAN_EVENTS);
  assert.deepEqual(list.at(-1), { at: 32, kind: "skip", n: 3 });
});

test("roundMode: ready가 아니면 full, sinceFull 9 이상이거나 6시간이 지나면 verify, 아니면 region(경계)", () => {
  assert.equal(roundMode({ state: "pending", tries: 0, gen: "g" }, 0), "full");
  assert.equal(roundMode({ state: "none", why: "x", at: 0 }, 0), "full");
  assert.equal(roundMode({ state: "cleared", at: 0 }, 0), "full");
  assert.equal(roundMode(ready({ sinceFull: 8, lastFullAt: 0 }), PLAN_VERIFY_MS - 1), "region");
  assert.equal(roundMode(ready({ sinceFull: 9, lastFullAt: 0 }), 1), "verify");
  assert.equal(roundMode(ready({ sinceFull: 0, lastFullAt: 0 }), PLAN_VERIFY_MS), "verify");
  assert.equal(roundMode(ready({ sinceFull: 0, lastFullAt: 0 }), PLAN_VERIFY_MS - 1), "region");
  assert.equal(roundsToVerify(ready({ sinceFull: 0 })), 10);
  assert.equal(roundsToVerify(ready({ sinceFull: 9 })), 1);
  assert.equal(roundsToVerify(ready({ sinceFull: 15 })), 1);
});

test("observationHash: SHA-256 16진 64자, 관측 전체(제목·주소·글자·버튼 상태)를 본다", async () => {
  const p = plan();
  const base = await observationHash(regionObservation({ title: "공연", url: "https://a.example/1" }, p, probe()));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, await observationHash(regionObservation({ title: "공연", url: "https://a.example/1" }, p, probe())));
  assert.notEqual(base, await observationHash(regionObservation({ title: "공연 열림", url: "https://a.example/1" }, p, probe())), "제목만");
  assert.notEqual(base, await observationHash(regionObservation({ title: "공연", url: "https://a.example/1" }, p, probe({ clickables: [{ text: "예매하기", role: "button" }] }))), "disabled만");
});

test("shouldSkip: region 회차·pageOnly·영역 맞음·직전 unmet 해시와 같을 때만", async () => {
  const p = plan();
  const obs = (over = {}, page = { title: "공연", url: "https://a.example/1" }) => regionObservation(page, p, probe(over));
  const h = await observationHash(obs());
  const st = ready({ lastUnmetHash: h });
  assert.equal(shouldSkip(st, "region", probe(), h), true, "모두 맞음");
  assert.equal(shouldSkip(st, "verify", probe(), h), false, "검산 회차");
  assert.equal(shouldSkip(ready({ lastUnmetHash: null }), "region", probe(), h), false, "해시 없음(새 작전·전체 판단 뒤)");
  assert.equal(shouldSkip(ready({ lastUnmetHash: h }, plan({ pageOnly: false })), "region", probe(), h), false, "pageOnly false");
  assert.equal(shouldSkip(st, "region", probe({ shape: { ...shape, skeleton: "zz" } }), h), false, "모양 다름");
  assert.equal(shouldSkip(st, "region", probe({ cut: true }), h), false, "잘림");
  assert.equal(shouldSkip(st, "region", { found: false, why: "no_match" }, h), false, "못 찾음");
  assert.equal(shouldSkip(st, "region", undefined, h), false);
  assert.equal(shouldSkip(st, "region", probe(), null), false, "해시를 못 냄");
  // 제목만 바뀜·disabled만 풀림 → 해시가 달라 생략하지 않는다.
  assert.equal(shouldSkip(st, "region", probe(), await observationHash(obs({}, { title: "공연(열림)", url: "https://a.example/1" }))), false, "제목만 바뀜");
  assert.equal(shouldSkip(st, "region", probe(), await observationHash(obs({ clickables: [{ text: "예매하기", role: "button" }] }))), false, "disabled만 풀림");
});

test("planEffect region·skip: unmet 확정은 해시를 남기고 안 맞음 0, 생략은 해시 유지·생략 수·회차 수만", () => {
  let t = withReady(ready({ misses: 1, sinceFull: 2 }));
  t = effect(t, { kind: "region", hash: HASH });
  assert.equal(t.plan.misses, 0);
  assert.equal(t.plan.lastUnmetHash, HASH);
  assert.equal(t.plan.sinceFull, 3);
  assert.equal(t.plan.lastFullAt, 100, "영역만 본 회차는 전체 판단 시각을 바꾸지 않음");
  t = effect(t, { kind: "skip" });
  t = effect(t, { kind: "skip" });
  assert.equal(t.plan.lastUnmetHash, HASH);
  assert.equal(t.plan.sinceFull, 5);
  assert.equal(t.plan.skips, 2);
  assert.deepEqual(t.planEvents.at(-1), { at: 1000, kind: "skip", n: 2 });
});

test("생략 회차: unmet·mode skip·sent 0으로 기록되고 실패 수를 0으로, 회차(attempts)로 센다", () => {
  const t0 = withReady(ready({ lastUnmetHash: HASH }), { failures: 2 });
  const run = beginRun(t0, "tok", 10).task;
  assert.equal(run.attempts, 1);
  const r = applyRunResult(run, "tok", { at: 11, verdict: "unmet", reason: SKIP_REASON, mode: "skip", sent: 0 }, 11);
  assert.equal(r.failures, 0);
  assert.equal(r.lastCheck.mode, "skip");
  assert.equal(r.lastCheck.sent, 0);
  assert.equal(r.history.at(-1).mode, "skip");
  // maxRuns에 닿으면 생략 회차여도 끝난다.
  const last = beginRun(withReady(ready(), { maxRuns: 1 }), "tok", 10).task;
  assert.equal(applyRunResult(last, "tok", { at: 11, verdict: "unmet", reason: SKIP_REASON, mode: "skip", sent: 0 }, 11).status, "done");
});

test("planEffect: 전체 판단이 든 회차는 sinceFull 0·lastFullAt 지금·해시 없음(확인·검산·안 맞음·시간 부족·영역 호출 실패)", () => {
  const outcomes = [
    { kind: "confirm", region: "met", full: "met" },
    { kind: "verify", region: "unmet", full: "unmet" },
    { kind: "mismatch", why: "no_match" },
    { kind: "budget" },
    { kind: "region_error" },
    { kind: "off_plan", full: "unmet" },
  ];
  for (const o of outcomes) {
    const t = effect(withReady(ready({ sinceFull: 5, lastUnmetHash: HASH })), o, 5000);
    assert.equal(t.plan.state, "ready", o.kind);
    assert.equal(t.plan.sinceFull, 0, o.kind);
    assert.equal(t.plan.lastFullAt, 5000, o.kind);
    assert.equal(t.plan.lastUnmetHash, null, o.kind);
  }
  // 영역 호출 실패는 안 맞음으로 세지 않는다(1단계 규칙).
  assert.equal(effect(withReady(ready({ misses: 1 })), { kind: "region_error" }).plan.misses, 1);
  assert.equal(kinds(effect(withReady(ready()), { kind: "region_error" })).at(-1), "fallback");
});

test("planEffect 안 맞음: 못 찾음·모양·off_plan·모호·숨김·프레임·잘림은 misses+1, 한 번은 그대로, 두 번째는 pending(regen)", () => {
  for (const why of ["no_match", "anchor_missing", "shape", "ambiguous", "hidden", "frame", "cut"]) {
    const once = effect(withReady(ready()), { kind: "mismatch", why });
    assert.equal(once.plan.state, "ready", why);
    assert.equal(once.plan.misses, 1, why);
    assert.deepEqual(once.planEvents.at(-1), { at: 1000, kind: "miss", why }, why);
    const twice = effect(once, { kind: "mismatch", why });
    assert.deepEqual(twice.plan, { state: "pending", tries: 0, gen: "regen:p1" }, why);
    assert.deepEqual(kinds(twice).slice(-2), ["miss", "regen"], why);
    assert.equal(twice.planEvents.at(-1).why, "misses");
  }
  const off = effect(effect(withReady(ready()), { kind: "off_plan", full: "unmet" }), { kind: "off_plan", full: "met" });
  assert.equal(off.plan.state, "pending", "off_plan 두 번");
  // 영역 판단이 성공하면 0으로 돌아가 다시 센다.
  const reset = effect(effect(effect(withReady(ready()), { kind: "mismatch", why: "no_match" }), { kind: "region", hash: HASH }), { kind: "mismatch", why: "no_match" });
  assert.equal(reset.plan.state, "ready");
  assert.equal(reset.plan.misses, 1);
});

test("planEffect 확인 불일치: 영역 met + 전체 unmet은 바로 pending(confirm_diff), 같으면 misses 0", () => {
  const diff = effect(withReady(ready()), { kind: "confirm", region: "met", full: "unmet" });
  assert.equal(diff.plan.state, "pending");
  assert.deepEqual(kinds(diff).slice(-2), ["confirm_diff", "regen"]);
  const same = effect(withReady(ready({ misses: 1 })), { kind: "confirm", region: "met", full: "met" });
  assert.equal(same.plan.state, "ready");
  assert.equal(same.plan.misses, 0);
  // 영역이 판단하지 못한 회차(blocked·unknown인데 전체는 met/unmet)는 안 맞음으로 센다.
  const unsure = effect(withReady(ready()), { kind: "confirm", region: "unknown", full: "unmet" });
  assert.equal(unsure.plan.misses, 1);
  // 전체 판단도 판단하지 못했으면(blocked 등) 작전 탓으로 보지 않는다.
  assert.equal(effect(withReady(ready({ misses: 1 })), { kind: "confirm", region: "met", full: "blocked" }).plan.misses, 1);
});

test("planEffect 검산: 같으면 verify_same(misses 0), 다르면 verify_diff 뒤 바로 pending, 전체가 판단 못 하면 그대로", () => {
  const same = effect(withReady(ready({ misses: 1, sinceFull: 9 })), { kind: "verify", region: "unmet", full: "unmet" }, 7000);
  assert.equal(same.plan.state, "ready");
  assert.equal(same.plan.misses, 0);
  assert.equal(same.plan.sinceFull, 0);
  assert.equal(same.plan.lastFullAt, 7000);
  assert.equal(kinds(same).at(-1), "verify_same");
  for (const [region, full] of [["unmet", "met"], ["met", "unmet"], ["blocked", "unmet"]]) {
    const diff = effect(withReady(ready({ sinceFull: 9 })), { kind: "verify", region, full });
    assert.equal(diff.plan.state, "pending", `${region}/${full}`);
    assert.deepEqual(kinds(diff).slice(-2), ["verify_diff", "regen"]);
    assert.equal(diff.planEvents.at(-1).why, "verify_diff");
  }
  const open = effect(withReady(ready({ sinceFull: 9 })), { kind: "verify", region: "unmet", full: "blocked" });
  assert.equal(open.plan.state, "ready");
  assert.equal(open.plan.sinceFull, 0);
});

test("missRegen: 이번 안 맞음으로 다시 만들 차례이고 한도 안이면 true", () => {
  assert.equal(missRegen(ready({ misses: 0 }), 0), false);
  assert.equal(missRegen(ready({ misses: 1 }), 0), true);
  assert.equal(missRegen(ready({ misses: 1 }), PLAN_MAX_BUILDS - 1), true);
  assert.equal(missRegen(ready({ misses: 1 }), PLAN_MAX_BUILDS), false, "한도면 포기(만들지 않음)");
  assert.equal(missRegen({ state: "pending", tries: 0, gen: "g" }, 0), false);
});

test("planEffect 같은 회차 다시 만들기: 두 번째 안 맞음 + build(made)면 새 작전 ready, planBuilds+1, 이벤트 regen → made", () => {
  const t = withReady(ready({ misses: 1 }), { planBuilds: 1 });
  const fresh = plan({ id: "p2" });
  const r = effect(t, { kind: "mismatch", why: "no_match", build: { kind: "made", plan: fresh } }, 3000);
  assert.deepEqual(r.plan, readyState(fresh, 3000));
  assert.equal(r.planBuilds, 2);
  assert.deepEqual(kinds(r).slice(-3), ["miss", "regen", "made"]);
  // 만들기 실패면 pending(tries 1)로 남는다.
  const f = effect(t, { kind: "mismatch", why: "no_match", build: { kind: "plan_failed", why: "schema" } });
  assert.deepEqual(f.plan, { state: "pending", tries: 1, gen: "regen:p1" });
  assert.equal(f.planEvents.at(-1).kind, "plan_failed");
  // 첫 번째 안 맞음에 온 build는 쓰지 않는다(다시 만들 차례가 아님).
  const early = effect(withReady(ready()), { kind: "mismatch", why: "no_match", build: { kind: "made", plan: fresh } });
  assert.equal(early.plan.plan.id, "p1");
});

test("다시 만들기 한도: planBuilds 3에서 다시 만들어야 하면 none(gave_up, 고정 사유), cleared는 다시 만들지 않음", () => {
  const t = withReady(ready({ misses: 1 }), { planBuilds: PLAN_MAX_BUILDS });
  const g = effect(t, { kind: "mismatch", why: "shape" });
  assert.equal(g.plan.state, "none");
  assert.match(g.plan.why, /여러 번 다시 만들어도/);
  assert.deepEqual(g.planEvents.at(-1), { at: 1000, kind: "gave_up", why: "builds" });
  const g2 = effect(withReady(ready(), { planBuilds: PLAN_MAX_BUILDS }), { kind: "verify", region: "unmet", full: "met" });
  assert.equal(g2.plan.state, "none");
  // 포기한 뒤 build가 와도 쓰지 않는다.
  const g3 = effect(t, { kind: "mismatch", why: "shape", build: { kind: "made", plan: plan({ id: "p9" }) } });
  assert.equal(g3.plan.state, "none");
  // cleared는 어떤 결과로도 바뀌지 않는다.
  const c = task({ plan: { state: "cleared", at: 1 } });
  for (const o of [{ kind: "mismatch", why: "no_match" }, { kind: "verify", region: "met", full: "unmet" }, { kind: "made", plan: plan() }]) assert.deepEqual(effect(c, o), c);
});

test("작전 만들기(사용자): 포기한 작업도 pending으로, planBuilds 0, requested 이벤트. 지우기는 cleared 이벤트", () => {
  const gave = { ...task(), plan: { state: "none", why: "포기", at: 1 }, planBuilds: PLAN_MAX_BUILDS };
  const m = requestPlan(gave, "g9");
  assert.deepEqual(m.plan, { state: "pending", tries: 0, gen: "g9" });
  assert.equal(m.planBuilds, 0);
  assert.equal(m.planEvents.at(-1).kind, "requested");
  const c = clearPlan(withReady(ready()), 5);
  assert.equal(c.planEvents.at(-1).kind, "cleared");
});

test("planEffect: 시작 때와 작전이 다르면(그 사이 지우기·만들기) 2단계 결과도 버린다", () => {
  const t = withReady(ready({ misses: 1 }));
  const key = planKey(t.plan);
  const cleared = clearPlan(t, 5);
  assert.deepEqual(planEffect(cleared, key, { kind: "mismatch", why: "no_match" }, 6), cleared);
  const remade = requestPlan(cleared, "g2");
  assert.deepEqual(planEffect(remade, key, { kind: "verify", region: "met", full: "unmet" }, 6), remade);
});

test("planEffect 새 작전: made는 readyState(지금)로, made·plan_failed·plan_none 이벤트는 고정 코드만(모델 글자 없음)", () => {
  const t = task();
  const made = effect(t, { kind: "made", plan: plan() }, 400);
  assert.deepEqual(made.plan, readyState(plan(), 400));
  assert.deepEqual(made.planEvents.at(-1), { at: 400, kind: "made" });
  const none = effect(task(), { kind: "plan_none", why: "모델이 쓴 이유 글" });
  assert.deepEqual(none.planEvents.at(-1), { at: 1000, kind: "plan_none" });
  const failed = effect(task(), { kind: "plan_failed", why: "timeout" });
  assert.deepEqual(failed.planEvents.at(-1), { at: 1000, kind: "plan_failed", why: "timeout" });
});

test("regionRoundOutcome(리뷰 P2): 검산 회차의 off_plan은 검산 불일치(→ verify_diff·pending), 일반 회차는 안 맞음", () => {
  const f = (verdict) => ({ verdict, reason: "x" });
  const r = (verdict) => ({ verdict, reason: "x" });
  assert.deepEqual(regionRoundOutcome("verify", r("off_plan"), f("unmet")), { kind: "verify", region: "off_plan", full: "unmet" });
  assert.deepEqual(regionRoundOutcome("verify", r("met"), f("unmet")), { kind: "verify", region: "met", full: "unmet" });
  assert.deepEqual(regionRoundOutcome("verify", null, f("unmet")), { kind: "region_error" });
  assert.deepEqual(regionRoundOutcome("region", r("off_plan"), f("unmet")), { kind: "off_plan", full: "unmet" });
  assert.deepEqual(regionRoundOutcome("region", r("blocked"), f("unmet")), { kind: "confirm", region: "blocked", full: "unmet" });
  assert.deepEqual(regionRoundOutcome("region", null, f("met")), { kind: "region_error" });
  // 검산 off_plan + 전체 unmet → 바로 다시 만들 차례(한도면 포기).
  const t = withReady(ready({ sinceFull: 9 }));
  const d = effect(t, regionRoundOutcome("verify", r("off_plan"), f("unmet")));
  assert.equal(d.plan.state, "pending");
  assert.deepEqual(kinds(d).slice(-2), ["verify_diff", "regen"]);
  const g = effect(withReady(ready({ sinceFull: 9 }), { planBuilds: PLAN_MAX_BUILDS }), regionRoundOutcome("verify", r("off_plan"), f("met")));
  assert.equal(g.plan.state, "none");
  assert.equal(kinds(g).at(-1), "gave_up");
  // 전체도 판단하지 못한 화면이면 평가하지 않는다.
  assert.equal(effect(t, regionRoundOutcome("verify", r("off_plan"), f("blocked"))).plan.state, "ready");
});
