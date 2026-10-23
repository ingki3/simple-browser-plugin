import type { ContentResponse } from "@/lib/messages";
import {
  currentToolTab,
  INJECT_READY_DELAYS_MS,
  injectContentScriptInDocument,
  isMissingReceiver,
  type TurnTab,
} from "./tools/handlers";
import { debugLog } from "./debug";

// 다른 탭 참조(read_other_tabs). 탭 목록은 모델에 보내지 않는다: 승인 카드를 띄우기 전에 같은 창의 후보를
// 스냅샷(탭·최상위 문서·정확한 주소)으로 고정하고 패널에는 제목·사이트만 보낸다. 사용자가 고른 후보 id만 받아,
// 승인 직후 후보 조건 전체를 다시 확인한 뒤 그 문서(documentId 지정)에서만 본문을 읽는다.

export const MAX_TABS_PER_CALL = 5;
const PER_TAB_CHARS = 12_000;
const TOTAL_CHARS = 40_000;
const READ_TIMEOUT_MS = 10_000;
const MAX_SNAPSHOTS = 20;

interface Snapshot {
  choiceId: string;
  tabId: number;
  windowId: number;
  documentId: string;
  url: string;
  title: string;
}

export interface TabChoice {
  id: string;
  label: string;
  sub: string;
}

const snapshots = new Map<string, Snapshot[]>();
const chosen = new Map<string, string[]>();

function isWebUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function topDocumentId(tabId: number): Promise<string | null> {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return frame?.documentId ?? null;
  } catch {
    return null;
  }
}

// 지금 도구가 동작하는 탭(다른 탭 후보에서 뺀다). 탭으로 열린 팝업을 따라가는 중이면 그 탭이고, 원래 탭은 같은 창의
// 다른 탭으로 고를 수 있다. 팝업 창(별도 창)을 따라가는 중이면 원래 탭과 그 창을 기준으로 한다(기존과 같음).
// 닫힌 팝업은 먼저 걷어 낸다(currentToolTab) — 닫힌 탭 팝업을 지금 탭으로 보고 원래 탭을 후보에 넣지 않게.
async function selfTabId(turnTab: Extract<TurnTab, { tabId: number }>): Promise<number> {
  const current = await currentToolTab(turnTab);
  return current?.asTab ? current.tabId : turnTab.tabId;
}

// 후보 조건: 턴 탭과 같은 창, 시크릿 아님, http(s), 턴 탭 아님, 메모리에서 내려가지 않음, 로딩 완료.
function eligible(tab: chrome.tabs.Tab, turnTabId: number, windowId: number): boolean {
  return (
    tab.id !== undefined &&
    tab.id !== turnTabId &&
    tab.windowId === windowId &&
    !tab.incognito &&
    !tab.discarded &&
    tab.status === "complete" &&
    isWebUrl(tab.url)
  );
}

// 승인 카드 전: 후보를 고정하고 카드에 보일 선택지를 돌려준다. 후보가 없으면 오류.
export async function snapshotCandidates(callId: string, turnTab: TurnTab): Promise<TabChoice[]> {
  if (!("tabId" in turnTab)) throw new Error(turnTab.error);
  const self = await selfTabId(turnTab);
  const turn = await chrome.tabs.get(turnTab.tabId);
  const tabs = await chrome.tabs.query({ windowId: turn.windowId });
  const list: Snapshot[] = [];
  for (const tab of tabs) {
    if (!eligible(tab, self, turn.windowId) || tab.id === undefined || !tab.url) continue;
    const documentId = await topDocumentId(tab.id);
    if (!documentId) continue;
    list.push({
      choiceId: crypto.randomUUID(),
      tabId: tab.id,
      windowId: turn.windowId,
      documentId,
      url: tab.url,
      title: (tab.title ?? "").slice(0, 120),
    });
  }
  if (!list.length) throw new Error("같은 창에 읽을 수 있는 다른 탭이 없습니다(웹 페이지가 열린 다른 탭이 필요합니다).");
  snapshots.set(callId, list);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  return list.map((s) => ({ id: s.choiceId, label: s.title || originOf(s.url), sub: originOf(s.url) }));
}

