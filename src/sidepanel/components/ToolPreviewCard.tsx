import { KO } from "../i18n/ko";
import type { ChatMessage } from "../state/chatStore";

type Props = Extract<ChatMessage, { type: "tool_pending" }> & {
  onApprove: (callId: string) => void;
  onCancel: (callId: string) => void;
};

export function ToolPreviewCard(props: Props) {
  const { callId, toolName, previewSummary, previewDetails, resolved, onApprove, onCancel } = props;
  const disabled = resolved !== null;

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
      </div>
      <div className="tool-card-actions">
        {resolved === "approved" && <span className="resolved-label">✓ 승인됨</span>}
        {resolved === "cancelled" && <span className="resolved-label">✕ 취소됨</span>}
        {!disabled && (
          <>
            <button className="btn-cancel" onClick={() => onCancel(callId)}>
              {KO.cancel}
            </button>
            <button className="btn-approve" onClick={() => onApprove(callId)}>
              {KO.approve}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
