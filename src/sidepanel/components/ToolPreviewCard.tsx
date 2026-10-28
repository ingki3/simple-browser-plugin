import { useState } from "react";
import { KO } from "../i18n/ko";
import { toolLabel } from "@/lib/toolLabels";
import type { ChatMessage } from "../state/chatStore";

type Props = Extract<ChatMessage, { type: "tool_pending" }> & {
  onApprove: (
    callId: string,
    allowLinksThisTurn?: boolean,
    choiceIds?: string[],
    allowToolThisChat?: boolean,
    allowUrlsThisChat?: boolean,
    rememberLoginSite?: boolean,
  ) => void;
  onCancel: (callId: string) => void;
};

export function ToolPreviewCard(props: Props) {
  const { callId, toolName, previewSummary, previewDetails, linkGrantOffer, chatGrantOffer, personalUrlOffer, loginSiteOffer, choices, choiceLimit, choiceDefaults, handoff, task, resolved, onApprove, onCancel } =
    props;
  const disabled = resolved !== null;
  // 선택 카드(다른 탭·링크 고르기): choiceDefaults만 체크한 상태에서 시작하고, 고른 id만 승인으로 보낸다.
  const [picked, setPicked] = useState<string[]>(() => (choiceDefaults ?? []).slice(0, choiceLimit ?? choiceDefaults?.length));
  const limit = choiceLimit ?? choices?.length ?? 0;
  const toggle = (id: string) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= limit ? cur : [...cur, id]));

  if (task) return <TaskCard {...props} task={task} />;

  return (
    <div className={`tool-card tool-pending${disabled ? " resolved" : ""}`}>
      <div className="tool-card-header">
        <span className="tool-card-title">{handoff ? KO.handoffTitle : KO.toolConfirmTitle}</span>
        <span className="tool-card-badge" title={toolName}>{toolLabel(toolName)}</span>
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
        {resolved === "approved" && <span className="resolved-label">{handoff ? "✓ 완료" : "✓ 승인됨"}</span>}
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
            {personalUrlOffer && (
              <button
                className="btn-approve-urls"
                title={KO.approveUrlsThisChatHelp}
                onClick={() => onApprove(callId, false, undefined, false, true)}
              >
                {KO.approveUrlsThisChat}
              </button>
            )}
            {loginSiteOffer && choices && (
              <button
                className="btn-approve-login-site"
                title={KO.approveLoginSiteHelp}
                disabled={picked.length === 0}
                onClick={() => onApprove(callId, false, picked, false, false, true)}
              >
                {KO.approveLoginSite}
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
            {handoff ? (
              <button className="btn-approve" onClick={() => onApprove(callId)}>
                {KO.handoffDone}
              </button>
            ) : choices ? (
              <button className="btn-approve" disabled={picked.length === 0} onClick={() => onApprove(callId, false, picked)}>
                {toolName === "download_images" || toolName === "download_files"
                  ? KO.approveChoicesSave
                  : toolName === "sign_in"
                    ? KO.approveSignIn
                    : KO.approveChoices}
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

// 작업 맡기기 카드(#123): 사용자가 보낸 요청(원문), 모델이 정리한 할 일·위험, 맡기면 묻지 않게 되는 동작을 보이고 한 번 묻는다.
function TaskCard({ callId, toolName, previewSummary, task, resolved, onApprove, onCancel }: Props & { task: NonNullable<Props["task"]> }) {
  const disabled = resolved !== null;
  return (
    <div className={`tool-card tool-pending task-card${disabled ? " resolved" : ""}`}>
      <div className="tool-card-header">
        <span className="tool-card-title">{KO.taskTitle}</span>
        <span className="tool-card-badge" title={toolName}>{toolLabel(toolName)}</span>
      </div>
      <div className="tool-card-body">
        <div className="tool-card-summary">{previewSummary}</div>
        <div className="task-section-label">{KO.taskRequest}</div>
        <pre className="tool-card-details task-text">{task.request}</pre>
        <div className="task-section-label">{KO.taskPlan}</div>
        <pre className="tool-card-details task-text">{task.plan}</pre>
        {task.risks.length > 0 && (
          <>
            <div className="task-section-label">{KO.taskRisks}</div>
            <ul className="task-risks">
              {task.risks.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </>
        )}
        <p className="task-warning">{KO.taskWarning}</p>
        <p className="task-note">{KO.taskKeepAsking}</p>
      </div>
      <div className="tool-card-actions">
        {resolved === "approved" && <span className="resolved-label">✓ 맡김</span>}
        {resolved === "cancelled" && <span className="resolved-label">✕ 맡기지 않음</span>}
        {!disabled && (
          <>
            <button className="btn-cancel" onClick={() => onCancel(callId)}>
              {KO.cancel}
            </button>
            <button className="btn-approve btn-approve-task" onClick={() => onApprove(callId)}>
              {KO.taskApprove}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
