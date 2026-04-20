import type { ChatMessage } from "../state/chatStore";
import { StreamingText } from "./StreamingText";
import { ToolPreviewCard } from "./ToolPreviewCard";
import { ToolResultCard } from "./ToolResultCard";

interface Props {
  message: ChatMessage;
  onApprove: (callId: string) => void;
  onCancel: (callId: string) => void;
}

export function MessageBubble({ message, onApprove, onCancel }: Props) {
  switch (message.type) {
    case "user":
      return (
        <div className="msg msg-user">
          <div className="bubble bubble-user">{message.text}</div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="msg msg-assistant">
          {message.thoughtText && (
            <details className="thought-box" open={message.streaming && !message.text}>
              <summary>🧠 생각 과정</summary>
              <div className="thought-body">{message.thoughtText}</div>
            </details>
          )}
          {(message.text || !message.thoughtText) && (
            <div className="bubble bubble-assistant">
              <StreamingText text={message.text} streaming={message.streaming} />
            </div>
          )}
        </div>
      );
    case "tool_pending":
      return (
        <div className="msg msg-tool">
          <ToolPreviewCard {...message} onApprove={onApprove} onCancel={onCancel} />
        </div>
      );
    case "tool_result":
      return (
        <div className="msg msg-tool">
          <ToolResultCard {...message} />
        </div>
      );
    case "error":
      return (
        <div className="msg msg-error">
          <div className="bubble bubble-error">⚠ {message.message}</div>
        </div>
      );
    case "info":
      return (
        <div className="msg msg-info">
          <div className="bubble bubble-info">
            <div className="info-title">ℹ {message.title}</div>
            <div className="info-body">{message.message}</div>
          </div>
        </div>
      );
  }
}
