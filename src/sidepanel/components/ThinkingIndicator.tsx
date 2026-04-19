import { KO } from "../i18n/ko";
import { useChatStore } from "../state/chatStore";

export function ThinkingIndicator() {
  const statusText = useChatStore((s) => s.statusText);
  return (
    <div className="msg msg-assistant">
      <div className="bubble bubble-assistant thinking-bubble" aria-live="polite">
        <span className="thinking-label">{statusText ?? KO.streamingLabel}</span>
        <span className="thinking-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  );
}
