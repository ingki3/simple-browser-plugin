import type { PageImage } from "@/lib/messages";
import { imageSaveGrantBlock } from "@/lib/chatGrant";
import { DOWNLOAD_LIMITS, pickDownloadCandidates, urlFileName, type DownloadKind, type PageDownloadItem } from "@/lib/downloadPick";
import { callContentTool, queryContent, resolveTurnTab, type TurnTab } from "./tools/handlers";
import { waitForNavigationSettle } from "./navigation";

// download_images·download_files(#48): 카드를 띄우기 전에 모델이 넘긴 주소가 지금 페이지에 실제로 있는 이미지·링크인지
// 확인해 후보(id·주소)를 고정한다. 사용자가 카드에서 고른 id의 주소만 받는다(패널 메시지로는 고정한 후보의 id만 고를 수
// 있어 임의 주소를 넣을 수 없다). 실행은 모델 인자의 주소를 다시 쓰지 않고 이 후보만 쓴다.

const MAX_SNAPSHOTS = 20;
const LOOKUP_TIMEOUT_MS = 10_000;

export interface DownloadCandidateRef {
  choiceId: string;
  url: string;
  label: string;
}

interface Snapshot {
  kind: DownloadKind;
  list: DownloadCandidateRef[];
}

const snapshots = new Map<string, Snapshot>();
const chosen = new Map<string, string[]>();

export interface DownloadChoices {
  choices: Array<{ id: string; label: string; sub: string }>;
  defaults: string[];
  // 모델이 넘긴 주소의 후보 id(이번 대화 허락으로 카드 없이 받을 때 고르는 것).
  requestedIds: string[];
  rejected: string[];
  // 이미지 저장을 이번 대화 허락(#53)으로 덮지 못하는 이유. 파일은 허락 대상이 아니라 늘 null.
  grantBlock: string | null;
}

async function pageItems(kind: DownloadKind, callId: string, turnTab: TurnTab): Promise<PageDownloadItem[]> {
  if (kind === "image") {
    // list_page_images와 같은 수집(모델이 본 목록과 같은 순서).
    const images = await callContentTool<PageImage[]>("list_page_images", {}, callId, turnTab);
    return images.map((i) => ({
      url: i.url,
      label: i.alt,
      meta: i.width && i.height ? `${i.width}×${i.height}` : "",
      listed: true,
    }));
  }
  const tabId = await resolveTurnTab(turnTab);
  await waitForNavigationSettle(tabId, 10_000);
  const links = await queryContent<PageDownloadItem[]>(tabId, { kind: "download_links" }, LOOKUP_TIMEOUT_MS, "페이지 링크 확인");
  // 형식을 짐작하지 못한 링크는 주소의 파일 이름 확장자를 보인다.
  return links.map((l) => ({ ...l, meta: l.meta || (urlFileName(l.url)?.split(".").pop()?.toLowerCase() ?? "") }));
}

export async function snapshotDownloads(
  callId: string,
  turnTab: TurnTab,
  kind: DownloadKind,
  urls: string[],
): Promise<DownloadChoices> {
  const tabId = await resolveTurnTab(turnTab);
  let items: PageDownloadItem[];
  try {
    items = await pageItems(kind, callId, turnTab);
  } catch (err) {
    throw new Error(`지금 페이지의 ${kind === "image" ? "이미지" : "링크"}를 확인하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pageUrl = (await chrome.tabs.get(tabId)).url ?? "";
  const pick = pickDownloadCandidates(kind, urls, items, pageUrl);
  const rejected = pick.rejected.map((r) => `${r.url.slice(0, 120)} (${r.reason})`);
  const requested = pick.candidates.filter((c) => c.requested);
  if (!requested.length) {
    const how = kind === "image" ? "list_page_images" : "list_file_links";
    throw new Error(`받을 수 있는 주소가 없습니다(${how}가 준 주소 그대로 넘기세요): ${rejected.join(", ")}`);
  }
  const list: DownloadCandidateRef[] = [];
  const choices: DownloadChoices["choices"] = [];
  const defaults: string[] = [];
  const requestedIds: string[] = [];
  for (const c of pick.candidates) {
    const choiceId = crypto.randomUUID();
    list.push({ choiceId, url: c.url, label: c.label });
    choices.push({ id: choiceId, label: c.label, sub: c.sub });
    if (c.defaultOn) defaults.push(choiceId);
    if (c.requested) requestedIds.push(choiceId);
  }
  snapshots.set(callId, { kind, list });
  // 같은 callId로 전에 고른 것이 남아 있어도 새 후보에는 쓰지 않는다(id는 후보마다 새로 만든다).
  chosen.delete(callId);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
    chosen.delete(oldest);
  }
  // 허락 판정은 모델이 넘긴 주소 전부를 본다(페이지에 없는 주소가 하나라도 섞이면 카드로 묻는다).
  const grantBlock = kind === "image" ? imageSaveGrantBlock(urls, new Set(items.map((i) => i.url))) : null;
  return { choices, defaults: defaults.slice(0, DOWNLOAD_LIMITS[kind].maxPick), requestedIds, rejected, grantBlock };
}

// 카드에서 고른 id 중 고정한 후보에 있는 것만 남긴다(최대 선택 수까지).
export function setChosenDownloads(callId: string, ids: string[]): void {
  const snap = snapshots.get(callId);
  if (!snap) return;
  const known = new Set(snap.list.map((c) => c.choiceId));
  chosen.set(callId, [...new Set(ids)].filter((id) => known.has(id)).slice(0, DOWNLOAD_LIMITS[snap.kind].maxPick));
}

export function discardDownloadCall(callId: string): void {
  snapshots.delete(callId);
  chosen.delete(callId);
}

// 고른 후보(후보 순서대로). 고르지 않았거나 종류가 다르면 빈 배열(받지 않는다).
export function chosenDownloads(callId: string, kind: DownloadKind): DownloadCandidateRef[] {
  const snap = snapshots.get(callId);
  const ids = new Set(chosen.get(callId) ?? []);
  if (!snap || snap.kind !== kind) return [];
  return snap.list.filter((c) => ids.has(c.choiceId));
}

// 실행 뒤 후보를 버린다(같은 승인으로 두 번 받지 않게).
export function takeChosenDownloads(callId: string, kind: DownloadKind): DownloadCandidateRef[] {
  const out = chosenDownloads(callId, kind);
  discardDownloadCall(callId);
  return out;
}
