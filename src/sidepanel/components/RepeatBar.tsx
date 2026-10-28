import { useState } from "react";
import { useChatStore } from "../state/chatStore";
import { useRepeatTasks } from "../hooks/useRepeatTasks";

interface Props {
  onContinue: (taskId: string) => void;
}

// 조건이 맞은 반복 작업(#138)을 입력창 위에 알린다. "이어서 진행"을 눌러야 새 대화로 다음 일을 시작한다.
// 확인 결과의 이유는 페이지에서 유래한 글이라 보여 주기만 하고 모델에 보내지 않는다.
export function RepeatBar({ onContinue }: Props) {
  const { tasks } = useRepeatTasks();
  const streaming = useChatStore((s) => s.streaming);
  // 누른 작업(준비하는 동안 다시 누르지 못하게 — 두 번 누르면 둘 다 취소된다). 목록이 바뀌면(시작·되돌림) 다시 누를 수 있다.
  const [pressed, setPressed] = useState<{ id: string; revision: number } | null>(null);
  const triggered = (tasks ?? []).filter((t) => t.status === "triggered");
  if (!triggered.length) return null;
  return (
    <div className="repeat-bar" role="status">
      {triggered.map((t) => (
        <div key={t.id} className="repeat-bar-item">
          <div className="repeat-bar-text">
            <strong>반복 작업 ‘{t.title}’의 조건이 맞았습니다.</strong>
            {t.lastCheck?.reason && <span className="repeat-bar-reason">확인 결과: {t.lastCheck.reason}</span>}
            <span className="repeat-bar-then">할 일: {t.then}</span>
          </div>
          <button
            className="btn-approve"
            disabled={streaming || (pressed?.id === t.id && pressed.revision === t.revision)}
            title={streaming ? "지금 응답이 끝난 뒤 누를 수 있습니다" : "새 대화를 열고 작업 탭에서 할 일을 시작합니다"}
            onClick={() => {
              setPressed({ id: t.id, revision: t.revision });
              onContinue(t.id);
            }}
          >
            이어서 진행
          </button>
        </div>
      ))}
    </div>
  );
}
