import { useLayoutEffect, useRef } from "react";
import { useChatStore } from "../state/chatStore";
import { MessageBubble } from "./MessageBubble";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { Welcome } from "./Welcome";
import { useSettings } from "../hooks/useSettings";

interface Props {
  onApprove: (
    callId: string,
    allowLinksThisTurn?: boolean,
    choiceIds?: string[],
    allowToolThisChat?: boolean,
    allowUrlsThisChat?: boolean,
    rememberLoginSite?: boolean,
  ) => void;
  onCancel: (callId: string) => void;
  needsKey: boolean;
  onOpenSettings: () => void;
  onSend: (text: string) => void;
}

export function MessageList({ onApprove, onCancel, needsKey, onOpenSettings, onSend }: Props) {
  const messages = useChatStore((s) => s.messages);
  const streaming = useChatStore((s) => s.streaming);
  const { settings } = useSettings();
  const listRef = useRef<HTMLDivElement | null>(null);
  // 사용자가 위로 스크롤해 과거 내용을 보는 중이면 자동 스크롤을 멈춘다.
  const stickRef = useRef(true);

  // 청크마다 smooth scrollIntoView를 다시 걸면 애니메이션이 계속 재시작돼
  // 긴 스트리밍에서 바닥을 따라가지 못한다. 페인트 전에 즉시 바닥으로 맞춘다.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const lastMsg = messages[messages.length - 1];
  const lastIsStreamingAssistant =
    lastMsg?.type === "assistant_text" &&
    lastMsg.streaming &&
    (lastMsg.text.length > 0 || lastMsg.thoughtText.length > 0);
  const lastIsPendingApproval =
    (lastMsg?.type === "tool_pending" || lastMsg?.type === "hop_limit") && lastMsg.resolved === null;
  const showThinking =
    streaming && !lastIsStreamingAssistant && !lastIsPendingApproval;

  if (messages.length === 0 && !streaming) {
    return (
      <div className="message-list empty">
        <Welcome needsKey={needsKey} onOpenSettings={onOpenSettings} onSend={onSend} />
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="message-list"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 32;
      }}
    >
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          onApprove={onApprove}
          onCancel={onCancel}
          showThinking={settings.showThinking}
        />
      ))}
      {showThinking && <ThinkingIndicator />}
    </div>
  );
}
