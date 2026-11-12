// 경로 레시피(#297 2단계)의 턴 기록기·리스너·저장. 계산은 src/lib/pathRecipe.ts.
//
// 관찰: 턴이 도는 동안 그 턴의 원래 탭(최상위 프레임)에서 확정된 이동(webNavigation)과 최상위 요청(webRequest, 요청 ID 단위)을 적는다.
// 저장은 턴이 정상으로 끝나고, 제외 사유가 하나도 없고, 문서 확정마다 닫힌 요청 하나가 대응될 때만 한다(대응이 안 되거나 3초 안에
// 채워지지 않으면 저장하지 않음). 한번 제외된 턴은 되살리지 않는다.
// 턴 겹침(v5): 어느 순간이든 활성 턴이 둘 이상이면 그때 활성인 모든 턴을 제외한다(시작 순서·탭과 무관). 활성 구간은 beginPath부터
// commitPath의 쓰기 큐 반영이 끝날 때(또는 abortPath)까지다.
// 크롬 리스너는 처음 beginPath 때 한 번씩 걸고 떼지 않는다. 턴이 끝나면 그 턴의 구독(활성 턴 표의 항목)만 없앤다.
// 기존 navigation.ts·linkedPages.ts의 리스너와는 따로다(그쪽은 건드리지 않는다).
import { PATH_RECIPES_KEY } from "@/lib/messages";
import { urlPattern } from "@/lib/actionLog";
import {
  applyPath,
  foldPath,
  matchRequests,
  PATH_KEY_PREFIX,
  PATH_MAX_RAW,
  pathHintsFor,
  pathKeyOrigin,
  pathSavable,
  patternsOf,
  prunePaths,
  rawUrlRisk,
  removePathKeys,
  withoutHash,
  type ClosedRequest,
  type CommitRecord,
  type OfferedPath,
  type PathHint,
  type PathRecipe,
} from "@/lib/pathRecipe";
import { getSettings } from "./storage";
import { debugLog } from "./debug";
import { containsSecret } from "./loginSecrets";
import { enqueue, turnKey } from "./actionQueue";
import type { TurnTab } from "./tools/handlers";

// 문서 확정 ↔ 닫힌 요청 대응을 기다리는 최대 시간.
export const PATH_MATCH_WAIT_MS = 3_000;
// 비밀 값 검사에 넣을 리다이렉트·요청 주소 수의 상한(넘으면 헛돈 것으로 보고 제외).
const MAX_EXTRA_URLS = 120;
export const MAX_PATH_DELETE_MARKS = 400;

interface TurnPath {
  key: string;
  // 원래 탭. 오류 턴 탭이면 null(겹침 계산에만 든다).
  tabId: number | null;
  // 출발 출처. 배울 수 없는 턴(내부 페이지·http(s) 아님 등)이면 null.
  origin: string | null;
  startUrl: string;
  startDoc: string | null;
  // 시작 문서를 읽는 일(시크릿 창·시작 뒤 이동 확인 포함).
  startReady: Promise<void>;
  // 턴 시작 순번(삭제 표식과 비교).
  startSeq: number;
  // 제외 사유 코드(처음 것). 한번 정하면 되돌리지 않는다.
  taint: string | null;
  // 확정된 원본 주소(문서 이동·같은 문서 안 이동, 해시 포함) 순서대로.
  raw: string[];
  // 리다이렉트 중간 주소·요청 주소(걸음으로 세지 않고 검사에만 쓴다).
  extra: string[];
  commits: CommitRecord[];
  lastDoc: string | null;
  lastUrl: string;
  open: Map<string, string>;
  closed: ClosedRequest[];
  offered: OfferedPath[];
  // 구독 중인지(턴이 끝나면 false — 그 뒤 이벤트는 무시).
  listening: boolean;
  // 이 턴이 받은 이벤트 수(확정·같은 문서 안 이동·요청·오류). 마무리 판정 뒤 저장 직전에 달라졌으면 저장하지 않는다.
  events: number;
  waiters: Set<() => void>;
}

const turns = new Map<string, TurnPath>();
// 관찰(턴 시작)과 삭제가 나눠 쓰는 단조 증가 순번.
let seq = 0;
// 출처 → 그 출처의 경로를 지운 때의 순번. 그보다 앞서 시작한 턴은 그 출처에 쓰지 못한다.
const originMarks = new Map<string, number>();
// 이 순번보다 앞서 시작한 턴은 출처와 무관하게 쓰지 못한다(전체 지우기, 표식을 버릴 때).
let invalidBefore = 0;

