import type { ContentResponse } from "@/lib/messages";
import { withTimeout } from "@/lib/async";
import {
  MAX_TAB_LINKS,
  OPEN_TABS_KEY,
  TabOwnership,
  planTabCandidates,
  runTabReads,
  type TabCandidate,
  type TabLinkDeps,
  type TabRead,
} from "@/lib/linkTabs";
import { INJECT_READY_DELAYS_MS, injectContentScriptInDocument, isMissingReceiver, resolveTurnTab, type TurnTab } from "./tools/handlers";
import { rememberedPageLink } from "./linkedPages";
import { debugLog } from "./debug";

// read_links_in_tabs(#293): 지금 페이지의 링크를 로그인된 상태로 비활성 탭에서 열어 본문을 읽고 닫는다.
// 카드를 띄우기 전에 후보(열 주소 = 페이지의 href 그대로)를 고정하고, 사용자가 고른 id의 주소만 연다.
// 판단·실행 순서는 src/lib/linkTabs.ts(단위 시험), 여기서는 chrome 호출만 넘긴다.

const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_SNAPSHOTS = 20;
const CLEANUP_MS = 5_000;

interface Snapshot {
  turnTab: TurnTab;
  list: TabCandidate[];
}

const snapshots = new Map<string, Snapshot>();
const chosen = new Map<string, string[]>();

async function loadOwned(): Promise<number[]> {
  const got = await chrome.storage.session.get(OPEN_TABS_KEY);
  const ids = got[OPEN_TABS_KEY];
  return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === "number") : [];
}

async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

const ownership = new TabOwnership({
  get: (id) => withTimeout(getTab(id), CLEANUP_MS, "탭 확인 시간 초과"),
  remove: (id) => withTimeout(chrome.tabs.remove(id), CLEANUP_MS, "탭 닫기 시간 초과"),
  loadOwned,
  saveOwned: (ids) => chrome.storage.session.set({ [OPEN_TABS_KEY]: ids }),
  log: (tag, msg, level) => debugLog(tag, msg, level),
});

// 사용자가 이 도구가 연 탭을 앞으로 가져오면 그 탭은 사용자의 탭이다(읽지도 닫지도 않음).
chrome.tabs.onActivated.addListener(({ tabId }) => ownership.noteActivated(tabId));

// 초기 청소: 서비스 워커가 죽어 남은 탭을 닫는다. 실행은 이 약속을 기다린 뒤 시작한다(청소가 새 실행의 탭을 닫지 않게).
const ready: Promise<unknown> = ownership.cleanup().catch(() => {});

export async function snapshotTabLinks(
  callId: string,
  turnTab: TurnTab,
  urls: string[],
): Promise<{ choices: Array<{ id: string; label: string; sub: string }>; rejected: string[] }> {
  const tabId = await resolveTurnTab(turnTab);
  const tab = await chrome.tabs.get(tabId);
  if (tab.incognito) throw new Error("시크릿 창에서는 링크를 탭으로 열어 읽지 않습니다.");
  const inputs = urls.slice(0, MAX_TAB_LINKS);
  // 기억한 리다이렉트 목적지의 원래 링크도 페이지에 글자 그대로 있는지 함께 본다.
  const remembered = inputs.map((u) => rememberedPageLink(turnTab, u)).filter((u): u is string => !!u);
  const lookup = [...new Set([...inputs, ...remembered])];
  const res = (await withTimeout(
    chrome.tabs.sendMessage(tabId, { kind: "link_lookup", urls: lookup, exact: true }, { frameId: 0 }),
    LOOKUP_TIMEOUT_MS,
    "페이지가 응답하지 않아 링크를 확인하지 못했습니다.",
  )) as ContentResponse<Array<{ url: string; present: boolean; text: string }>>;
  if (!res?.ok || !res.data) throw new Error(res?.error ?? "페이지의 링크를 확인하지 못했습니다.");
  const present = new Map<string, string>();
  for (const item of res.data) if (item.present) present.set(item.url, item.text);
  const { list, rejected } = planTabCandidates(
    inputs,
    (u) => (present.has(u) ? { text: present.get(u) ?? "" } : null),
    (u) => rememberedPageLink(turnTab, u),
    tab.url ?? "",
    () => crypto.randomUUID(),
  );
  if (!list.length) throw new Error(`탭으로 열어 읽을 수 있는 링크가 없습니다: ${rejected.join(", ")}`);
  snapshots.set(callId, { turnTab, list });
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return { choices: list.map((c) => ({ id: c.choiceId, label: c.label, sub: c.sub })), rejected };
}

