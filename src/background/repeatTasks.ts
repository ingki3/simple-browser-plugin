// 반복 작업(#138): 저장·알람·확인용 탭·확인(모델 판단)·이어서 진행. 상태 전이는 src/lib/repeatTask.ts.
// - 등록은 늘 승인 카드(agent/chatAgent.ts의 scheduleRepeat). 여기서는 승인된 작업만 받는다.
// - 확인은 패널 없이도 알람으로 돈다. 페이지 글자는 content의 watch_snapshot(modelText·findClickables — 입력값·편집 영역 제외,
//   #43)만 쓰고, 보내기 전에 자동 로그인 값을 가린다(가림 목록을 못 읽으면 보내지 않는다).
// - 조건이 맞으면 알리기만 한다. 다음 일은 사용자가 패널에서 "이어서 진행"을 눌러 새 대화로 시작한다(한 번만).
// - 확인 작전(#284, src/lib/repeatPlan.ts): 첫 unmet 회차에 모델이 볼 영역·판단 기준을 정하고, 그 뒤로는 영역 글자만 보낸다.
//   영역 판단은 unmet만 확정하고, 그 밖의 판정·호출 실패·영역이 안 맞으면 같은 회차에 전체 화면으로 판단한다(회차당 모델 2번까지).
//   2단계: 영역 관측이 직전 unmet과 같으면 생략(모델 0번), 10회차·6시간마다 검산(영역·전체), 연속 안 맞음·불일치 뒤 다시 만들기.
// - 한 회차는 시작부터 ROUND_DEADLINE_MS(170초) 안에 끝낸다(신호로 강제 — stale 인계 3분 전에).
import {
  REPEAT_CHECK_SYSTEM,
  REPEAT_MANUAL_GAP_MS,
  MAX_ACTIVE_REPEAT_TASKS,
  applyRunResult,
  beginRun,
  checkPrompt,
  claimContinue,
  followUpText,
  newRepeatTask,
  normalizeTask,
  parseVerdict,
  pauseTask,
  resumeTask,
  type RepeatArgs,
  type RepeatCheck,
  type RepeatSnapshot,
  type RepeatTask,
} from "@/lib/repeatTask";
import { sameSiteAs } from "@/lib/siteTrust";
import { httpOrigin } from "@/lib/url";
import { activeModel } from "@/lib/settings";
import { providerAdapter, providerTimeout } from "@/lib/providers";
import { beginTargetGuard } from "./modelTarget";
import { createSerial, withTimeout } from "@/lib/async";
import { runContinue } from "@/lib/repeatContinue";
import { getSettings } from "./storage";
import { maskMessagesForModel, maskStringForModel } from "./loginSecrets";
import { debugLog } from "./debug";
import { TargetChangedError } from "./modelTarget";
import { raceSignal } from "@/lib/async";
import type { ActiveModel } from "@/lib/settings";
import {
  capClickables,
  OUTLINE_MAX,
  REGION_CLICKABLES,
  REGION_MISSES,
  REGION_TEXT_MAX,
  REPEAT_PLAN_SYSTEM,
  REPEAT_REGION_SYSTEM,
  ROUND_DEADLINE_MS,
  SKIP_REASON,
  missRegen,
  observationHash,
  roundMode,
  shouldSkip,
  acceptProbe,
  clearPlan,
  makePlan,
  maskDraft,
  parsePlan,
  parseRegionVerdict,
  planBudget,
  planEffect,
  planKey,
  planPrompt,
  regionFit,
  regionObservation,
  regionPrompt,
  regionRoundOutcome,
  regionSpec,
  requestPlan,
  stepTimeout,
  type BuildOutcome,
  type OutlineItem,
  type PlanOutcome,
  type RegionMiss,
  type RegionProbe,
  type RegionSpec,
} from "@/lib/repeatPlan";

const STORE_KEY = "repeatTasks";
const ALARM_PREFIX = "repeat:";
const LOAD_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1500;
const SNAPSHOT_TIMEOUT_MS = 15_000;
// 서비스 워커는 fetch 응답을 30초 넘게 기다리면 내려갈 수 있다. 확인 요청은 짧은 답(JSON 한 줄)이라 그 안에 끝낸다.
const MODEL_TIMEOUT_MS = 25_000;
const SNAPSHOT_TEXT_MAX = 6000;
const SNAPSHOT_CLICKABLES = 80;
// 영역 확인 읽기 한 번에 드는 최대 시간(재시도 포함: 15 + 1 + 15초).
const READ_MS = SNAPSHOT_TIMEOUT_MS * 2 + 1000;
// 작전 만들기 응답 상한(작전 JSON 2,500자 안팎).
const PLAN_MAX_TOKENS = 900;

// ---- 저장(모든 변경은 한 줄로) ----

const serial = createSerial();

async function load(): Promise<RepeatTask[]> {
  const raw = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  // 작전 필드(#284)를 정규화한다: plan 키가 없는 옛 작업은 전체 판단 유지(none), 망가진 작전도 none.
  return Array.isArray(raw) ? raw.map(normalizeTask).filter((t): t is RepeatTask => t !== null) : [];
}

async function save(tasks: RepeatTask[]): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: tasks });
}

// 작업 하나를 바꾼다. fn이 null을 돌려주면 바꾸지 않는다.
function update(id: string, fn: (t: RepeatTask, all: RepeatTask[]) => RepeatTask | null): Promise<RepeatTask | null> {
  return serial(async () => {
    const all = await load();
    const i = all.findIndex((t) => t.id === id);
    if (i < 0) return null;
    const next = fn(all[i], all);
    if (!next) return null;
    all[i] = next;
    await save(all);
    return next;
  });
}

