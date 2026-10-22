import { useState } from "react";
import { KO } from "../i18n/ko";
import type { ChatMessage } from "../state/chatStore";

type Props = Extract<ChatMessage, { type: "tool_pending" }> & {
  onApprove: (callId: string, allowLinksThisTurn?: boolean, choiceIds?: string[], allowToolThisChat?: boolean) => void;
  onCancel: (callId: string) => void;
};

export function ToolPreviewCard(props: Props) {
  const { callId, toolName, previewSummary, previewDetails, linkGrantOffer, chatGrantOffer, choices, choiceLimit, choiceDefaults, resolved, onApprove, onCancel } =
    props;
  const disabled = resolved !== null;
  // 선택 카드(다른 탭·링크 고르기): choiceDefaults만 체크한 상태에서 시작하고, 고른 id만 승인으로 보낸다.
  const [picked, setPicked] = useState<string[]>(() => (choiceDefaults ?? []).slice(0, choiceLimit ?? choiceDefaults?.length));
  const limit = choiceLimit ?? choices?.length ?? 0;
  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= limit ? cur : [...cur, id]));

  return (
    <div className={`tool-card tool-pending${disabled ? " resolved" : ""}`}>
      <div className="tool-card-header">
        <span className="tool-card-title">{KO.toolConfirmTitle}</span>
        <span className="tool-card-badge">{toolName}</span>
      </div>
      <div className="tool-card-body">
        <div className="tool-card-summary">{previewSummary}</div>
        {typeof previewDetails === "string" && previewDetails && (
          <pre className="tool-card-details">{previewDetails}</pre>
        )}
        {choices && (
          <ul className="tool-card-choices">
            {choices.map((c) => (
              <li key={c.id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    disabled={disabled || (!picked.includes(c.id) && picked.length >= limit)}
                    checked={picked.includes(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="choice-label">{c.label}</span>
                  <span className="choice-sub">{c.sub}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="tool-card-actions">
        {resolved === "approved" && <span className="resolved-label">✓ 승인됨</span>}
        {resolved === "cancelled" && <span className="resolved-label">✕ 취소됨</span>}
        {!disabled && (
          <>
            <button className="btn-cancel" onClick={() => onCancel(callId)}>
              {KO.cancel}
            </button>
            {linkGrantOffer && (
              <button
                className="btn-approve-links"
                title={KO.approveLinksThisTurnHelp}
                onClick={() => onApprove(callId, true)}
              >
                {KO.approveLinksThisTurn}
              </button>
            )}
            {chatGrantOffer && (
              <button
                className="btn-approve-chat"
                title={KO.chatGrantHelp[toolName as keyof typeof KO.chatGrantHelp] ?? ""}
                disabled={!!choices && picked.length === 0}
                onClick={() => onApprove(callId, false, choices ? picked : undefined, true)}
              >
                {KO.approveToolThisChat}
              </button>
            )}
            {choices ? (
              <button className="btn-approve" disabled={picked.length === 0} onClick={() => onApprove(callId, false, picked)}>
                {KO.approveChoices}
              </button>
            ) : (
              <button className="btn-approve" onClick={() => onApprove(callId)}>
                {KO.approve}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