// 승인 메시지·맡긴 작업의 선택. 고정한 후보에 없는 id는 버린다(모르는 callId는 무시).
export function setChosenTabLinks(callId: string, ids: string[]): void {
  const snap = snapshots.get(callId);
  if (!snap) return;
  const known = new Set(snap.list.map((c) => c.choiceId));
  chosen.set(callId, [...new Set(ids)].filter((id) => known.has(id)));
}

export function discardTabLinkCall(callId: string): void {
  snapshots.delete(callId);
  chosen.delete(callId);
}

// 고른 문서(documentId)에 본문 읽기를 보낸다. 받는 쪽이 없으면 그 문서에만 주입한 뒤 잠깐씩 기다리며 다시 보낸다.
// 기한·중단은 부르는 쪽(runTabReads)이 전체에 하나로 걸고, 여기서는 signal이 끊기면 재시도를 멈춘다.
async function readText(tabId: number, documentId: string, expectUrl: string, signal: AbortSignal): Promise<{ url: string; title: string; mainText: string }> {
  const send = async () => {
    const res = (await chrome.tabs.sendMessage(tabId, { kind: "read_page_text", expectUrl }, { documentId })) as ContentResponse<{
      url: string;
      title: string;
      mainText: string;
    }>;
    if (!res?.ok || !res.data) throw new Error(res?.error ?? "본문을 읽지 못했습니다.");
    return res.data;
  };
  try {
    return await send();
  } catch (err) {
    if (!isMissingReceiver(err)) throw err;
  }
  if (signal.aborted) throw new Error("aborted");
  debugLog("link_tabs:inject_retry", String(tabId), "warn");
  await injectContentScriptInDocument(tabId, documentId);
  let lastErr: unknown = null;
  for (const delay of INJECT_READY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (signal.aborted) throw new Error("aborted");
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isMissingReceiver(err)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function depsFor(turnTab: TurnTab): TabLinkDeps {
  return {
    turnTab: async () => {
      const id = await resolveTurnTab(turnTab);
      const t = await chrome.tabs.get(id);
      if (t.incognito) throw new Error("시크릿 창에서는 링크를 탭으로 열어 읽지 않습니다.");
      return { windowId: t.windowId, index: t.index };
    },
    // openerTabId는 주지 않는다(팝업 따라가기가 이 탭을 클릭으로 열린 팝업으로 잡지 않게).
    create: ({ url, windowId, index }) => chrome.tabs.create({ url, active: false, windowId, index }),
    get: getTab,
    remove: (id) => chrome.tabs.remove(id),
    mute: async (id) => {
      await chrome.tabs.update(id, { muted: true });
    },
    topDocumentId: async (id) => {
      try {
        const frame = await chrome.webNavigation.getFrame({ tabId: id, frameId: 0 });
        return frame?.documentId ?? null;
      } catch {
        return null;
      }
    },
    readText,
    loadOwned,
    saveOwned: (ids) => chrome.storage.session.set({ [OPEN_TABS_KEY]: ids }),
    log: (tag, msg, level) => debugLog(tag, msg, level),
  };
}

// 실행하는 동안 서비스 워커가 쉬는 것으로 보이지 않게 20초마다 확장 API를 부른다.
function holdWorker(): () => void {
  const timer = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
  return () => clearInterval(timer);
}

export async function readChosenTabLinks(callId: string, signal?: AbortSignal): Promise<TabRead[]> {
  const snap = snapshots.get(callId);
  const ids = chosen.get(callId) ?? [];
  discardTabLinkCall(callId);
  const picked = ids.map((id) => snap?.list.find((c) => c.choiceId === id)).filter((c): c is TabCandidate => !!c);
  if (!snap || !picked.length) throw new Error("사용자가 읽을 링크를 고르지 않았습니다.");
  const release = holdWorker();
  try {
    return await runTabReads(
      picked.map((c) => c.open),
      depsFor(snap.turnTab),
      ownership,
      ready,
      signal ?? new AbortController().signal,
    );
  } finally {
    release();
  }
}
