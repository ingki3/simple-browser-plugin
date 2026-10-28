import type { ChatMessage } from "../state/chatStore";
import { toolLabel } from "@/lib/toolLabels";

type Props = Extract<ChatMessage, { type: "tool_result" }>;

// 도구 결과 줄. 사용자가 취소한 것은 실패와 구분해 보인다(#130). 내부 도구 이름은 title로만.
export function ToolResultCard({ toolName, ok, summary, cancelled }: Props) {
  const state = ok ? "done" : cancelled ? "cancelled" : "failed";
  const title = state === "done" ? "✓ 완료" : state === "cancelled" ? "– 실행 안 함" : "✕ 실패";
  return (
    <div className={`tool-card tool-result${state === "failed" ? " tool-failed" : state === "cancelled" ? " tool-cancelled" : ""}`}>
      <div className="tool-card-header">
        <span className="tool-card-title">{title}</span>
        <span className="tool-card-badge" title={toolName}>
          {toolLabel(toolName)}
        </span>
      </div>
      <div className="tool-card-body">
        <div className="tool-card-summary">{summary}</div>
      </div>
    </div>
  );
}