function taint(rec: TurnPath, code: string): void {
  if (!rec.taint) rec.taint = code;
}

function wake(rec: TurnPath): void {
  for (const w of [...rec.waiters]) w();
}

function check(rec: TurnPath, url: string | undefined): void {
  if (!rec.origin) return;
  if (!url) {
    taint(rec, "bad_url");
    return;
  }
  const code = rawUrlRisk(url, rec.origin);
  if (code) taint(rec, code);
}

function noteExtra(rec: TurnPath, url: string | undefined): void {
  if (!url) return;
  if (rec.extra.length >= MAX_EXTRA_URLS) {
    taint(rec, "too_long");
    return;
  }
  rec.extra.push(url);
}

// 확정된 이동 하나(문서 이동이면 commit에 documentId).
function noteNav(rec: TurnPath, url: string, commit: { documentId?: string } | null): void {
  check(rec, url);
  rec.raw.push(url);
  if (rec.raw.length > PATH_MAX_RAW) taint(rec, "too_long");
  if (commit) {
    rec.commits.push({ documentId: commit.documentId, url: withoutHash(url) });
    rec.lastDoc = commit.documentId ?? null;
  }
  rec.lastUrl = url;
  const p = urlPattern(url);
  if (p && p.origin === rec.origin) for (const o of rec.offered) if (o.to === p.pattern) o.reached = true;
}

function forTab(tabId: number, fn: (rec: TurnPath) => void): void {
  if (tabId < 0) return;
  for (const rec of turns.values()) {
    if (!rec.listening || rec.tabId !== tabId) continue;
    rec.events++;
    fn(rec);
    wake(rec);
  }
}

let listening = false;
function ensureListeners(): void {
  if (listening) return;
  if (typeof chrome === "undefined" || !chrome.webNavigation?.onCommitted || !chrome.webRequest?.onBeforeRequest) return;
  listening = true;
  chrome.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0) return;
    forTab(d.tabId, (rec) => noteNav(rec, d.url, { documentId: (d as { documentId?: string }).documentId }));
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    forTab(d.tabId, (rec) => noteNav(rec, d.url, null));
  });
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => {
    if (d.frameId !== 0) return;
    forTab(d.tabId, (rec) => noteNav(rec, d.url, null));
  });
  chrome.webNavigation.onErrorOccurred.addListener((d) => {
    if (d.frameId !== 0) return;
    forTab(d.tabId, (rec) => taint(rec, "nav_error"));
  });
  const filter: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"], types: ["main_frame"] };
  // tabId -1(확장 자신의 fetch 등)은 forTab이 거른다.
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    forTab(d.tabId, (rec) => {
      rec.open.set(d.requestId, d.url);
      check(rec, d.url);
      noteExtra(rec, d.url);
    });
    return undefined;
  }, filter);
  chrome.webRequest.onBeforeRedirect.addListener((d) => {
    forTab(d.tabId, (rec) => {
      check(rec, d.url);
      check(rec, d.redirectUrl);
      noteExtra(rec, d.redirectUrl);
      if (rec.open.has(d.requestId)) rec.open.set(d.requestId, d.redirectUrl);
    });
  }, filter);
  chrome.webRequest.onCompleted.addListener((d) => {
    forTab(d.tabId, (rec) => {
      // 턴이 시작하기 전에 열린 요청은 리다이렉트를 다 보지 못했으므로 대응에 쓰지 않는다(그 확정은 대응되지 않아 저장 안 됨).
      if (!rec.open.has(d.requestId)) return;
      rec.open.delete(d.requestId);
      check(rec, d.url);
      rec.closed.push({ requestId: d.requestId, url: withoutHash(d.url) });
    });
  }, filter);
  chrome.webRequest.onErrorOccurred.addListener((d) => {
    forTab(d.tabId, (rec) => {
      if (!rec.open.has(d.requestId)) return;
      rec.open.delete(d.requestId);
      taint(rec, "request_error");
    });
  }, filter);
}