const activeCount = (all: RepeatTask[]) => all.filter((t) => t.status === "active").length;

// ---- 알림(새 권한 없이: 확장 아이콘 배지와 열린 패널) ----

const ports = new Set<chrome.runtime.Port>();
export function registerRepeatSink(port: chrome.runtime.Port): void {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
}

async function announce(): Promise<void> {
  const all = await load().catch(() => [] as RepeatTask[]);
  const waiting = all.filter((t) => t.status === "triggered").length;
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" }).catch(() => {});
  if (waiting) await chrome.action.setBadgeBackgroundColor({ color: "#d93025" }).catch(() => {});
  for (const p of ports) {
    try {
      p.postMessage({ kind: "repeat_update" });
    } catch {
      ports.delete(p);
    }
  }
}

// 조건이 맞았을 때 부를 함수(텔레그램 알림). 작업의 제목만 쓰게 하고, 확인 결과의 이유는 넘기지 않는다.
const triggerListeners: Array<(t: Pick<RepeatTask, "id" | "title">) => unknown> = [];
export function onRepeatTriggered(fn: (t: Pick<RepeatTask, "id" | "title">) => unknown): void {
  triggerListeners.push(fn);
}

// ---- 알람 ----

const alarmName = (id: string) => `${ALARM_PREFIX}${id}`;

async function arm(t: RepeatTask): Promise<void> {
  await chrome.alarms.create(alarmName(t.id), { periodInMinutes: Math.max(1, t.intervalMinutes), delayInMinutes: Math.max(1, t.intervalMinutes) });
}

async function disarm(id: string): Promise<void> {
  await chrome.alarms.clear(alarmName(id)).catch(() => false);
}

// 서비스 워커가 뜰 때마다: 켜진 작업의 알람이 없으면 다시 만들고, 켜지지 않은 작업의 알람은 지운다.
const recovered = (async () => {
  try {
    const all = await load();
    for (const t of all) {
      const has = await chrome.alarms.get(alarmName(t.id));
      if (t.status === "active" && !has) await arm(t);
      if (t.status !== "active" && has) await disarm(t.id);
    }
    const known = new Set(all.map((t) => alarmName(t.id)));
    for (const a of await chrome.alarms.getAll()) if (a.name.startsWith(ALARM_PREFIX) && !known.has(a.name)) await disarm(a.name.slice(ALARM_PREFIX.length));
    await announce();
  } catch (err) {
    debugLog("repeat:recover", err instanceof Error ? err.message : String(err), "warn");
  }
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  void recovered.then(() => runCheck(alarm.name.slice(ALARM_PREFIX.length)));
});

// ---- 등록·관리 ----

export async function registerRepeatTask(a: Required<RepeatArgs>, request: string): Promise<RepeatTask> {
  await recovered;
  const task = await serial(async () => {
    const all = await load();
    if (activeCount(all) >= MAX_ACTIVE_REPEAT_TASKS) throw new Error(`확인 중인 반복 작업은 ${MAX_ACTIVE_REPEAT_TASKS}개까지입니다. 설정의 반복 작업에서 멈추거나 지운 뒤 다시 등록하세요.`);
    const t = newRepeatTask(a, { id: crypto.randomUUID(), now: Date.now(), request, planGen: crypto.randomUUID() });
    all.push(t);
    await save(all);
    return t;
  });
  await arm(task);
  debugLog("repeat:register", `${task.title} · ${task.intervalMinutes}분`);
  await announce();
  // 첫 확인은 바로(알람의 첫 울림을 기다리지 않는다).
  void runCheck(task.id);
  return task;
}

export async function listRepeatTasks(): Promise<RepeatTask[]> {
  await recovered;
  return load();
}

export async function pauseRepeatTask(id: string): Promise<RepeatTask[]> {
  await recovered;
  await update(id, (t) => pauseTask(t));
  abortRun(id);
  await disarm(id);
  await announce();
  return load();
}

export async function resumeRepeatTask(id: string): Promise<RepeatTask[]> {
  await recovered;
  let error: string | null = null;
  const t = await update(id, (t, all) => {
    const r = resumeTask(t, Date.now(), activeCount(all));
    if ("error" in r) {
      error = r.error;
      return null;
    }
    return r.task;
  });
  if (error) throw new Error(error);
  if (t) {
    await arm(t);
    void runCheck(t.id);
  }
  await announce();
  return load();
}

export async function deleteRepeatTask(id: string): Promise<RepeatTask[]> {
  await recovered;
  await serial(async () => {
    await save((await load()).filter((t) => t.id !== id));
  });
  abortRun(id);
  await disarm(id);
  await announce();
  return load();
}

// 설정의 "작전 지우기(전체 판단)"(#284). 진행 중인 확인이 만든 작전은 반영하지 않는다(planEffect가 시작 때 상태와 비교).
// revision은 올리지 않는다(작전은 보내는 범위만 정하고, 이어서 진행의 검증 대상이 아니다).
export async function clearRepeatPlan(id: string): Promise<RepeatTask[]> {
  await recovered;
  const t = await update(id, (t) => clearPlan(t, Date.now()));
  if (!t) throw new Error("지울 작전이 없습니다.");
  debugLog("repeat:plan", `${t.title} · cleared`);
  await announce();
  return load();
}

