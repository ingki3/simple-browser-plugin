import type { ChatMessage } from "../state/chatStore";
import { StreamingText } from "./StreamingText";
import { ThoughtBox } from "./ThoughtBox";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { thinkingDisplay } from "@/lib/thinkingView";
import { KO } from "../i18n/ko";
import { ToolPreviewCard } from "./ToolPreviewCard";
import { ToolResultCard } from "./ToolResultCard";
import { PageOfferCard } from "./PageOfferCard";
import { HopLimitCard } from "./HopLimitCard";

interface Props {
  message: ChatMessage;
  onApprove: (
    callId: string,
    allowLinksThisTurn?: boolean,
    choiceIds?: string[],
    allowToolThisChat?: boolean,
    allowUrlsThisChat?: boolean,
    rememberLoginSite?: boolean,
  ) => void;
  onCancel: (callId: string) => void;
  showThinking: boolean;
  onOpenSettings: () => void;
  // 지금 제공자의 사용량 확인 주소(오류의 "사용량 확인" 버튼, #130).
  usageUrl: string;
}

export function MessageBubble({ message, onApprove, onCancel, showThinking, onOpenSettings, usageUrl }: Props) {
  switch (message.type) {
    case "user":
      return (
        <div className="msg msg-user">
          <div className="bubble bubble-user">{message.text}</div>
        </div>
      );
    case "assistant_text": {
      const thinking = thinkingDisplay(message, showThinking);
      if (thinking === "indicator") return <ThinkingIndicator label={KO.thinkingLabel} />;
      // 추론만 있고 답 글자가 없이 끝난 메시지(도구 호출로 넘어감)는 기본 화면에서 아무것도 남기지 않는다.
      if (thinking === "none" && !message.text && message.thoughtText) return null;
      return (
        <div className="msg msg-assistant">
          {thinking === "box" && (
            <ThoughtBox text={message.thoughtText} live={message.streaming && !message.text} />
          )}
          {(message.text || !message.thoughtText) && (
            <div className="bubble bubble-assistant">
              <StreamingText text={message.text} streaming={message.streaming} />
            </div>
          )}
        </div>
      );
    }
    case "tool_pending":
      return (
        <div className="msg msg-tool">
          <ToolPreviewCard {...message} onApprove={onApprove} onCancel={onCancel} />
        </div>
      );
    case "hop_limit":
      return (
        <div className="msg msg-tool">
          <HopLimitCard {...message} onApprove={onApprove} onCancel={onCancel} />
        </div>
      );
    case "tool_result":
      return (
        <div className="msg msg-tool">
          <ToolResultCard {...message} />
        </div>
      );
    case "page_offer":
      return (
        <div className="msg msg-tool">
          <PageOfferCard {...message} />
        </div>
      );
    case "error":
      return (
        <div className="msg msg-error">
          <div className="bubble bubble-error">
            ⚠ {message.message}
            {message.action === "settings" && (
              <div className="error-actions">
                <button type="button" className="ghost-btn" onClick={onOpenSettings}>
                  설정 열기
                </button>
              </div>
            )}
            {message.action === "usage" && (
              <div className="error-actions">
                <a href={usageUrl} target="_blank" rel="noopener noreferrer">
                  사용량 확인
                </a>
              </div>
            )}
            {message.detail && (
              <details className="error-detail">
                <summary>자세히</summary>
                {message.detail}
              </details>
            )}
          </div>
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