// 턴 시작(inheritPopups가 끝나 원래 탭이 확정된 뒤). 모든 ChatAgent 턴이 부른다(배울 수 없는 턴도 겹침 계산에 든다).
export function beginPath(turnTab: TurnTab, startUrl: string | null): void {
  const key = turnKey(turnTab);
  const old = turns.get(key);
  if (old) end(old);
  const tabId = "tabId" in turnTab ? turnTab.tabId : null;
  const start = "tabId" in turnTab && !turnTab.internal && startUrl ? urlPattern(startUrl) : null;
  const rec: TurnPath = {
    key,
    tabId,
    origin: start?.origin ?? null,
    startUrl: startUrl ?? "",
    startDoc: null,
    startReady: Promise.resolve(),
    startSeq: ++seq,
    taint: null,
    raw: [],
    extra: [],
    commits: [],
    lastDoc: null,
    lastUrl: startUrl ?? "",
    open: new Map(),
    closed: [],
    offered: [],
    listening: true,
    events: 0,
    waiters: new Set(),
  };
  turns.set(key, rec);
  // 다른 턴과 겹치면 그때 활성인 모든 턴을 제외한다.
  if (turns.size > 1) for (const t of turns.values()) taint(t, "overlap");
  if (!rec.origin || tabId === null) return;
  check(rec, rec.startUrl);
  // 물려받은 팝업·새 탭을 따라가는 상태로 시작한 턴은 처음부터 제외(나중에 원래 탭으로 돌아와도 되살리지 않음).
  if ("tabId" in turnTab && turnTab.popups?.length) taint(rec, "popup");
  ensureListeners();
  rec.startReady = (async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.incognito) taint(rec, "incognito");
      // 시작 주소를 읽은 뒤 구독 전에 옮겨 갔으면 그 이동을 보지 못했다.
      if (tab.url !== rec.startUrl) taint(rec, "start_moved");
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      rec.startDoc = (frame as { documentId?: string } | null)?.documentId ?? null;
    } catch {
      taint(rec, "start_unknown");
    }
  })();
}

// 이 턴의 경로를 저장하지 않게 한다(위험 동작·sign_in·손 넘기기·팝업 따라가기 등). 활성 턴이 없으면 아무것도 하지 않는다.
export function markPathRisk(turnTab: TurnTab, code: string): void {
  const rec = turns.get(turnKey(turnTab));
  if (rec) taint(rec, code);
}

function end(rec: TurnPath): void {
  rec.listening = false;
  wake(rec);
  rec.waiters.clear();
  if (turns.get(rec.key) === rec) turns.delete(rec.key);
}

// 저장 없이 턴을 끝낸다(중단·오류·저장 조건이 아님).
export function abortPath(turnTab: TurnTab): void {
  const rec = turns.get(turnKey(turnTab));
  if (rec) end(rec);
}

const deletedSince = (rec: TurnPath) =>
  invalidBefore > rec.startSeq || (rec.origin !== null && (originMarks.get(rec.origin) ?? 0) > rec.startSeq);

// (a) 열린 요청 없음 (b) 확정마다 닫힌 요청 하나 (c) 남는 닫힌 요청 없음이 채워질 때까지 최대 ms 기다린다.
async function waitMatch(rec: TurnPath, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (matchRequests(rec.commits, rec.closed, rec.open.size) === "ok") return true;
    const left = until - Date.now();
    if (left <= 0 || !rec.listening) return false;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        rec.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, left);
      rec.waiters.add(done);
    });
  }
}

export interface CommitPathOpts {
  // 턴이 정상으로 끝났는지(completed && !isStale && !externalContent — commitReads와 같은 조건).
  ok: boolean;
  // 지금도 이 턴이 살아 있는지(중단·새 턴에 밀리지 않았고 외부 본문 보호가 켜지지 않음). 기다릴 때마다 다시 본다.
  isLive: () => boolean;
  // 원래 탭이 다 뜨기를 기다려 그 문서·주소를 돌려준다(agent/tabContext.ts loadedPage). 제때 안 뜨면 null.
  loadedPage: (tabId: number) => Promise<{ documentId: string | null; url: string } | null>;
  // 요청 대응을 기다리는 최대 시간(기본 PATH_MATCH_WAIT_MS). 단위 시험이 줄여 쓴다.
  matchWaitMs?: number;
}

// 턴 끝. 저장 조건을 모두 확인하고 쓰기 큐에서 반영한다. 끝나면(성공·실패 모두) 이 턴의 구독을 없앤다.
export async function commitPath(turnTab: TurnTab, opts: CommitPathOpts): Promise<void> {
  const rec = turns.get(turnKey(turnTab));
  if (!rec) return;
  try {
    const skip = await runCommit(rec, opts);
    if (skip) debugLog("path_recipe:skip", skip);
  } catch (err) {
    debugLog("path_recipe:skip", err instanceof Error && err.message === "secrets" ? "secret_check" : "error", "warn");
  } finally {
    end(rec);
  }
}

async function noSecret(value: unknown): Promise<boolean> {
  try {
    return !(await containsSecret(value));
  } catch {
    // 가림 목록을 읽지 못하면 저장하지 않는다.
    throw new Error("secrets");
  }
}