// 설정의 "작전 만들기(다음 확인 때)"(#284): 작전이 없는 작업(옛 작업·만들기 실패·지움)을 다음 unmet 확인 때 만들게 한다.
export async function makeRepeatPlan(id: string): Promise<RepeatTask[]> {
  await recovered;
  const t = await update(id, (t) => requestPlan(t, crypto.randomUUID()));
  if (!t) throw new Error("이미 작전이 있거나 만드는 중입니다.");
  debugLog("repeat:plan", `${t.title} · requested`);
  await announce();
  return load();
}

// 설정의 "지금 확인". 작업마다 REPEAT_MANUAL_GAP_MS에 한 번.
export async function runRepeatNow(id: string): Promise<RepeatTask[]> {
  await recovered;
  let error: string | null = null;
  const now = Date.now();
  await update(id, (t) => {
    if (t.status !== "active") {
      error = "확인 중인 작업만 지금 확인할 수 있습니다.";
      return null;
    }
    if (now - t.lastManualAt < REPEAT_MANUAL_GAP_MS) {
      error = "방금 확인했습니다. 잠시 뒤 다시 누르세요.";
      return null;
    }
    return { ...t, lastManualAt: now };
  });
  if (error) throw new Error(error);
  await runCheck(id);
  return load();
}

// ---- 확인 ----

const running = new Map<string, { token: string; controller: AbortController }>();

function abortRun(id: string): void {
  running.get(id)?.controller.abort();
  running.delete(id);
}

class Discarded extends Error {}
// 회차 마감(170초)에 끊김. 결과는 error 1회로 센다(단계별 시간 초과와 같은 취급).
class DeadlineError extends Error {}
// 가림 목록을 읽지 못해 보내지 않음(같은 회차에 전체 판단으로 다시 보내지 않는다).
class SecretsReadError extends Error {}
const DEADLINE_MESSAGE = `확인 시간(${ROUND_DEADLINE_MS / 1000}초)이 다 되어 이 회차를 끝냈습니다.`;

// 한 회차의 신호: 사용자 멈춤·지우기(user)와 마감(deadline) 중 먼저 오는 것. 모든 단계가 이 신호와 남은 시간을 따른다.
interface Round {
  signal: AbortSignal;
  user: AbortSignal;
  deadline: number;
  end: () => void;
}

function startRound(user: AbortSignal): Round {
  const c = new AbortController();
  const deadline = Date.now() + ROUND_DEADLINE_MS;
  const onUser = () => c.abort();
  user.addEventListener("abort", onUser, { once: true });
  const timer = setTimeout(() => c.abort(), ROUND_DEADLINE_MS);
  return {
    signal: c.signal,
    user,
    deadline,
    end: () => {
      clearTimeout(timer);
      user.removeEventListener("abort", onUser);
    },
  };
}

// 신호가 끊긴 까닭에 맞는 오류: 사용자 멈춤·지우기면 결과를 버리고(Discarded), 마감이면 오류로 기록한다.
function roundError(r: Round): Error {
  return r.user.aborted ? new Discarded() : new DeadlineError(DEADLINE_MESSAGE);
}
// 회차 안의 기다림은 모두 이 신호와 경쟁한다(확장 API·저장소 읽기가 멈춰도 마감·멈춤에 끝난다). 원래 작업은 계속 돌 수 있다.
const bound = <T>(r: Round, p: Promise<T>): Promise<T> => raceSignal(p, r.signal, () => roundError(r));
// 회차가 끝난 뒤 정리(탭 닫기)에 쓰는 짧은 제한.
const CLEANUP_MS = 5000;
const deadlineHit = (r: Round) => r.signal.aborted && !r.user.aborted;
const left = (r: Round, stageMs: number) => stepTimeout(stageMs, r.deadline, Date.now());
// 회차 자체를 멈추는 오류(같은 회차에 다른 판단으로 이어 가지 않는다).
const roundStop = (err: unknown) => err instanceof Discarded || err instanceof DeadlineError;

