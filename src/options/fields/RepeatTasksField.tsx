import type { RepeatCheck, RepeatTask } from "@/lib/repeatTask";
import { PLAN_VERIFY_MS, roundsToVerify, type PlanEvent, type PlanEventKind } from "@/lib/repeatPlan";
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
  skip: "변화 없어 생략",
  verify: "검산(작전 영역 + 전체 화면)",
};

// 작전 이벤트(#284 2단계). 종류·사유는 코드가 만든 고정 코드라 여기서 한국어로 바꿔 보인다.
const EVENT: Record<PlanEventKind, string> = {
  made: "작전 만듦",
  plan_failed: "작전 만들기 실패",
  plan_none: "볼 영역을 정하지 못함",
  miss: "영역이 안 맞아 전체 화면으로",
  fallback: "영역 판단 실패로 전체 화면으로",
  skip: "변화 없어 생략",
  verify_same: "검산: 같음",
  verify_diff: "검산: 다름",
  confirm_diff: "영역은 맞음·전체는 아직",
  regen: "다시 만들 차례",
  gave_up: "다시 만들기 그만둠",
  cleared: "작전 지움",
  requested: "작전 만들기 요청",
};
const WHY: Record<string, string> = {
  blocked_selector: "선택자 정책",
  no_match: "영역을 못 찾음",
  too_many: "맞는 요소가 너무 많음",
  anchor_missing: "기준점 글자가 없음",
  ambiguous: "맞는 영역이 둘 이상",
  hidden: "화면에 안 보임",
  protected: "입력 영역",
  empty: "영역이 빔",
  frame: "영역 안에 프레임",
  cut: "영역이 너무 큼",
  shape: "모양이 바뀜",
  no_probe: "영역을 읽지 못함",
  off_plan: "작전과 다른 상태",
  unsure: "영역만으로 판단 못 함",
  region_error: "영역 판단 요청 실패",
  misses: "연속으로 안 맞음",
  verify_diff: "검산이 다름",
  confirm_diff: "영역 판단이 틀림",
  builds: "자동으로 만든 횟수 한도",
  timeout: "시간 초과",
  schema: "응답 형태",
  secret: "가릴 값이 들어 있음",
  probe: "영역 확인 실패",
  changed: "만드는 사이 페이지가 바뀜",
  region_cut: "영역 글자가 너무 김",
  not_smaller: "전체보다 작지 않음",
  error: "요청 실패",
};

function eventLine(e: PlanEvent): string {
  const why = e.why ? ` (${WHY[e.why] ?? e.why})` : "";
  return `${when(e.at)} · ${EVENT[e.kind] ?? e.kind}${e.n ? ` ${e.n}번` : ""}${why}`;
}

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

// 작전 자세히. 페이지에서 유래한 글이라 텍스트 노드로만 넣는다(HTML로 넣지 않는다). 작전이 없어도 이벤트가 있으면 보인다.
function PlanDetails({ t }: { t: RepeatTask }) {
  const st = t.plan.state === "ready" ? t.plan : null;
  const events = t.planEvents ?? [];
  if (!st && events.length === 0) return null;
  const p = st?.plan;
  return (
    <details className="repeat-plan">
      <summary>작전 자세히</summary>
      {st && p && (
        <>
          <div className="field-hint">페이지를 보고 모델이 만든 내용입니다. 확인 조건·할 일은 바꾸지 못합니다.</div>
          <div className="repeat-meta">볼 영역: {p.region.selector}</div>
          <div className="repeat-meta">
            기준점: {WHERE[p.region.anchor.where] ?? p.region.anchor.where}
            {p.region.anchor.text ? ` · ${p.region.anchor.text}` : ""}
          </div>
          {p.region.shape && <div className="repeat-meta">영역 모양: {p.region.shape}</div>}
          <div className="repeat-meta">판단 기준: {p.criteria}</div>
          {p.mismatch && <div className="repeat-meta">안 맞는 신호: {p.mismatch}</div>}
          <div className="repeat-meta">페이지만으로 판단: {p.pageOnly ? "예" : "아니오(시간·페이지 밖 정보에 달림 — 생략하지 않음)"}</div>
          <div className="repeat-meta">
            만든 때 {when(p.createdAt)} · 글자 {p.fullChars.toLocaleString("ko-KR")}자 → {p.regionChars.toLocaleString("ko-KR")}자
          </div>
          <div className="repeat-meta">
            생략 {st.skips}회 · 검산까지 {roundsToVerify(st)}회차(또는 {when(st.lastFullAt + PLAN_VERIFY_MS)}) · 연속 안 맞음 {st.misses}번 · 자동으로 만든 작전 {t.planBuilds}개
          </div>
        </>
      )}
      {events.length > 0 && (
        <ul className="repeat-plan-events">
          {events
            .slice()
            .reverse()
            .map((e, i) => (
              <li key={`${e.at}-${i}`} className="repeat-meta">
                {eventLine(e)}
              </li>
            ))}
        </ul>
      )}
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