// 저장하지 않은 사유 코드(조용히 끝낼 때는 null).
async function runCommit(rec: TurnPath, opts: CommitPathOpts): Promise<string | null> {
  if (!rec.origin || rec.tabId === null) return null;
  const tabId = rec.tabId;
  const origin = rec.origin;
  const alive = () => opts.isLive() && !rec.taint && !deletedSince(rec);
  const why = () => rec.taint ?? (deletedSince(rec) ? "deleted" : "stale");
  // 움직이지도(확정·열린 요청·닫힌 요청 없음) 후보를 내지도 않은 턴은 볼 것이 없다. 이동을 시작만 하고 끝난 턴(느린 응답)은
  // 열린 요청이 있으므로 아래에서 다 뜨기를 기다린다.
  const moved = rec.raw.length > 0 || rec.offered.length > 0 || rec.open.size > 0 || rec.closed.length > 0;
  if (!opts.ok) return moved ? "not_ok" : null;
  if (!moved) return null;
  if (!alive()) return why();
  await rec.startReady;
  if (!alive()) return why();
  if (!(await getSettings()).actionLogEnabled) return "disabled";
  if (!alive()) return why();
  const page = await opts.loadedPage(tabId);
  if (!alive()) return why();
  if (!page) return "not_loaded";
  // 다 뜬 문서·주소가 마지막 확정 건과 같아야 한다(이동 직후 끝난 턴이 옛 주소를 도착으로 보지 않게).
  const lastDoc = rec.commits.length ? rec.lastDoc : rec.startDoc;
  if (!page.documentId || page.documentId !== lastDoc || page.url !== rec.lastUrl) return "final_mismatch";
  const nRaw = rec.raw.length;
  const matched = await waitMatch(rec, opts.matchWaitMs ?? PATH_MATCH_WAIT_MS);
  if (!alive()) return why();
  if (!matched) return "unmatched";
  // 기다리는 사이 또 옮겼으면 다 뜬 문서가 도착이 아니다.
  if (rec.raw.length !== nRaw) return "moved";
  // 마무리 판정(대응 확인) 때의 관찰 상태. 저장 직전에 다시 보고 달라졌으면(또 이동·요청이 생김) 더 기다리지 않고 버린다.
  const seenEvents = rec.events;
  const lastDocAtCheck = rec.lastDoc;
  const lastUrlAtCheck = rec.lastUrl;
  const rawPatterns = patternsOf([rec.startUrl, ...rec.raw], origin);
  if (!rawPatterns) return "bad_url";
  // 원본 주소(확정·리다이렉트·요청)에 자동 로그인 값이 보이면 저장하지 않는다(접기 전에 원본으로).
  if (!(await noSecret([rec.startUrl, ...rec.raw, ...rec.extra]))) return "secret";
  if (!alive()) return why();
  const steps = foldPath(rawPatterns);
  const observed = pathSavable(steps) ? { origin, steps } : null;
  const finalPattern = rawPatterns[rawPatterns.length - 1];
  const offered = rec.offered.filter((o) => o.reached);
  if (!observed && !offered.length) return "not_savable";
  const settled = () =>
    rec.listening &&
    rec.events === seenEvents &&
    rec.raw.length === nRaw &&
    rec.lastDoc === lastDocAtCheck &&
    rec.lastUrl === lastUrlAtCheck &&
    matchRequests(rec.commits, rec.closed, rec.open.size) === "ok";
  return enqueue(async () => {
    if (!(await getSettings()).actionLogEnabled) return "disabled";
    const now = Date.now();
    const obj = await chrome.storage.local.get(PATH_RECIPES_KEY);
    const res = applyPath(prunePaths(obj[PATH_RECIPES_KEY], now), observed, offered, finalPattern, now, () => crypto.randomUUID());
    // 저장 직전 정규화된 틀 전체에도 비밀 값 검사(퍼센트 인코딩을 풀어 값이 드러날 수 있다). 쓴 횟수만 고치는 경우도 같다.
    for (const r of res.touched) if (!(await noSecret({ origin: r.origin, steps: r.steps }))) return "secret";
    // 반영 직전(마지막 await 뒤)에 중단·제외·삭제 순번과 이동·요청 상태를 다시 본다.
    if (!alive()) return why();
    if (!settled()) return "moved";
    await savePaths(res.next);
    debugLog(
      "path_recipe:result",
      `${steps.length}걸음 ${steps.join(" → ")} · 쓴 횟수 +${res.used} · 빗나감 ${res.missed}${res.created ? " · 새 경로" : ""}`,
    );
    return null;
  });
}