// 확인 한 번. 시작·각 단계 뒤·반영 직전에 이 실행(token)이 아직 유효한지 본다(멈춤·지우기·새 실행이면 결과를 버린다).
export async function runCheck(id: string): Promise<void> {
  await recovered;
  const token = crypto.randomUUID();
  let finished: RepeatTask | null = null;
  const started = await update(id, (t) => {
    const r = beginRun(t, token, Date.now());
    if (r.kind === "skip") return null;
    if (r.kind === "finish") finished = r.task;
    return r.task;
  });
  if (finished) {
    await disarm(id);
    debugLog("repeat:finish", (finished as RepeatTask).note);
    await announce();
    return;
  }
  if (!started) return;
  const controller = new AbortController();
  running.set(id, { token, controller });
  const hold = holdWorker();
  const round = startRound(controller.signal);
  debugLog("repeat:check", `${started.title} · ${started.attempts}/${started.maxRuns} · 작전 ${started.plan.state}`);
  // 시작 때의 작전 상태. 반영할 때 지금 상태와 다르면(그 사이 지움 등) 작전 결과를 버린다.
  const startedKey = planKey(started.plan);
  let outcome: PlanOutcome = { kind: "keep" };
  let check: RepeatCheck;
  // 이 확인이 연 탭(끝나면 닫는다).
  let ownTab: number | null = null;
  try {
    const stillMine = async () => {
      const cur = (await bound(round, load())).find((t) => t.id === id);
      if (!cur || cur.status !== "active" || cur.run?.token !== token || controller.signal.aborted) throw new Discarded();
      if (round.signal.aborted) throw roundError(round);
    };
    const page = await openPage(started, round, (tabId) => {
      ownTab = tabId;
    });
    await stillMine();
    const st = started.plan;
    const ready = st.state === "ready" ? st : null;
    // 회차 방식은 저장된 회차 수·시각(코드가 센 값)으로만 정한다(검산 회차를 페이지 글자로 건너뛰지 않는다).
    const mode = roundMode(st, Date.now());
    // 이 회차가 안 맞으면 바로 다시 만들 차례인 작업도 영역 후보를 함께 받는다(같은 회차에 만들 수 있게).
    const wantOutline = st.state === "pending" || missRegen(st, started.planBuilds);
    // 전체 글자는 늘 함께 읽는다(영역이 안 맞거나 다시 확인할 때 같은 문서·같은 시점의 글자를 쓴다).
    const snap = await readSnapshot(page, round, { region: ready ? regionSpec(ready.plan.region) : undefined, outline: wantOutline });
    await stillMine();
    const ctx = await modelContext(round);
    let sent = 0;
    const ask = (system: string, user: string, maxTokens = 300) =>
      askModel(ctx, system, user, round, maxTokens, (n) => {
        sent += n;
      });
    const fullJudge = async () => parseVerdict(await ask(REPEAT_CHECK_SYSTEM, checkPrompt(started, snap)));
    let result: { verdict: RepeatCheck["verdict"]; reason: string; mode: NonNullable<RepeatCheck["mode"]> };
    if (ready) {
      const p = ready.plan;
      const fit = regionFit(p, snap.region);
      const budget = planBudget(round.deadline - Date.now(), ctx.limitMs, READ_MS);
      if (fit.ok && snap.region?.found) {
        // 영역 판단에 보내는 관측(제목·최종 주소·영역 글자·영역 버튼과 상태) 하나를 프롬프트와 생략 키가 함께 쓴다.
        const obs = regionObservation(snap, p, snap.region);
        // 생략 키: 가리기 전 원문 관측의 SHA-256(해시만 저장). 못 내면 생략하지 않는다.
        let hash: string | null = null;
        try {
          hash = await bound(round, observationHash(obs));
        } catch (err) {
          if (roundStop(err)) throw err;
        }
        if (shouldSkip(ready, mode, snap.region, hash)) {
          // 모델을 부르지 않는다. 기록은 늘 unmet(생략은 met·blocked를 만들지 않는다).
          result = { verdict: "unmet", reason: SKIP_REASON, mode: "skip" };
          outcome = { kind: "skip" };
        } else if (budget.region) {
          let r: ReturnType<typeof parseRegionVerdict> | null = null;
          try {
            r = parseRegionVerdict(await ask(REPEAT_REGION_SYSTEM, regionPrompt(started, p, obs)));
          } catch (err) {
            // 회차를 멈추는 오류·대상 바뀜·가림 목록 실패는 다시 보내지 않는다. 그 밖(시간 초과·네트워크)은 전체 판단으로.
            if (roundStop(err) || err instanceof TargetChangedError || err instanceof SecretsReadError) throw err;
            debugLog("repeat:region_error", err instanceof Error ? err.message : String(err), "warn");
          }
          if (mode === "verify") {
            // 검산 회차: 영역 판단이 무엇이든 전체 판단을 하고 그 판정을 쓴다. 둘이 다르면 작전을 다시 만든다.
            await stillMine();
            const f = await fullJudge();
            result = { ...f, mode: "verify" };
            outcome = regionRoundOutcome("verify", r, f);
          } else if (r?.verdict === "unmet") {
            result = { verdict: "unmet", reason: r.reason, mode: "region" };
            outcome = { kind: "region", hash };
          } else {
            // 영역만 보고는 unmet 말고는 확정하지 않는다(작전 글은 페이지에서 유래했다). 같은 회차에 전체 화면으로 판단한다.
            await stillMine();
            const f = await fullJudge();
            result = { ...f, mode: "region+full" };
            outcome = regionRoundOutcome("region", r, f);
          }
        } else {
          // 두 번 부를 시간이 없으면 전체 판단만(검산 회차도 전체 판단은 하므로 검산을 건너뛰지 않는다).
          const f = await fullJudge();
          result = { ...f, mode: "full" };
          outcome = { kind: "budget" };
        }
      } else {
        const why = fit.ok ? "no_probe" : fit.why;
        const f = await fullJudge();
        result = { ...f, mode: "full" };
        outcome = { kind: "mismatch", why };
        // 이 안 맞음으로 다시 만들 차례면(연속 PLAN_MISS_LIMIT번, 한도 안) 모델을 한 번만 부른 이 회차에 바로 만든다(unmet이고 시간이 될 때).
        if (missRegen(ready, started.planBuilds) && f.verdict === "unmet" && planBudget(round.deadline - Date.now(), ctx.limitMs, READ_MS).make) {
          outcome = { kind: "mismatch", why, build: await buildPlan(started, snap, page, round, ask, stillMine) };
        }
      }
    } else {
      const f = await fullJudge();
      result = { ...f, mode: "full" };
      // 작전은 정상 화면이 확인된 unmet 회차에만, 모델을 한 번만 부른 회차에서 남은 시간이 될 때 만든다.
      if (st.state === "pending" && f.verdict === "unmet") {
        outcome = planBudget(round.deadline - Date.now(), ctx.limitMs, READ_MS).make ? await buildPlan(started, snap, page, round, ask, stillMine) : { kind: "budget" };
      }
    }
    check = { at: Date.now(), ...result, sent };
  } catch (err) {
    outcome = { kind: "keep" };
    if (controller.signal.aborted || (err instanceof Discarded && !deadlineHit(round))) {
      round.end();
      hold();
      if (running.get(id)?.token === token) running.delete(id);
      await closeOwnTab(ownTab, started.url);
      return;
    }
    check = { at: Date.now(), verdict: "error", reason: deadlineHit(round) ? DEADLINE_MESSAGE : err instanceof Error ? err.message : String(err) };
  } finally {
    round.end();
    hold();
  }
  if (running.get(id)?.token === token) running.delete(id);
  await closeOwnTab(ownTab, started.url);
  // 페이지에서 유래한 이유·오류 글자도 자동 로그인 값을 가린 뒤 저장한다(판정 코드는 그대로). 가림 목록 읽기가 붙잡혀도
  // 회차를 오래 끌지 않는다(못 읽으면 이유를 비운다).
  const reasonText = check.reason;
  check = { ...check, reason: await withTimeout(maskStringForModel(reasonText), 5000, "가림 시간 초과").then((r) => r.text, () => "") };
  const next = await update(id, (t) => {
    const r = applyRunResult(t, token, check, Date.now());
    return r && planEffect(r, startedKey, outcome, Date.now());
  });
  if (!next) return;
  debugLog("repeat:result", `${next.title} · ${check.verdict}${check.mode ? ` · ${check.mode}` : ""}${check.reason ? ` · ${check.reason}` : ""}`, check.verdict === "error" ? "warn" : "info");
  // 작전 결과는 종류·사유 코드만 남긴다(작전 글은 로그에 넣지 않는다).
  // plan_none의 why는 모델이 쓴 글이라 넣지 않는다(코드가 만든 사유 코드만).
  if (outcome.kind !== "keep") {
    const build = outcome.kind === "mismatch" && outcome.build ? ` + ${outcome.build.kind}${outcome.build.kind === "plan_failed" ? ` · ${outcome.build.why}` : ""}` : "";
    debugLog("repeat:plan", `${next.title} · ${outcome.kind}${"why" in outcome && outcome.kind !== "plan_none" ? ` · ${outcome.why}` : ""}${build} → ${next.plan.state}`);
  }
  if (next.status !== "active") await disarm(id);
  // 조건이 맞은 그 회차에만 한 번 알린다(텔레그램 알림 등, #139).
  if (next.status === "triggered") for (const fn of triggerListeners) void Promise.resolve(fn({ id: next.id, title: next.title })).catch(() => {});
  await announce();
}

