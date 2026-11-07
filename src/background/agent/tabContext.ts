// 턴 탭의 문맥(#263 단계 2 — chatAgent.ts에서 그대로 옮김): 탭이 다 떴는지, 탭 머리말, 도구가 동작하는 탭의 주소.
// 대화 상태는 ChatAgent가 갖는다. 지금 턴의 탭은 값이 아니라 getter로 받는다 — 탭 머리말은 탭 조회를 기다린 뒤
// 지금 턴의 탭을 다시 읽는다(옮기기 전 this.turnTab을 읽던 시점·횟수 그대로). toolTabUrl은 호출이 받은 턴 탭(고정 값)을 쓴다.
import { popupWhere } from "@/lib/actionTarget";
import { isBrowserInternalUrl } from "@/lib/siteTrust";
import { youtubeVideoId } from "@/lib/youtubeUrl";
import { currentToolTab, topDocumentId, type TurnTab } from "../tools/handlers";

// 정해진 탭으로 턴 탭을 만든다(반복 작업의 이어서 진행). 탭이 없으면 오류 턴 탭 — 활성 탭으로 대신하지 않는다.
// 기억하기 제안(#240): 탭이 로딩 중이면 최대 3초 기다린다(이동 직후 끝난 턴·도구가 옛 주소와 글자로 제안하지 않게).
// 다 떴으면 true, 그때도 로딩 중이거나 탭이 없으면 false.
const OFFER_LOAD_WAIT_MS = 3_000;
export async function tabLoaded(tabId: number): Promise<boolean> {
  const until = Date.now() + OFFER_LOAD_WAIT_MS;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status !== "loading") return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// 다 뜬 최상위 문서와 주소(턴 끝 제안이 이것으로 고정한다). 제때 뜨지 않았으면 null.
export async function loadedPage(tabId: number): Promise<{ documentId: string | null; url: string } | null> {
  if (!(await tabLoaded(tabId))) return null;
  const documentId = await topDocumentId(tabId);
  const url = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "";
  return { documentId, url };
}

export async function turnTabOf(tabId: number): Promise<TurnTab> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { tabId, internal: isBrowserInternalUrl(tab.url) };
  } catch {
    return { error: "작업 탭을 찾을 수 없습니다." };
  }
}

// 지금 도구가 동작하는 탭(따라가는 팝업 창이 있으면 그 창)의 주소.
export async function toolTabUrl(turnTab: TurnTab): Promise<string | undefined> {
  const current = await currentToolTab(turnTab);
  if (!current) return undefined;
  try {
    return (await chrome.tabs.get(current.tabId)).url;
  } catch {
    return undefined;
  }
}

// 이번 요청의 도구가 동작할 탭(앞 턴에서 이어 따라가는 팝업 창이 있으면 그 창).
export async function requestTabId(getTurnTab: () => TurnTab): Promise<number | null> {
  return (await currentToolTab(getTurnTab()))?.tabId ?? null;
}

export async function fetchTabHeader(getTurnTab: () => TurnTab): Promise<string> {
  const tabId = await requestTabId(getTurnTab);
  if (tabId === null) return "";
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? "";
    const title = tab.title ?? "";
    if (!url && !title) return "";
    // 가벼운 모델은 시스템 프롬프트 뒤쪽의 YouTube 모드보다 이 머리말을 따르므로 여기서 도구를 안내한다.
    const guide = isBrowserInternalUrl(url)
      ? "브라우저 내부 페이지(새 탭·설정 등) — 관측·조작 도구를 쓸 수 없으니 describe_page 없이 navigate_to_url로 사용자가 가려는 사이트로 바로 이동하세요"
      : youtubeVideoId(url)
        ? "YouTube 영상 페이지 — 영상 내용(요약·질문 등)은 describe_page·get_page_content 대신 get_youtube_transcript로 먼저 확인하세요"
        : "상세 내용은 describe_page로 관측하세요";
    const popup = await popupHeader(getTurnTab);
    return `[탭 메타데이터 — ${guide}]\nURL: ${url}\n제목: ${title}${popup}`;
  } catch {
    return "";
  }
}

// 앞 턴에서 따라가던 팝업 창을 이어 따라가면 머리말에 알린다(주소는 줄인 꼴만).
export async function popupHeader(getTurnTab: () => TurnTab): Promise<string> {
  const current = await currentToolTab(getTurnTab());
  if (!current?.popup) return "";
  let where = "";
  try {
    where = popupWhere((await chrome.tabs.get(current.tabId)).url ?? "");
  } catch {
    return "";
  }
  if (current.asTab) {
    return `\n[클릭으로 열린 탭을 따라가는 중 — 위 URL·제목은 앞에서 누른 버튼·링크가 연 탭(새 탭, 또는 브라우저가 팝업을 탭으로 연 것 — ${where})입니다. 그 탭이 앞에 보여 도구는 그 탭에서 동작합니다. 탭이 닫히면 원래 탭으로 돌아갑니다.]`;
  }
  return `\n[팝업 창을 따라가는 중 — 위 URL·제목은 앞에서 누른 버튼이 연 팝업 창(${where})입니다. 아직 열려 있어 도구는 그 창에서 동작합니다. 창이 닫히면 원래 탭으로 돌아갑니다.]`;
}