// 승인 메시지로 받은 선택. 고정한 후보에 없는 id·상한을 넘는 선택은 버린다.
export function setChosen(callId: string, ids: string[]): void {
  const known = new Set((snapshots.get(callId) ?? []).map((s) => s.choiceId));
  chosen.set(callId, [...new Set(ids)].filter((id) => known.has(id)).slice(0, MAX_TABS_PER_CALL));
}

export function discardCall(callId: string): void {
  snapshots.delete(callId);
  chosen.delete(callId);
}

type TabRead =
  | { title: string; origin: string; mainText: string; truncated: boolean }
  | { title: string; origin: string; error: string };

// 승인 직후: 고른 후보마다 조건 전체를 다시 확인하고, 그 문서에서만 본문을 읽는다.
export async function readChosenTabs(callId: string, turnTab: TurnTab, signal?: AbortSignal): Promise<TabRead[]> {
  const list = snapshots.get(callId) ?? [];
  const ids = chosen.get(callId) ?? [];
  discardCall(callId);
  if (!ids.length) throw new Error("사용자가 읽을 탭을 고르지 않았습니다.");
  if (!("tabId" in turnTab)) throw new Error(turnTab.error);
  const self = await selfTabId(turnTab);
  const turn = await chrome.tabs.get(turnTab.tabId);
  const out: TabRead[] = [];
  let total = 0;
  for (const id of ids) {
    const snap = list.find((s) => s.choiceId === id);
    if (!snap) continue;
    const base = { title: snap.title, origin: originOf(snap.url) };
    if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(snap.tabId);
    } catch {
      out.push({ ...base, error: "탭이 닫혔습니다." });
      continue;
    }
    const docId = await topDocumentId(snap.tabId);
    if (
      !eligible(tab, self, turn.windowId) ||
      tab.windowId !== snap.windowId ||
      tab.url !== snap.url ||
      docId !== snap.documentId
    ) {
      out.push({ ...base, error: "고른 뒤 탭이 바뀌었습니다(이동·새로고침·창 이동 등). 다시 요청해 주세요." });
      continue;
    }
    try {
      const res = await readTabText(snap.tabId, snap.documentId, snap.url, signal);
      if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
      if (!res?.ok || !res.data) {
        out.push({ ...base, error: res?.error ?? "본문을 읽지 못했습니다." });
        continue;
      }
      if (res.data.url !== snap.url) {
        out.push({ ...base, error: "고른 뒤 탭이 바뀌었습니다. 다시 요청해 주세요." });
        continue;
      }
      const room = Math.max(0, Math.min(PER_TAB_CHARS, TOTAL_CHARS - total));
      const text = res.data.mainText.slice(0, room);
      total += text.length;
      out.push({ ...base, mainText: text, truncated: text.length < res.data.mainText.length });
    } catch (err) {
      if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("other_tabs:read_fail", msg, "warn");
      out.push({ ...base, error: "이 탭의 내용을 읽지 못했습니다. 탭을 새로고침한 뒤 다시 요청해 주세요." });
    }
  }
  return out;
}

type PageText = ContentResponse<{ url: string; title: string; mainText: string }>;

// 고른 문서(documentId)에 본문 읽기를 보낸다. 확장을 다시 불러오기 전에 열려 있던 탭에는 content script가 없어
// "Receiving end does not exist"로 실패하므로, 그 문서에만 주입(documentIds로 고정 — 그 사이 문서가 바뀌었으면 주입이
// 실패한다)한 뒤 잠깐씩 기다리며 다시 보낸다.
async function readTabText(tabId: number, documentId: string, url: string, signal?: AbortSignal): Promise<PageText> {
  const send = () =>
    Promise.race([
      chrome.tabs.sendMessage(tabId, { kind: "read_page_text", expectUrl: url }, { documentId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("응답 시간 초과")), READ_TIMEOUT_MS)),
    ]) as Promise<PageText>;
  try {
    return await send();
  } catch (err) {
    if (!isMissingReceiver(err)) throw err;
  }
  if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
  debugLog("other_tabs:inject_retry", String(tabId), "warn");
  await injectContentScriptInDocument(tabId, documentId);
  let lastErr: unknown = null;
  for (const delay of INJECT_READY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (signal?.aborted) throw new Error("사용자가 중단했습니다.");
    try {
      return await send();
    } catch (err) {
      lastErr = err;
      if (!isMissingReceiver(err)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