// 작전 만들기(같은 회차, 판정은 이미 정해짐). 만들기 실패는 판정에 영향을 주지 않는다 — 멈춤·지우기(Discarded)만 바깥으로 던져
// 회차 전체를 버린다. 회차 마감에 걸리면 판정은 남기고 만들기 실패로 센다.
async function buildPlan(
  t: RepeatTask,
  snap: WatchSnapshot,
  page: OpenedPage,
  round: Round,
  ask: (system: string, user: string, maxTokens?: number) => Promise<string>,
  stillMine: () => Promise<void>,
): Promise<BuildOutcome> {
  const mask = (s: string) => bound(round, maskStringForModel(s)).then((r) => r.text);
  try {
    await stillMine();
    const text = await ask(REPEAT_PLAN_SYSTEM, planPrompt(t, snap, snap.outline ?? []), PLAN_MAX_TOKENS);
    const parsed = parsePlan(text);
    if (!parsed.ok) return parsed.none !== undefined ? { kind: "plan_none", why: (await mask(parsed.none)).slice(0, 200) } : { kind: "plan_failed", why: "schema" };
    // 작전 글은 가린 뒤 저장한다. 선택자·기준점이 가림으로 바뀌면 거부(비밀 값이 든 작전).
    const masked = await maskDraft(parsed.draft, mask);
    if (!masked.ok) return { kind: "plan_failed", why: "secret" };
    await stillMine();
    // 같은 문서·주소에서 그 영역을 다시 읽어 확인한다(읽는 사이 문서가 바뀌면 readSnapshot이 던진다 → 작전을 버림).
    let probe: RegionProbe | undefined;
    try {
      probe = (await readSnapshot(page, round, { region: regionSpec(masked.draft.region), textMax: 0, limit: 0 })).region;
    } catch (err) {
      if (roundStop(err)) throw err;
      return { kind: "plan_failed", why: "changed" };
    }
    const acc = acceptProbe(masked.draft, probe, snap.text.length);
    if (!acc.ok || !probe?.found) return { kind: "plan_failed", why: acc.ok ? "probe" : acc.why };
    return {
      kind: "made",
      plan: makePlan(masked.draft, { id: crypto.randomUUID(), now: Date.now(), shape: acc.shape, fullChars: snap.text.length, regionChars: probe.text.length }),
    };
  } catch (err) {
    if (round.user.aborted || (err instanceof Discarded && !deadlineHit(round))) throw err instanceof Discarded ? err : new Discarded();
    return { kind: "plan_failed", why: err instanceof ModelTimeoutError || err instanceof DeadlineError ? "timeout" : "error" };
  }
}

