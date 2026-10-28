import { KO } from "../i18n/ko";
import type { ChatMessage } from "../state/chatStore";
import { toolLabel } from "@/lib/toolLabels";

type Props = Extract<ChatMessage, { type: "hop_limit" }> & {
  onApprove: (callId: string) => void;
  onCancel: (callId: string) => void;
};

// 도구 호출 순환 한도에서 이어 가기 카드(#55). 지금까지 한 일(도구별 횟수·최근 결과)을 보여 주고, 허락하면 같은 요청을
// extra번 더 이어 가고 거부하면 도구 없이 지금까지의 결과로 답한다.
// 최근 결과 줄은 "도구이름: 요약"(hopGuard.summarizeRuns). 앞의 내부 이름만 보이는 이름으로 바꾼다(#130).
function labelRecent(line: string): string {
  const i = line.indexOf(": ");
  return i > 0 ? `${toolLabel(line.slice(0, i))}${line.slice(i)}` : line;
}

export function HopLimitCard({ callId, used, extra, summary, resolved, onApprove, onCancel }: Props) {
  const disabled = resolved !== null;
  const counts = summary.byTool.map((t) => `${toolLabel(t.tool)} ${t.count}`).join(" · ");
  const issues = [
    summary.failed ? `실패 ${summary.failed}` : "",
    summary.cancelled ? `취소 ${summary.cancelled}` : "",
  ].filter(Boolean);
  return (
    <div className={`tool-card tool-pending hop-limit-card${disabled ? " resolved" : ""}`}>
      <div className="tool-card-header">
        <span className="tool-card-title">{KO.hopLimitTitle}</span>
        <span className="tool-card-badge">{used}단계</span>
      </div>
      <div className="tool-card-body">
        <div className="tool-card-summary">
          지금까지 {used}단계에서 도구를 {summary.total}번 썼습니다{issues.length ? ` (${issues.join(", ")})` : ""}.
          {" "}{extra}단계 더 진행할까요?
        </div>
        {counts && <div className="hop-limit-counts">{counts}</div>}
        {summary.recent.length > 0 && (
          <ul className="hop-limit-recent">
            {summary.recent.map((line, i) => (
              <li key={i}>{labelRecent(line)}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="tool-card-actions">
        {resolved === "approved" && <span className="resolved-label">✓ {extra}단계 더 진행</span>}
        {resolved === "cancelled" && <span className="resolved-label">✕ 그만함</span>}
        {!disabled && (
          <>
            <button className="btn-cancel" onClick={() => onCancel(callId)}>
              {KO.hopLimitStop}
            </button>
            <button className="btn-approve" onClick={() => onApprove(callId)}>
              {extra}단계 더 진행
            </button>
          </>
        )}
      </div>
    </div>
  );
}
