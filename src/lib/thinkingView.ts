// 어시스턴트 메시지의 추론(thinking) 스트림을 어떻게 보일지. 기본은 추론 글자 대신 "생각 중" 표시만 보이고,
// 설정에서 "생각 과정 보기"를 켜면 예전처럼 접이식 상자로 글자를 보인다. 저장·전송 데이터는 바꾸지 않는다.
export type ThinkingDisplay = "box" | "indicator" | "none";

export function thinkingDisplay(
  msg: { thoughtText: string; text: string; streaming: boolean },
  showThinking: boolean,
): ThinkingDisplay {
  if (!msg.thoughtText) return "none";
  if (showThinking) return "box";
  // 추론 청크를 받는 중이고 아직 답 글자가 시작되지 않았을 때만 "생각 중"을 보인다. 끝난 메시지에는 남기지 않는다.
  return msg.streaming && !msg.text ? "indicator" : "none";
}