// 확인하는 동안 서비스 워커가 쉬는 것으로 보이지 않게 20초마다 확장 API를 부른다(Chrome 110+). 끝나면 멈춘다.
function holdWorker(): () => void {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  return () => clearInterval(timer);
}

// 확인 중에 사용자가 앞으로 가져온 적이 있는 확인용 탭(사용하기 시작한 탭은 닫지 않는다).
const touchedTabs = new Set<number>();
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (openChecks.has(tabId)) touchedTabs.add(tabId);
});
// 지금 확인 중인 탭 → 다 뜬 뒤 본 주소.
const openChecks = new Map<number, string | null>();

// 이 확인이 연 탭을 닫는다. 사용자가 그 탭을 한 번이라도 앞으로 가져왔거나, 우리가 본 주소에서 옮겼거나, 등록한 사이트 밖에
// 있으면 닫지 않는다(사용자가 쓰기 시작한 탭의 입력을 잃지 않게).
async function closeOwnTab(tabId: number | null, registered: string): Promise<void> {
  if (tabId === null) return;
  const seen = openChecks.get(tabId) ?? null;
  const touched = touchedTabs.has(tabId);
  openChecks.delete(tabId);
  touchedTabs.delete(tabId);
  const tab = await withTimeout(chrome.tabs.get(tabId), CLEANUP_MS, "탭 확인 시간 초과").catch(() => null);
  if (!tab || touched || tab.active || !tab.url || !inRegisteredSite(registered, tab.url)) return;
  if (seen !== null && tab.url !== seen) return;
  await withTimeout(chrome.tabs.remove(tabId), CLEANUP_MS, "탭 닫기 시간 초과").catch(() => {});
}

interface OpenedPage {
  tabId: number;
  documentId: string;
  url: string;
}

// 확인용 탭: 확인할 때마다 등록한 주소로 새 비활성 탭을 열고, 끝나면 닫는다(closeOwnTab). 사용자가 쓰는 탭을 다시 쓰거나
// 옮기지 않는다. 다 뜬 뒤 최종 주소가 등록한 사이트 밖이면 읽지 않는다. onTab: 탭을 연 즉시 알린다(실패해도 닫을 수 있게).
async function openPage(t: RepeatTask, round: Round, onTab: (tabId: number) => void): Promise<OpenedPage> {
  if (round.signal.aborted) throw roundError(round);
  const creating = chrome.tabs.create({ url: t.url, active: false });
  let created: chrome.tabs.Tab;
  try {
    created = await bound(round, creating);
  } catch (err) {
    // 마감·멈춤으로 기다리지 않게 된 뒤에 탭이 열리면 닫는다(이 확인이 연 탭을 남기지 않게).
    void creating.then((tab) => (tab.id !== undefined ? chrome.tabs.remove(tab.id) : undefined)).catch(() => {});
    throw err;
  }
  if (created.id === undefined) throw new Error("확인용 탭을 열지 못했습니다.");
  const tabId = created.id;
  openChecks.set(tabId, null);
  onTab(tabId);
  await waitLoaded(tabId, round);
  await sleep(SETTLE_MS, round);
  const tab = await bound(round, chrome.tabs.get(tabId));
  const url = tab.url ?? "";
  if (openChecks.has(tabId)) openChecks.set(tabId, url);
  if (!/^https?:/.test(url)) throw new Error("확인용 탭이 웹 페이지가 아닙니다.");
  // 등록한 주소와 같은 출처이거나 같은 등록 도메인이면 읽는다(공유 호스팅은 등록 도메인으로 묶지 않으므로 같은 출처만).
  if (!inRegisteredSite(t.url, url)) throw new Error("등록한 사이트 밖으로 이동해 읽지 않았습니다.");
  const frame = await bound(round, chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null));
  if (!frame?.documentId) throw new Error("페이지 문서를 확인하지 못했습니다.");
  return { tabId, documentId: frame.documentId, url };
}

async function waitLoaded(tabId: number, round: Round): Promise<void> {
  const deadline = Date.now() + left(round, LOAD_TIMEOUT_MS);
  await sleep(300, round);
  while (Date.now() < deadline) {
    const tab = await bound(round, chrome.tabs.get(tabId).catch(() => null));
    if (!tab) throw new Error("확인용 탭이 닫혔습니다.");
    if (tab.status === "complete") return;
    await sleep(300, round);
  }
  if (round.signal.aborted || Date.now() >= round.deadline) throw roundError(round);
  throw new Error("페이지가 30초 안에 다 뜨지 않았습니다.");
}

function sleep(ms: number, round: Round): Promise<void> {
  return new Promise((resolve, reject) => {
    if (round.signal.aborted) return reject(roundError(round));
    const timer = setTimeout(resolve, ms);
    round.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(roundError(round));
    }, { once: true });
  });
}

type WatchSnapshot = RepeatSnapshot & { region?: RegionProbe; outline?: OutlineItem[] };

