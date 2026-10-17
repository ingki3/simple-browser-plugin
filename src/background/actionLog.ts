import { ACTION_LOG_KEY } from "@/lib/messages";
import {
  pruneLog,
  type ActionLogEntry,
  type ActionOutcome,
  type LoggedTarget,
  type PageKey,
} from "@/lib/actionLog";
import { getSettings } from "./storage";
import { debugLog } from "./debug";

// 승인 카드를 띄울 때 정한 대상과 페이지를 실행 결과가 나올 때까지 들고 있는다(callId별).
// 카드를 띄운 채 턴이 끝나면 결과가 오지 않으므로 오래된 것부터 버린다.
interface Pending {
  tool: ActionLogEntry["tool"];
  page: PageKey | null;
  targets: LoggedTarget[];
  at: number;
}

const MAX_PENDING = 20;
const pending = new Map<string, Pending>();

export function notePendingAction(
  callId: string,
  tool: ActionLogEntry["tool"],
  page: PageKey | null,
  targets: LoggedTarget[],
): void {
  pending.delete(callId);
  pending.set(callId, { tool, page, targets, at: Date.now() });
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

// 쓰기를 한 줄로 세운다(읽고-고쳐-쓰는 사이에 다른 쓰기가 끼면 항목이 사라진다).
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = writeChain.then(job, job);
  writeChain = next.catch(() => undefined);
  return next;
}

export function finishAction(
  callId: string,
  outcome: ActionOutcome,
  extra: Pick<ActionLogEntry, "effect" | "fill" | "reason"> = {},
): Promise<void> {
  const p = pending.get(callId);
  if (!p) return Promise.resolve();
  pending.delete(callId);
  const entry: ActionLogEntry = {
    id: callId,
    at: p.at,
    tool: p.tool,
    page: p.page,
    targets: p.targets,
    outcome,
    ...extra,
  };
  return enqueue(async () => {
    // 끈 뒤에 끝난 동작은 남기지 않는다.
    if (!(await getSettings()).actionLogEnabled) return;
    const now = Date.now();
    const obj = await chrome.storage.local.get(ACTION_LOG_KEY);
    const entries = pruneLog(obj[ACTION_LOG_KEY], now);
    entries.push(entry);
    await chrome.storage.local.set({ [ACTION_LOG_KEY]: pruneLog(entries, now) });
  }).catch((err) => {
    // 기록 실패가 도구 결과를 바꾸지 않게 한다.
    debugLog("action_log:write_fail", err instanceof Error ? err.message : String(err), "warn");
  });
}

// 개수를 셀 때도 만료된 항목을 저장소에서 지운다(새 동작이 없어도 30일 뒤에는 남지 않게).
export function actionLogCount(): Promise<number> {
  return enqueue(async () => {
    const obj = await chrome.storage.local.get(ACTION_LOG_KEY);
    const raw = obj[ACTION_LOG_KEY];
    const entries = pruneLog(raw, Date.now());
    if (raw !== undefined && (!Array.isArray(raw) || raw.length !== entries.length)) {
      if (entries.length) await chrome.storage.local.set({ [ACTION_LOG_KEY]: entries });
      else await chrome.storage.local.remove(ACTION_LOG_KEY);
    }
    return entries.length;
  });
}

// 확장이 시작될 때 만료 항목을 정리한다.
export function pruneActionLog(): void {
  void actionLogCount().catch(() => undefined);
}

export function clearActionLog(): Promise<void> {
  pending.clear();
  return enqueue(() => chrome.storage.local.remove(ACTION_LOG_KEY));
}
