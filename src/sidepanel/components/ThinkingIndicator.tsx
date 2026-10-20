import { KO } from "../i18n/ko";
import { useChatStore } from "../state/chatStore";

// label이 있으면 그 글자(추론 중 "생각 중…"), 없으면 상태 글자나 기본 대기 글자.
export function ThinkingIndicator({ label }: { label?: string } = {}) {
  const statusText = useChatStore((s) => s.statusText);
  return (
    <div className="msg msg-assistant">
      <div className="bubble bubble-assistant thinking-bubble" role="status" aria-live="polite">
        <span className="thinking-label">{label ?? statusText ?? KO.streamingLabel}</span>
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}
