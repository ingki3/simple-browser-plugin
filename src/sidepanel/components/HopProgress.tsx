import { KO } from "../i18n/ko";
import { useChatStore } from "../state/chatStore";

// 응답 중 도구 순환 단계와 한도(예: 단계 12/30)를 입력창 위에 보인다(#55). 한도에 가까워지면 강조한다.
export function HopProgress() {
  const streaming = useChatStore((s) => s.streaming);
  const progress = useChatStore((s) => s.hopProgress);
  if (!streaming || !progress) return null;
  const near = progress.limit - progress.used <= Math.max(2, Math.floor(progress.limit / 5));
  return (
    <div className={`hop-progress${near ? " near" : ""}`} role="status" aria-live="off">
      {KO.hopProgressLabel} {progress.used}/{progress.limit}
    </div>
  );
}
