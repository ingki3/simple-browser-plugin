import type { ToolName } from "@/lib/messages";
import { KO } from "../i18n/ko";
import { useChatStore } from "../state/chatStore";

interface Props {
  onRevoke: (tool: ToolName) => void;
}

// 이 대화에서 "묻지 않기"로 허락한 도구를 입력창 위에 작게 보이고, 누르면 취소한다(#53).
// 진행 단계 표시(HopProgress)와는 다른 줄에 두고, 허락이 없으면 그리지 않는다.
export function ChatGrantBar({ onRevoke }: Props) {
  const grants = useChatStore((s) => s.chatGrants);
  if (!grants.length) return null;
  return (
    <div className="chat-grant-bar" role="group" aria-label={KO.chatGrantBarLabel}>
      <span className="chat-grant-label">{KO.chatGrantBarLabel}</span>
      {grants.map((g) => {
        const name = KO.chatGrantToolNames[g.tool as keyof typeof KO.chatGrantToolNames] ?? g.tool;
        const label = g.tool === "download_images" && g.scope ? `${name}('${g.scope}/')` : name;
        return (
          <button
            key={g.tool}
            className="chat-grant-chip"
            data-tool={g.tool}
            title={`${label} — ${KO.chatGrantRevoke}`}
            onClick={() => onRevoke(g.tool)}
          >
            {label} <span aria-hidden="true">✕</span>
          </button>
        );
      })}
    </div>
  );
}
