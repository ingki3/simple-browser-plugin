import { useEffect, useRef } from "react";
import { useChatStore } from "../state/chatStore";
import { MessageBubble } from "./MessageBubble";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { KO } from "../i18n/ko";

interface Props {
  onApprove: (callId: string) => void;
  onCancel: (callId: string) => void;
}

export function MessageList({ onApprove, onCancel }: Props) {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  const lastMsg = messages[messages.length - 1];
  const lastIsStreamingAssistant =
    lastMsg?.type === "assistant_text" &&
    lastMsg.streaming &&
    (lastMsg.text.length > 0 || lastMsg.thoughtText.length > 0);
  const lastIsPendingApproval =
    lastMsg?.type === "tool_pending" && lastMsg.resolved === null;
  const showThinking =
    streaming && !lastIsStreamingAssistant && !lastIsPendingApproval;

  if (messages.length === 0 && !streaming) {
    return (
      <div className="message-list empty">
        <div className="empty-state">{KO.emptyState}</div>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} onApprove={onApprove} onCancel={onCancel} />
      ))}
      {showThinking && <ThinkingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
