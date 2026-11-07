// 동작 기록(actionLog)·읽기 레시피(readRecipes)·저장한 페이지·페이지 제안이 함께 쓰는 쓰기 큐와 턴 키(#257).
// 부작용 없는 하위 모듈로 두어 actionLog ↔ readRecipes 순환 import를 끊는다(큐·턴 키 인스턴스는 이 모듈 하나).
import type { TurnTab } from "./tools/handlers";

const turnIds = new WeakMap<TurnTab, string>();

// 턴마다 하나인 식별자(같은 TurnTab 객체면 같은 값). 읽기 레시피도 턴 단위로 모을 때 쓴다.
export function turnKey(turnTab: TurnTab): string {
  let id = turnIds.get(turnTab);
  if (!id) {
    id = crypto.randomUUID();
    turnIds.set(turnTab, id);
  }
  return id;
}

// 쓰기를 한 줄로 세운다(읽고-고쳐-쓰는 사이에 다른 쓰기가 끼면 항목이 사라진다).
let writeChain: Promise<unknown> = Promise.resolve();

// 동작 기록과 읽기 레시피가 같이 쓴다(지우기와 쓰기의 순서를 맞추려고).
export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = writeChain.then(job, job);
  writeChain = next.catch(() => undefined);
  return next;
}
