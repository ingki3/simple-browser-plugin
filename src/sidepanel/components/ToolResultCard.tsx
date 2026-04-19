import type { ChatMessage } from "../state/chatStore";

type Props = Extract<ChatMessage, { type: "tool_result" }>;

export function ToolResultCard({ toolName, ok, summary }: Props) {
  return (
    <div className={`tool-card tool-result${ok ? "" : " tool-failed"}`}>
      <div className="tool-card-header">
        <span className="tool-card-title">{ok ? "✓ 도구 완료" : "✕ 도구 실패"}</span>
        <span className="tool-card-badge">{toolName}</span>
      </div>
      <div className="tool-card-body">
        <div className="tool-card-summary">{summary}</div>
      </div>
    </div>
  );
}