function readClickables(raw: unknown, max: number): RepeatSnapshot["clickables"] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).flatMap((c) => {
    const x = c as { text?: unknown; role?: unknown; states?: unknown };
    if (typeof x.text !== "string") return [];
    const states =
      x.states && typeof x.states === "object"
        ? Object.fromEntries(Object.entries(x.states as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
        : undefined;
    return [{ text: x.text.slice(0, 120), role: typeof x.role === "string" ? x.role : "", ...(states ? { states } : {}) }];
  });
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

// content가 돌려준 영역 읽기 결과를 다시 타입 검사한다. 글자는 상한으로 자르고, 잘렸으면 cut으로 본다.
function readProbe(raw: unknown): RegionProbe | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.found !== true) {
    const why = (REGION_MISSES as readonly unknown[]).includes(r.why) ? (r.why as RegionMiss) : "no_match";
    return { found: false, why };
  }
  if (typeof r.text !== "string" || !r.shape || typeof r.shape !== "object") return { found: false, why: "empty" };
  const sh = r.shape as Record<string, unknown>;
  // 버튼 목록이 상한을 넘었으면 글자 잘림과 같게 잘린 영역으로 본다(content도 상한 + 1개로 알린다).
  const buttons = capClickables(readClickables(r.clickables, REGION_CLICKABLES + 1), REGION_CLICKABLES);
  return {
    found: true,
    text: r.text.slice(0, REGION_TEXT_MAX),
    cut: r.cut === true || r.text.length > REGION_TEXT_MAX || buttons.cut,
    shape: { tag: str(sh.tag, 40), role: str(sh.role, 40), skeleton: str(sh.skeleton, 40) },
    clickables: buttons.clickables,
  };
}

function readOutline(raw: unknown): OutlineItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, OUTLINE_MAX).flatMap((o) => {
    const x = o as Record<string, unknown>;
    if (!x || typeof x.selector !== "string" || !x.selector || x.selector.length > 200) return [];
    return [{ selector: x.selector, tag: str(x.tag, 20), role: str(x.role, 40), heading: str(x.heading, 80), label: str(x.label, 80), chars: typeof x.chars === "number" ? Math.max(0, Math.floor(x.chars)) : 0, preview: str(x.preview, 80) }];
  });
}

// 고정한 문서·주소에만 묻는다. 읽은 뒤 문서나 주소가 바뀌었으면 버린다.
// region: 작전 영역도 읽는다. outline: 작전 만들기용 영역 후보도 받는다. textMax·limit 0: 전체 글자·버튼을 읽지 않는다(영역 확인).
async function readSnapshot(page: OpenedPage, round: Round, opts: { region?: RegionSpec; outline?: boolean; textMax?: number; limit?: number } = {}): Promise<WatchSnapshot> {
  const msg = {
    kind: "watch_snapshot" as const,
    expectUrl: page.url,
    max: opts.textMax ?? SNAPSHOT_TEXT_MAX,
    limit: opts.limit ?? SNAPSHOT_CLICKABLES,
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.outline ? { outline: OUTLINE_MAX } : {}),
  };
  const ask = () =>
    withTimeout(chrome.tabs.sendMessage(page.tabId, msg, { documentId: page.documentId }), left(round, SNAPSHOT_TIMEOUT_MS), "페이지가 응답하지 않습니다.", {
      signal: round.signal,
    }) as Promise<{ ok?: boolean; data?: unknown; error?: string } | undefined>;
  let res: Awaited<ReturnType<typeof ask>>;
  try {
    res = await ask();
  } catch {
    if (round.signal.aborted) throw roundError(round);
    // content script가 아직 준비되지 않았을 수 있다(한 번만 다시).
    await sleep(1000, round);
    res = await ask();
  }
  if (!res?.ok || !res.data || typeof res.data !== "object") throw new Error(res?.error ?? "페이지 글자를 읽지 못했습니다.");
  const frame = await bound(round, chrome.webNavigation.getFrame({ tabId: page.tabId, frameId: 0 }).catch(() => null));
  const tab = await bound(round, chrome.tabs.get(page.tabId).catch(() => null));
  if (frame?.documentId !== page.documentId || tab?.url !== page.url) throw new Error("읽는 사이 페이지가 바뀌었습니다.");
  const d = res.data as { title?: unknown; text?: unknown; clickables?: unknown; region?: unknown; outline?: unknown };
  const region = opts.region ? readProbe(d.region) : undefined;
  const outline = opts.outline ? readOutline(d.outline) : undefined;
  return {
    title: str(d.title, 120),
    url: page.url,
    text: str(d.text, SNAPSHOT_TEXT_MAX),
    clickables: readClickables(d.clickables, SNAPSHOT_CLICKABLES),
    ...(region ? { region } : {}),
    ...(outline ? { outline } : {}),
  };
}

interface ModelCtx {
  active: ActiveModel;
  // 모델 한 번의 시간 제한(로컬은 2배).
  limitMs: number;
}

class ModelTimeoutError extends Error {}

// 모델 설정 읽기(시간 제한이 없던 기다림이라 회차 신호에 묶는다).
async function modelContext(round: Round): Promise<ModelCtx> {
  const active = activeModel(await bound(round, getSettings()));
  if (!active.ready) throw new Error(active.missing === "key" ? "API 키가 없어 확인하지 못했습니다." : "로컬 서버 주소와 모델이 없어 확인하지 못했습니다.");
  return { active, limitMs: providerTimeout(active.provider, MODEL_TIMEOUT_MS) };
}

