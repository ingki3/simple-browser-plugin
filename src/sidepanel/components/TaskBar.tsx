import { KO } from "../i18n/ko";
import { useChatStore } from "../state/chatStore";

interface Props {
  onRevoke: () => void;
}

// 이 대화에서 작업을 맡겼으면(#123) 입력창 위에 알리고, 누르면 거둔다(다음 동작부터 다시 묻는다).
export function TaskBar({ onRevoke }: Props) {
  const active = useChatStore((s) => s.taskActive);
  if (!active) return null;
  return (
    <div className="task-bar" role="status">
      <span className="task-bar-label">{KO.taskBarLabel}</span>
      <button className="chat-grant-chip" onClick={onRevoke}>
        {KO.taskRevoke} <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}
