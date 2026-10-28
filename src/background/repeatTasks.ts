// 반복 작업(#138): 저장·알람·확인용 탭·확인(모델 판단)·이어서 진행. 상태 전이는 src/lib/repeatTask.ts.
// - 등록은 늘 승인 카드(openrouter.ts의 scheduleRepeat). 여기서는 승인된 작업만 받는다.
// - 확인은 패널 없이도 알람으로 돈다. 페이지 글자는 content의 watch_snapshot(modelText·findClickables — 입력값·편집 영역 제외,
//   #43)만 쓰고, 보내기 전에 자동 로그인 값을 가린다(가림 목록을 못 읽으면 보내지 않는다).
// - 조건이 맞으면 알리기만 한다. 다음 일은 사용자가 패널에서 "이어서 진행"을 눌러 새 대화로 시작한다(한 번만).
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
import { providerAdapter } from "@/lib/providers";
import { withTimeout } from "@/lib/async";
import { getSettings } from "./storage";
import { maskMessagesForModel, maskValue } from "./loginSecrets";
import { debugLog } from "./debug";

const STORE_KEY = "repeatTasks";
const ALARM_PREFIX = "repeat:";
const LOAD_TIMEOUT_MS = 30_000;
const SETTLE_MS = 1500;
const SNAPSHOT_TIMEOUT_MS = 15_000;
// 서비스 워커는 fetch 응답을 30초 넘게 기다리면 내려갈 수 있다. 확인 요청은 짧은 답(JSON 한 줄)이라 그 안에 끝낸다.
const MODEL_TIMEOUT_MS = 25_000;
const SNAPSHOT_TEXT_MAX = 6000;
const SNAPSHOT_CLICKABLES = 80;

// ---- 저장(모든 변경은 한 줄로) ----

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function load(): Promise<RepeatTask[]> {
  const raw = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY];
  return Array.isArray(raw) ? (raw.filter((t) => t && typeof t === "object" && typeof t.id === "string") as RepeatTask[]) : [];
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
    const t = newRepeatTask(a, { id: crypto.randomUUID(), now: Date.now(), request });
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
  debugLog("repeat:check", `${started.title} · ${started.attempts}/${started.maxRuns}`);
  let check: RepeatCheck;
  let tab: RepeatTask["tab"] = started.tab;
  let ownedTab: number | null = null;
  try {
    const stillMine = async () => {
      const cur = (await load()).find((t) => t.id === id);
      if (!cur || cur.status !== "active" || cur.run?.token !== token || controller.signal.aborted) throw new Discarded();
    };
    const page = await openPage(started, controller.signal, (tabId) => {
      ownedTab = tabId;
    });
    tab = { tabId: page.tabId, url: page.url };
    await stillMine();
    const snapshot = await readSnapshot(page);
    await stillMine();
    const { verdict, reason } = await judge(started, snapshot, controller.signal);
    check = { at: Date.now(), verdict, reason };
  } catch (err) {
    if (err instanceof Discarded || controller.signal.aborted) {
      hold();
      if (running.get(id)?.token === token) running.delete(id);
      return;
    }
    check = { at: Date.now(), verdict: "error", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    hold();
  }
  if (running.get(id)?.token === token) running.delete(id);
  // 확인이 실패했어도 이 실행이 쓴 탭은 이 작업의 탭으로 기억한다(지금 주소 그대로 — 사용자가 옮기면 다음에 새 탭).
  if (check.verdict === "error" && ownedTab !== null) {
    const cur = await chrome.tabs.get(ownedTab).catch(() => null);
    tab = cur?.url ? { tabId: ownedTab, url: cur.url } : null;
  }
  // 페이지에서 유래한 이유·오류 글자도 자동 로그인 값을 가린 뒤 저장한다.
  check = await maskValue(check).catch(() => ({ ...check, reason: "" }));
  const next = await update(id, (t) => {
    const n = applyRunResult(t, token, check, Date.now());
    return n ? { ...n, tab } : null;
  });
  if (!next) return;
  debugLog("repeat:result", `${next.title} · ${check.verdict}${check.reason ? ` · ${check.reason}` : ""}`, check.verdict === "error" ? "warn" : "info");
  if (next.status !== "active") await disarm(id);
  await announce();
}