// 확인용 모델 호출 한 번(전체 판단·영역 판단·작전 만들기가 함께 쓴다). 응답 글을 돌려준다. onSent: 보낸 user 글자 수.
async function askModel(ctx: ModelCtx, system: string, user: string, round: Round, maxTokens: number, onSent: (n: number) => void): Promise<string> {
  const { active } = ctx;
  const { provider, model } = active;
  // 가림 목록을 못 읽으면 던진다(가릴 값을 모른 채 페이지 글자를 보내지 않는다). 읽기가 붙잡혀도 회차 마감에 끊긴다.
  let messages: Array<{ role: "system" | "user"; content: string }>;
  try {
    ({ value: messages } = await bound(
      round,
      maskMessagesForModel([
        { role: "system" as const, content: system },
        { role: "user" as const, content: user },
      ]),
    ));
  } catch (err) {
    if (roundStop(err)) throw err;
    throw new SecretsReadError("자동 로그인 가림 목록을 읽지 못해 보내지 않았습니다.");
  }
  // 준비(설정·가림 목록 읽기)를 기다리는 사이 멈춤·지우기·마감이 있었으면 보내지 않는다.
  if (round.signal.aborted) throw roundError(round);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  round.signal.addEventListener("abort", onAbort, { once: true });
  const limit = left(round, ctx.limitMs);
  const timer = setTimeout(() => controller.abort(), limit);
  // 준비하는 사이 대상이 바뀌면 보내지 않고, 보낸 뒤 바뀌면 결과를 버린다(#193).
  const guard = beginTargetGuard(active, controller.signal);
  try {
    // 대상 확인의 설정 읽기도 마감·멈춤과 경쟁한다(읽기가 멈춰도 회차가 끝나게).
    await bound(round, guard.verify());
    onSent(user.length);
    // 요청은 신호(마감·멈춤·모델 시간 제한)로 끊고, 어댑터가 신호를 늦게 따르더라도 기다림은 회차 신호와 경쟁한다.
    const text = await bound(
      round,
      providerAdapter(provider).complete(
        active,
        { model, messages, temperature: 0, reasoning: "off", maxTokens, responseFormat: { type: "json_object" } },
        guard.signal,
      ),
    );
    guard.assert();
    return text;
  } catch (err) {
    if (round.signal.aborted) throw roundError(round);
    guard.assert();
    if (controller.signal.aborted) throw new ModelTimeoutError(`모델이 ${Math.round(limit / 1000)}초 안에 답하지 않았습니다.`);
    throw err;
  } finally {
    clearTimeout(timer);
    guard.end();
    round.signal.removeEventListener("abort", onAbort);
  }
}

// ---- 이어서 진행 ----

// 조건이 맞은 작업을 한 번만 진행 상태로 바꾸고, 새 대화의 첫 요청 글과 턴 탭을 돌려준다. 요청 글은 저장된 작업 내용으로만 만든다.
// site: 새 대화의 자동 실행 기준 사이트(등록한 주소의 출처로 고정 — 탭이 그 사이 다른 사이트로 넘어가도 그 사이트를 믿지 않게).
// cancelled: 새 대화 동작이 있었거나 패널이 닫혔는지. handOver: 새 대화로 넘긴다(요청 글·탭·자동 실행 기준 사이트) — 실패하면 던진다.
// 탭을 연 뒤 넘기기 전에 취소·검증 실패·넘기기 실패가 있으면 연 탭을 닫고 되돌린다(#145, lib/repeatContinue.ts).
export async function continueRepeatTask(
  id: string,
  opts: { cancelled: () => boolean; handOver: (text: string, tabId: number, site: string) => void },
): Promise<"started" | "cancelled"> {
  await recovered;
  let error: string | null = null;
  const claimed = await update(id, (t) => {
    const r = claimContinue(t, Date.now());
    if (!r.ok) {
      error = r.error;
      return r.task;
    }
    return r.task;
  });
  if (error || !claimed) {
    await announce();
    throw new Error(error ?? "반복 작업을 찾지 못했습니다.");
  }
  let windowId: number | undefined;
  return runContinue({
    cancelled: opts.cancelled,
    // 등록한 주소로 새 탭을 연다(확인용 탭은 확인이 끝날 때 닫았다). 지금 활성 탭으로 대신하지 않는다.
    openTab: async () => {
      const created = await chrome.tabs.create({ url: claimed.url, active: true });
      if (created.id === undefined) throw new Error("작업 탭을 열지 못했습니다.");
      windowId = created.windowId;
      return created.id;
    },
    closeTab: (tabId) => chrome.tabs.remove(tabId),
    // 탭을 준비하는 사이 작업을 지웠거나 상태가 바뀌었으면 시작하지 않는다.
    verify: async () => {
      await announce();
      const still = (await load()).find((t) => t.id === id);
      if (!still || still.status !== "started" || still.revision !== claimed.revision) throw new Error("그 사이 작업이 지워졌거나 바뀌었습니다.");
    },
    focus: async () => {
      if (windowId !== undefined) await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    },
    handOver: (tabId) => {
      opts.handOver(followUpText(claimed), tabId, httpOrigin(claimed.url) ?? claimed.url);
      debugLog("repeat:continue", claimed.title);
    },
    release: () => releaseRepeatTask(id),
  });
}

// 이어서 진행을 실제로 시작하지 못했을 때(탭 실패·그 사이 새 대화·패널 닫힘) 조건 맞음으로 되돌린다.
export async function releaseRepeatTask(id: string): Promise<void> {
  await update(id, (t) => (t.status === "started" ? { ...t, status: "triggered", note: "", revision: t.revision + 1 } : null));
  await announce();
}

// 등록한 주소와 같은 출처이거나 같은 등록 도메인(공유 호스팅은 같은 출처만).
function inRegisteredSite(registered: string, url: string): boolean {
  return httpOrigin(url) !== null && (httpOrigin(url) === httpOrigin(registered) || sameSiteAs(registered, url));
}

