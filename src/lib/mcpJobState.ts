// MCP 작업 기록의 상태 전이(#145). 실행 중인 작업(job)과 보내지 못한 결과(pending)를 늘 한 번의 저장으로 바꿔, 그 사이 서비스 워커가
// 내려가도 다시 뜨면 둘 중 하나는 남게 한다 — job이 남으면 중단으로 보고하고, pending이 남으면 다시 보낸다(클라이언트가 기한까지
// 아무 답 없이 기다리지 않게). npm test로 시험하므로 다른 모듈을 불러오지 않는다.

export interface McpJobRef {
  bridgeId: string;
  jobId: string;
}

export interface McpPendingResult {
  bridgeId: string;
  jobId: string;
  outcome: "ok" | "error";
  text: string;
}

export interface McpJobState {
  job: McpJobRef | null;
  pending: McpPendingResult | null;
}

export const INTERRUPTED_TEXT = "브라우저가 다시 시작되어 요청이 중단되었습니다. 다시 요청하세요.";

// 작업을 마쳤다: 그 작업의 기록을 지우고 결과를 보낼 것으로 남긴다(한 번에). 기록이 다른 작업이면 기록은 그대로 둔다.
export function finishJob<S extends McpJobState>(state: S, jobId: string, pending: McpPendingResult): S {
  return { ...state, job: state.job?.jobId === jobId ? null : state.job, pending };
}

// 다시 뜬 뒤 남은 작업 기록: 이 다리의 기록이고 이 서비스 워커가 맡고 있는 작업(실행 중이거나 결과를 준비 중)이 아니면, 기록을 지우고
// 중단 결과를 보낼 것으로 남긴다(한 번에). 해당하지 않으면 null.
export function recoverJob<S extends McpJobState>(state: S, bridgeId: string, owned: ReadonlySet<string>): S | null {
  const job = state.job;
  if (!job || job.bridgeId !== bridgeId || owned.has(job.jobId)) return null;
  return { ...state, job: null, pending: { bridgeId, jobId: job.jobId, outcome: "error", text: INTERRUPTED_TEXT } };
}