// 확인하는 동안 서비스 워커가 쉬는 것으로 보이지 않게 20초마다 확장 API를 부른다(Chrome 110+). 끝나면 멈춘다.
function holdWorker(): () => void {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  return () => clearInterval(timer);
}

interface OpenedPage {
  tabId: number;
  documentId: string;
  url: string;
}

// 확인용 탭: 이 작업이 만든 탭이 아직 마지막으로 확인한 주소에 있으면 새로고침, 아니면(닫았거나 사용자가 옮겼으면) 새 탭.
// 사용자가 다른 화면으로 옮긴 탭은 건드리지 않는다. 다 뜬 뒤 최종 주소가 등록한 사이트 밖이면 읽지 않는다.
// onTab: 쓸 탭이 정해지는 즉시 알린다(뒤 단계가 실패해도 이 작업의 탭으로 기억해 다음 확인에서 새 탭을 또 만들지 않게).
// 확인은 늘 등록한 주소에서 시작한다(지난번에 리다이렉트된 주소를 새로고침하지 않는다).
async function openPage(t: RepeatTask, signal: AbortSignal, onTab: (tabId: number) => void): Promise<OpenedPage> {
  let tabId: number | null = null;
  if (t.tab) {
    const cur = await chrome.tabs.get(t.tab.tabId).catch(() => null);
    if (cur?.id !== undefined && cur.url === t.tab.url) tabId = cur.id;
  }
  if (tabId !== null) {
    onTab(tabId);
    const cur = await chrome.tabs.get(tabId);
    if (cur.url === t.url) await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: t.url });
  } else {
    const created = await chrome.tabs.create({ url: t.url, active: false });
    if (created.id === undefined) throw new Error("확인용 탭을 열지 못했습니다.");
    tabId = created.id;
    onTab(tabId);
  }
  await waitLoaded(tabId, signal);
  await sleep(SETTLE_MS, signal);
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  if (!/^https?:/.test(url)) throw new Error("확인용 탭이 웹 페이지가 아닙니다.");
  // 등록한 주소와 같은 출처이거나 같은 등록 도메인이면 읽는다(공유 호스팅은 등록 도메인으로 묶지 않으므로 같은 출처만).
  if (httpOrigin(url) !== httpOrigin(t.url) && !sameSiteAs(t.url, url)) throw new Error("등록한 사이트 밖으로 이동해 읽지 않았습니다.");
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
  if (!frame?.documentId) throw new Error("페이지 문서를 확인하지 못했습니다.");
  return { tabId, documentId: frame.documentId, url };
}

async function waitLoaded(tabId: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  await sleep(300, signal);
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("확인용 탭이 닫혔습니다.");
    if (tab.status === "complete") return;
    await sleep(300, signal);
  }
  throw new Error("페이지가 30초 안에 다 뜨지 않았습니다.");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Discarded());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Discarded());
    }, { once: true });
  });
}

