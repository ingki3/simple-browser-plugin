import { useState } from "react";
import type { PageOfferData } from "@/lib/messages";
import { useChatStore } from "../state/chatStore";
import { useSettings } from "../hooks/useSettings";
import type { CurrentTab } from "../hooks/useCurrentTab";

// 헤더의 "이 페이지 기억" 버튼(#174): 말하지 않고 지금 보고 있는 페이지의 저장 카드를 펼친다(이름·용도·자리는 자동으로 채움).
// 저장은 카드에서 사용자가 누를 때만 된다. 대화 기록에는 아무것도 넣지 않는다.
export function RememberPageButton({ tab }: { tab: CurrentTab | null }) {
  const { settings, loaded } = useSettings();
  const addPageOffer = useChatStore((s) => s.addPageOffer);
  const addNote = useChatStore((s) => s.addNote);
  const [busy, setBusy] = useState(false);

  const off = loaded && !settings.rememberPages;
  const why = off
    ? "설정에서 '페이지 기억하기'가 꺼져 있습니다"
    : !tab
      ? "기억할 페이지를 찾지 못했습니다(시크릿 창이거나 탭 없음)"
      : !tab.web
        ? "웹 페이지(http·https)만 기억할 수 있습니다"
        : null;

  const click = async () => {
    if (!tab || why) return;
    setBusy(true);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "remember_current_page", windowId: tab.windowId, tabId: tab.tabId, url: tab.url })) as
        | { ok: boolean; data?: { offer: PageOfferData } | { refused: string } | { already: { id: string; name: string } }; error?: string }
        | undefined;
      const d = res?.ok ? res.data : undefined;
      if (d && "offer" in d) addPageOffer(d.offer, { open: true, autoDraft: true });
      // 표시가 늦게 바뀌어 버튼이 보였던 경우(#191): 카드를 열지 않고 알린다.
      else if (d && "already" in d) addNote("이미 기억하고 있는 페이지입니다.", `저장한 링크: ${d.already.name}`);
      else addNote("이 페이지를 기억하지 못했습니다", d && "refused" in d ? d.refused : (res?.error ?? "응답이 없습니다."));
    } catch (err) {
      addNote("이 페이지를 기억하지 못했습니다", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 이미 기억한 페이지에서는 버튼을 보이지 않는다(#191). 꺼짐·시크릿 등은 지금처럼 비활성으로 이유를 보인다.
  if (!why && tab?.remembered) return null;

  return (
    <button
      className="icon-btn remember-btn"
      onClick={() => void click()}
      disabled={busy || !!why}
      title={why ?? "이 페이지 기억(저장 카드 열기)"}
      aria-label="이 페이지 기억"
    >
      📌
    </button>
  );
}
