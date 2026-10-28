import type { RepeatTask } from "@/lib/repeatTask";
import { useRepeatTasks } from "../hooks/useRepeatTasks";

const STATUS: Record<RepeatTask["status"], string> = {
  active: "확인 중",
  paused: "멈춤",
  triggered: "조건 맞음",
  started: "이어서 진행함",
  done: "끝남",
};

const VERDICT: Record<string, string> = {
  met: "조건 맞음",
  unmet: "아직",
  blocked: "막힘",
  login_required: "로그인 필요",
  unknown: "판단 못 함",
  error: "확인 실패",
};

const when = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 반복 작업(#138) 목록과 지금 확인·멈추기·다시 시작·지우기.
export function RepeatTasksField() {
  const { tasks, error, busy, act } = useRepeatTasks();
  return (
    <div className="field">
      <span className="field-label">반복 작업</span>
      <span className="field-help">
        채팅에서 "10분마다 이 페이지를 확인해서 예매가 열리면 알려 줘"처럼 요청하면 등록 카드가 뜹니다. 확인할 때마다 화면 글자를 AI 서비스로 보내므로 요금이 듭니다.
      </span>
      {error && <span className="field-help error-text">{error}</span>}
      {tasks && tasks.length === 0 && <span className="field-hint">등록한 반복 작업이 없습니다.</span>}
      {tasks && tasks.length > 0 && (
        <ul className="repeat-list">
          {tasks.map((t) => (
            <li key={t.id} className={`repeat-item repeat-${t.status}`}>
              <div className="repeat-head">
                <strong className="repeat-title">{t.title}</strong>
                <span className="repeat-status">{STATUS[t.status]}</span>
              </div>
              <div className="repeat-meta" title={t.url}>
                {t.url}
              </div>
              <div className="repeat-meta">
                {t.intervalMinutes}분마다 · {t.attempts}/{t.maxRuns}번 · {when(t.endsAt)}까지
              </div>
              <div className="repeat-meta">조건: {t.check}</div>
              {t.lastCheck && (
                <div className="repeat-meta">
                  마지막 확인 {when(t.lastCheck.at)} · {VERDICT[t.lastCheck.verdict] ?? t.lastCheck.verdict}
                  {t.lastCheck.reason ? ` · ${t.lastCheck.reason}` : ""}
                </div>
              )}
              {t.note && <div className="repeat-note">{t.note}</div>}
              <div className="repeat-actions">
                {t.status === "active" && (
                  <>
                    <button type="button" className="ghost-btn" disabled={busy === `repeat_run_now:${t.id}`} onClick={() => void act("repeat_run_now", t.id)}>
                      {busy === `repeat_run_now:${t.id}` ? "확인 중…" : "지금 확인"}
                    </button>
                    {/* 확인하는 중에도 멈추기·지우기는 누를 수 있다(진행 중인 확인을 버리고 모델 전송을 막는다). */}
                    <button type="button" className="ghost-btn" disabled={busy === `repeat_pause:${t.id}`} onClick={() => void act("repeat_pause", t.id)}>
                      멈추기
                    </button>
                  </>
                )}
                {(t.status === "paused" || t.status === "triggered") && (
                  <button type="button" className="ghost-btn" disabled={busy === `repeat_resume:${t.id}`} onClick={() => void act("repeat_resume", t.id)}>
                    다시 확인 시작
                  </button>
                )}
                <button type="button" className="ghost-btn" disabled={busy === `repeat_delete:${t.id}`} onClick={() => void act("repeat_delete", t.id)}>
                  지우기
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