async function savePaths(list: PathRecipe[]): Promise<void> {
  if (list.length) await chrome.storage.local.set({ [PATH_RECIPES_KEY]: list });
  else await chrome.storage.local.remove(PATH_RECIPES_KEY);
}

// 쓰기 큐 안에서 부른다: 만료·꺼진 것을 정리한 목록. 줄었으면 저장소에도 반영한다.
async function loadPruned(): Promise<PathRecipe[]> {
  const obj = await chrome.storage.local.get(PATH_RECIPES_KEY);
  const raw = obj[PATH_RECIPES_KEY];
  const kept = prunePaths(raw, Date.now());
  if (raw !== undefined && (!Array.isArray(raw) || raw.length !== kept.length)) await savePaths(kept);
  return kept;
}

// describe_page 결과에 붙일 후보. 같은 출처, 지금 틀이 steps 안에 있고 도착 틀이 아닌 경로의 남은 구간. 자동 로그인 값이 보이는
// 경로는 내지 않는다(가림 목록을 읽지 못하면 하나도 내지 않음). 낸 경로는 이 턴의 기록에 남겨 쓴 횟수·빗나감을 센다.
export async function offerPathHints(turnTab: TurnTab, url: string): Promise<PathHint[]> {
  const p = urlPattern(url);
  if (!p) return [];
  const obj = await chrome.storage.local.get(PATH_RECIPES_KEY);
  const now = Date.now();
  const picked = pathHintsFor(prunePaths(obj[PATH_RECIPES_KEY], now), p.origin, p.pattern, now);
  const hints: PathHint[] = [];
  const offered: OfferedPath[] = [];
  for (const h of picked) {
    if (await containsSecret({ origin: p.origin, steps: h.offered.steps, to: h.offered.to })) continue;
    hints.push(h.hint);
    offered.push(h.offered);
  }
  const rec = turns.get(turnKey(turnTab));
  if (rec?.listening) for (const o of offered) if (!rec.offered.some((x) => x.id === o.id)) rec.offered.push(o);
  for (const h of hints) debugLog("path_recipe:offered", `${h.steps.map((s) => s.pattern).join(" → ")} · 쓴 횟수 ${h.uses}번`);
  return hints;
}

export function pathRecipeCount(): Promise<number> {
  return enqueue(async () => (await loadPruned()).length);
}

// 설정 화면의 목록. 자동 로그인 값이 보이는 경로는 뺀다(가림 목록을 읽지 못하면 오류).
export function listPaths(): Promise<PathRecipe[]> {
  return enqueue(async () => {
    const kept = await loadPruned();
    const shown: PathRecipe[] = [];
    for (const r of kept) if (!(await containsSecret({ origin: r.origin, steps: r.steps }))) shown.push(r);
    return shown;
  });
}

// 큐에 넣기 전에 동기적으로 그 출처의 삭제 표식 순번을 올리고 그 출처의 진행 중 턴을 제외한다.
function markOriginDeleted(origin: string): void {
  originMarks.delete(origin);
  originMarks.set(origin, ++seq);
  while (originMarks.size > MAX_PATH_DELETE_MARKS) {
    const [oldest, at] = originMarks.entries().next().value as [string, number];
    originMarks.delete(oldest);
    invalidBefore = Math.max(invalidBefore, at);
  }
  for (const rec of turns.values()) if (rec.origin === origin) taint(rec, "deleted");
}

// 설정 화면에서 고른 경로를 지운다. 그때의 저장 목록에서 그 key만 뺀다. 응답은 새 개수.
export function deletePaths(keys: readonly string[]): Promise<number> {
  const set = new Set(keys.filter((k) => k.startsWith(PATH_KEY_PREFIX)));
  for (const k of set) {
    const origin = pathKeyOrigin(k);
    if (origin) markOriginDeleted(origin);
  }
  return enqueue(async () => {
    const kept = await loadPruned();
    if (!set.size) return kept.length;
    const next = removePathKeys(kept, set);
    if (next.length !== kept.length) await savePaths(next);
    return next.length;
  });
}

// 전체 지우기: 진행 중인 모든 턴을 제외하고 그 전에 시작한 턴은 쓰지 못하게 한다(저장소는 부르는 쪽이 같은 큐에서 지운다).
export function clearPendingPaths(): void {
  for (const rec of turns.values()) taint(rec, "deleted");
  originMarks.clear();
  invalidBefore = ++seq;
}

// 시험용: 지금 활성 턴 수.
export function activePathTurns(): number {
  return turns.size;
}