// 고정한 문서·주소에만 묻는다. 읽은 뒤 문서나 주소가 바뀌었으면 버린다.
async function readSnapshot(page: OpenedPage): Promise<RepeatSnapshot> {
  const ask = () =>
    withTimeout(
      chrome.tabs.sendMessage(page.tabId, { kind: "watch_snapshot", expectUrl: page.url, max: SNAPSHOT_TEXT_MAX, limit: SNAPSHOT_CLICKABLES }, { documentId: page.documentId }),
      SNAPSHOT_TIMEOUT_MS,
      "페이지가 응답하지 않습니다.",
    ) as Promise<{ ok?: boolean; data?: unknown; error?: string } | undefined>;
  let res: Awaited<ReturnType<typeof ask>>;
  try {
    res = await ask();
  } catch {
    // content script가 아직 준비되지 않았을 수 있다(한 번만 다시).
    await new Promise((r) => setTimeout(r, 1000));
    res = await ask();
  }
  if (!res?.ok || !res.data || typeof res.data !== "object") throw new Error(res?.error ?? "페이지 글자를 읽지 못했습니다.");
  const frame = await chrome.webNavigation.getFrame({ tabId: page.tabId, frameId: 0 }).catch(() => null);
  const tab = await chrome.tabs.get(page.tabId).catch(() => null);
  if (frame?.documentId !== page.documentId || tab?.url !== page.url) throw new Error("읽는 사이 페이지가 바뀌었습니다.");
  const d = res.data as { title?: unknown; text?: unknown; clickables?: unknown };
  return {
    title: typeof d.title === "string" ? d.title.slice(0, 120) : "",
    url: page.url,
    text: typeof d.text === "string" ? d.text.slice(0, SNAPSHOT_TEXT_MAX) : "",
    clickables: Array.isArray(d.clickables)
      ? d.clickables.slice(0, SNAPSHOT_CLICKABLES).flatMap((c) => {
          const x = c as { text?: unknown; role?: unknown; states?: unknown };
          if (typeof x.text !== "string") return [];
          const states =
            x.states && typeof x.states === "object"
              ? Object.fromEntries(Object.entries(x.states as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
              : undefined;
          return [{ text: x.text.slice(0, 120), role: typeof x.role === "string" ? x.role : "", ...(states ? { states } : {}) }];
        })
      : [],
  };
}

async function judge(t: RepeatTask, s: RepeatSnapshot, signal: AbortSignal): Promise<{ verdict: RepeatCheck["verdict"]; reason: string }> {
  const { provider, apiKey, model } = activeModel(await getSettings());
  if (!apiKey) throw new Error("API 키가 없어 확인하지 못했습니다.");
  // 가림 목록을 못 읽으면 던진다(가릴 값을 모른 채 페이지 글자를 보내지 않는다).
  const { value: messages } = await maskMessagesForModel([
    { role: "system" as const, content: REPEAT_CHECK_SYSTEM },
    { role: "user" as const, content: checkPrompt(t, s) },
  ]);
  // 준비(설정·가림 목록 읽기)를 기다리는 사이 멈춤·지우기가 있었으면 보내지 않는다.
  if (signal.aborted) throw new Discarded();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const text = await providerAdapter(provider).complete(
      apiKey,
      { model, messages, temperature: 0, reasoning: "off", maxTokens: 300, responseFormat: { type: "json_object" } },
      controller.signal,
    );
    return parseVerdict(text);
  } catch (err) {
    if (signal.aborted) throw new Discarded();
    if (controller.signal.aborted) throw new Error("모델이 25초 안에 답하지 않았습니다.");
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

// ---- 이어서 진행 ----

// 조건이 맞은 작업을 한 번만 진행 상태로 바꾸고, 새 대화의 첫 요청 글과 턴 탭을 돌려준다. 요청 글은 저장된 작업 내용으로만 만든다.
export async function continueRepeatTask(id: string): Promise<{ text: string; tabId: number }> {
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
  try {
    const tabId = await continueTab(claimed);
    await announce();
    debugLog("repeat:continue", claimed.title);
    return { text: followUpText(claimed), tabId };
  } catch (err) {
    // 탭을 열지 못했으면 다시 누를 수 있게 되돌린다.
    await releaseRepeatTask(id);
    throw err;
  }
}

// 이어서 진행을 실제로 시작하지 못했을 때(탭 실패·그 사이 새 대화·패널 닫힘) 조건 맞음으로 되돌린다.
export async function releaseRepeatTask(id: string): Promise<void> {
  await update(id, (t) => (t.status === "started" ? { ...t, status: "triggered", note: "", revision: t.revision + 1 } : null));
  await announce();
}

// 확인하던 탭이 그 주소에 그대로 있으면 그 탭, 아니면 등록한 주소로 새 탭. 지금 활성 탭으로 대신하지 않는다.
async function continueTab(t: RepeatTask): Promise<number> {
  let tabId: number | null = null;
  if (t.tab) {
    const cur = await chrome.tabs.get(t.tab.tabId).catch(() => null);
    if (cur?.id !== undefined && cur.url === t.tab.url) tabId = cur.id;
  }
  if (tabId === null) {
    const created = await chrome.tabs.create({ url: t.url, active: true });
    if (created.id === undefined) throw new Error("작업 탭을 열지 못했습니다.");
    tabId = created.id;
  } else {
    await chrome.tabs.update(tabId, { active: true });
  }
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return tabId;
}

