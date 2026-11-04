// 반복 작업 "이어서 진행"(#138)의 탭 준비와 넘기기(#145). 진행 상태로 바꾼 뒤(claim은 부르는 쪽) 작업 탭을 열고, 새 대화에 넘기기 전에
// 취소(새 대화·패널 닫힘)·검증 실패·넘기기 실패가 있으면 연 탭을 닫고 작업을 '조건 맞음'으로 되돌린다. 단계마다 취소를 보고, 작업 검증은
// 기다림(탭 열기·포커스)이 모두 끝난 뒤에 해 그 사이 지운 작업을 놓치지 않는다. 검증·취소 확인과 넘기기 사이에는 기다림이 없다(handOver는 동기). npm test로 시험하므로 다른 모듈을 불러오지 않는다.

export interface ContinueDeps {
  // 새 대화 동작이 있었거나 패널이 닫혔는지.
  cancelled(): boolean;
  openTab(): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  // 탭을 준비하는 사이 작업이 지워지거나 바뀌었으면 던진다.
  verify(): Promise<void>;
  focus(tabId: number): Promise<void>;
  // 새 대화로 넘긴다(패널에 알리고 대화를 시작). 실패하면 던진다 — 그때 탭은 아직 넘기지 않은 것이다.
  handOver(tabId: number): void;
  release(): Promise<void>;
}

class Cancelled extends Error {}

// "started": 새 대화에 넘김. "cancelled": 취소로 그만둠(알리지 않는다). 그 밖의 실패는 던진다(탭은 닫고 되돌린 뒤).
export async function runContinue(deps: ContinueDeps): Promise<"started" | "cancelled"> {
  let tabId: number | null = null;
  const stopIfCancelled = () => {
    if (deps.cancelled()) throw new Cancelled();
  };
  try {
    stopIfCancelled();
    tabId = await deps.openTab();
    stopIfCancelled();
    await deps.focus(tabId);
    stopIfCancelled();
    await deps.verify();
    stopIfCancelled();
    deps.handOver(tabId);
    return "started";
  } catch (err) {
    if (tabId !== null) await deps.closeTab(tabId).catch(() => {});
    await deps.release().catch(() => {});
    if (err instanceof Cancelled) return "cancelled";
    throw err;
  }
}
