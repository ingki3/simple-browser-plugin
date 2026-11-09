import type { RepeatCheck, RepeatTask } from "@/lib/repeatTask";
import { useRepeatTasks } from "../../sidepanel/hooks/useRepeatTasks";

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

const MODE: Record<NonNullable<RepeatCheck["mode"]>, string> = {
  full: "전체 화면",
  region: "작전 영역",
  "region+full": "작전 영역 → 전체 화면",
};

const WHERE: Record<string, string> = { heading: "제목", label: "이름표", element: "요소 종류" };

// 작전 상태 한 줄(#284).
function planLine(t: RepeatTask): string {
  switch (t.plan.state) {
    case "pending":
      return t.plan.tries ? `작전: 다음 확인 때 다시 만듭니다(${t.plan.tries}번 실패)` : "작전: 첫 확인 때 만듭니다";
    case "ready":
      return "작전: 있음 — 영역 글자만 보내 확인합니다";
    case "none":
      return `작전: 전체 화면으로 확인 — ${t.plan.why}`;
    case "cleared":
      return "작전: 지움 — 전체 화면으로 확인합니다";
  }
}

// 작전 자세히. 페이지에서 유래한 글이라 텍스트 노드로만 넣는다(HTML로 넣지 않는다).
function PlanDetails({ t }: { t: RepeatTask }) {
  if (t.plan.state !== "ready") return null;
  const p = t.plan.plan;
  return (
    <details className="repeat-plan">
      <summary>작전 자세히</summary>
      <div className="field-hint">페이지를 보고 모델이 만든 내용입니다. 확인 조건·할 일은 바꾸지 못합니다.</div>
      <div className="repeat-meta">볼 영역: {p.region.selector}</div>
      <div className="repeat-meta">
        기준점: {WHERE[p.region.anchor.where] ?? p.region.anchor.where}
        {p.region.anchor.text ? ` · ${p.region.anchor.text}` : ""}
      </div>
      {p.region.shape && <div className="repeat-meta">영역 모양: {p.region.shape}</div>}
      <div className="repeat-meta">판단 기준: {p.criteria}</div>
      {p.mismatch && <div className="repeat-meta">안 맞는 신호: {p.mismatch}</div>}
      <div className="repeat-meta">페이지만으로 판단: {p.pageOnly ? "예" : "아니오(시간·페이지 밖 정보에 달림)"}</div>
      <div className="repeat-meta">
        만든 때 {when(p.createdAt)} · 글자 {p.fullChars.toLocaleString("ko-KR")}자 → {p.regionChars.toLocaleString("ko-KR")}자
      </div>
    </details>
  );
}

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
                  {t.lastCheck.mode ? ` · ${MODE[t.lastCheck.mode] ?? t.lastCheck.mode}` : ""}
                  {t.lastCheck.reason ? ` · ${t.lastCheck.reason}` : ""}
                </div>
              )}
              <div className="repeat-meta repeat-plan-state">{planLine(t)}</div>
              <PlanDetails t={t} />
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
                {(t.plan.state === "ready" || t.plan.state === "pending") && (
                  <button type="button" className="ghost-btn" disabled={busy === `repeat_clear_plan:${t.id}`} onClick={() => void act("repeat_clear_plan", t.id)}>
                    작전 지우기(전체 판단)
                  </button>
                )}
                {(t.plan.state === "none" || t.plan.state === "cleared") && (
                  <button type="button" className="ghost-btn" disabled={busy === `repeat_make_plan:${t.id}`} onClick={() => void act("repeat_make_plan", t.id)}>
                    작전 만들기(다음 확인 때)
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
