import { useEffect, useState } from "react";
import { ruleFor, type SuggestionRule } from "@/lib/pageSuggest";
import { useCurrentTabContext } from "../state/currentTab";
import { useSettings } from "../hooks/useSettings";
import { useChatStore } from "../state/chatStore";

interface Props {
  rules: SuggestionRule[];
  onRun: (rule: SuggestionRule, tab: { windowId: number; tabId: number; url: string }) => void;
  onDisable: (rule: SuggestionRule) => void;
}

// 페이지 제안 칩(#173): 패널 창의 활성 탭 주소가 사용자가 만든 규칙과 맞으면 입력창 위에 제안을 띄운다(주소만 보고 판단 — 모델·
// 페이지 글자 없음). 페이지마다 한 번(새로고침은 새 페이지): 실행하거나 ×로 닫으면 그 페이지에서는 다시 띄우지 않는다.
// 실행은 백그라운드가 규칙·탭·문서를 다시 확인한 뒤 규칙의 요청을 보낸다.
export function SuggestionChip({ rules, onRun, onDisable }: Props) {
  const { tab, loadSeq } = useCurrentTabContext();
  const { settings, loaded } = useSettings();
  const streaming = useChatStore((s) => s.streaming);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const pageKey = tab ? `${tab.tabId}|${loadSeq}|${tab.url}` : "";
  // 오래된 페이지 키는 버린다(지금 페이지 것만 남긴다).
  useEffect(() => {
    setDismissed((cur) => (cur.size && ![...cur].every((k) => k === pageKey) ? new Set([...cur].filter((k) => k === pageKey)) : cur));
  }, [pageKey]);

  if (!loaded || !settings.pageSuggestions || !tab || !tab.web || dismissed.has(pageKey)) return null;
  const rule = ruleFor(rules, tab.url);
  if (!rule) return null;
  const close = () => setDismissed((cur) => new Set(cur).add(pageKey));
  return (
    <div className="suggestion-chip" data-rule={rule.id}>
      <span className="suggestion-label">💡 {rule.label}</span>
      <button
        type="button"
        className="btn-approve suggestion-run"
        disabled={streaming}
        title={streaming ? "응답이 끝난 뒤 누르세요" : rule.request}
        onClick={() => {
          close();
          onRun(rule, { windowId: tab.windowId, tabId: tab.tabId, url: tab.url });
        }}
      >
        실행
      </button>
      <button type="button" className="ghost-btn suggestion-off" onClick={() => onDisable(rule)} title="이 제안을 끕니다(설정에서 다시 켤 수 있음)">
        이 제안 끄기
      </button>
      <button type="button" className="icon-btn suggestion-close" onClick={close} aria-label="닫기" title="이 페이지에서는 다시 띄우지 않음">
        ×
      </button>
    </div>
  );
}
