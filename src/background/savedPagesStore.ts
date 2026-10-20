import { addPage, candidatesFor, candidatesText, normalizeName, parseSaved, type SavedPage } from "@/lib/savedPages";
import { sensitiveUrlReason } from "@/lib/autoApprove";
import { siteOf, withinSite } from "@/lib/siteTrust";
import { getSettings } from "./storage";
import { enqueue } from "./actionLog";
import { debugLog } from "./debug";

// "이 페이지 기억하기"(#30). 저장은 사용자가 패널에서 이름을 확인하고 누를 때만 한다. 저장 후보 제공은
// 대화 기록에 남기지 않는 임시 데이터 메시지로 매 모델 요청 직전에 새로 만든다(지우기·끄기가 다음 요청부터 반영).

export const SAVED_PAGES_KEY = "savedPages";
const MAX_OFFERS = 10;

export interface PageOffer {
  offerId: string;
  url: string;
  title: string;
  site: string;
  // 주소에 결제·개인정보 단서가 보이면 그 이유(저장하려면 사용자가 한 번 더 확인).
  warning: string | null;
}

const offers = new Map<string, PageOffer>();

async function load(): Promise<SavedPage[]> {
  const obj = await chrome.storage.local.get(SAVED_PAGES_KEY);
  return parseSaved(obj[SAVED_PAGES_KEY]);
}

// 구조적으로 저장하지 않는 주소: http(s)가 아니거나 계정 정보가 실린 주소.
function structuralBlock(url: string): boolean {
  try {
    const u = new URL(url);
    return !/^https?:$/.test(u.protocol) || !!u.username || !!u.password;
  } catch {
    return true;
  }
}

// 턴이 정상으로 끝나고 탭이 턴 시작 때와 다른 화면(해시 포함)에 있으면 저장 제안을 만든다.
export async function makeOffer(tabId: number, startUrl: string | null): Promise<PageOffer | null> {
  if (!(await getSettings()).rememberPages) return null;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
  const url = tab.url ?? "";
  if (tab.incognito || !url || url === startUrl || structuralBlock(url)) return null;
  const site = siteOf(url);
  if (!site) return null;
  const offer: PageOffer = {
    offerId: crypto.randomUUID(),
    url,
    title: normalizeName(tab.title ?? "") || url,
    site,
    warning: sensitiveUrlReason(url),
  };
  offers.set(offer.offerId, offer);
  while (offers.size > MAX_OFFERS) {
    const oldest = offers.keys().next().value;
    if (oldest === undefined) break;
    offers.delete(oldest);
  }
  return offer;
}

export async function savePage(offerId: string, name: string, confirmedWarning: boolean): Promise<void> {
  const offer = offers.get(offerId);
  if (!offer) throw new Error("저장 제안이 만료됐습니다. 다시 요청해 주세요.");
  if (!(await getSettings()).rememberPages) throw new Error("페이지 기억하기가 꺼져 있습니다.");
  if (offer.warning && !confirmedWarning) throw new Error("주소의 경고를 확인해야 저장할 수 있습니다.");
  const clean = normalizeName(name) || offer.title;
  offers.delete(offerId);
  await enqueue(async () => {
    const next = addPage(await load(), { name: clean, url: offer.url, site: offer.site, savedAt: Date.now(), uses: 0 });
    await chrome.storage.local.set({ [SAVED_PAGES_KEY]: next });
  });
}

export async function listPages(): Promise<SavedPage[]> {
  return load();
}

export async function deletePages(url: string | null): Promise<void> {
  await enqueue(async () => {
    if (url === null) {
      await chrome.storage.local.remove(SAVED_PAGES_KEY);
      return;
    }
    await chrome.storage.local.set({ [SAVED_PAGES_KEY]: (await load()).filter((p) => p.url !== url) });
  });
}

// 매 모델 요청 직전: 턴 탭이 시크릿이거나 확인할 수 없으면 후보를 주지 않는다.
export async function candidatesMessage(tabId: number | null): Promise<string | null> {
  if (tabId === null || !(await getSettings()).rememberPages) return null;
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
  if (tab.incognito || !tab.url) return null;
  const site = siteOf(tab.url);
  if (!site) return null;
  const items = candidatesFor(await load(), (u) => withinSite(site, u));
  return items.length ? candidatesText(items) : null;
}

// uses: 저장 주소로 navigate_to_url을 실행했고, 이어진 관측이 같은 주소(해시 포함)에서 성공했을 때만 +1.
export async function noteObservedAt(url: string, navigatedTo: string | null): Promise<void> {
  if (!navigatedTo || url !== navigatedTo) return;
  await enqueue(async () => {
    const list = await load();
    const hit = list.find((p) => p.url === url);
    if (!hit) return;
    hit.uses += 1;
    await chrome.storage.local.set({ [SAVED_PAGES_KEY]: list });
    debugLog("saved_pages:use", url.slice(0, 80));
  });
}

export async function isSavedUrl(url: string): Promise<boolean> {
  return (await load()).some((p) => p.url === url);
}
