// 도구 호출 하나를 처리할 때 ChatAgent와 떼어낸 처리 모듈(specialTools·handoffFlow)이 함께 쓰는 형태(#263 단계 5).
import type { ToolName } from "@/lib/messages";
import { debugLog } from "../debug";
import type { TurnTab } from "../tools/handlers";

// 이번 요청의 실행 기록에 호출 하나를 더한다(헛돌기 판정과 이어 가기 카드의 요약).
export type RecordRun = (
  tool: string,
  argsKey: string,
  ok: boolean,
  result: string,
  summary: string,
  extra?: { changed?: boolean; cancelled?: boolean },
) => void;

// 도구 호출 하나를 처리하는 동안 함께 쓰는 값.
export interface ToolCallContext {
  turn: number;
  // 이 요청의 탭(this.turnTab은 새 요청이 바꿀 수 있다).
  turnTab: TurnTab;
  // 이 대화 안에서 호출마다 유일한 내부 키(#221). 패널 카드·선택 저장소·content 대상 레지스트리·작업 기록의 키로 쓴다.
  callId: string;
  // 모델이 준 호출 id. 대화 기록(tool_call_id)에만 쓴다 — 모델마다 단순하거나(call_0) 대화끼리 겹칠 수 있어 키로 쓰지 않는다.
  modelCallId: string;
  toolName: ToolName;
  parsedArgs: unknown;
  argsKey: string;
  // 이 호출을 실패로 끝낸다(패널 결과 줄·대화 기록·헛돌기 기록).
  failCall(msg: string, key: string, panelSummary?: string): void;
  record: RecordRun;
}

// 승인 단계의 결론. stale: 이 요청이 끝났다(중단·새 요청). done: 결과를 이미 남겼다(실패·취소).
export const STALE = { kind: "stale" } as const;
export const DONE = { kind: "done" } as const;

// 실패한 도구 호출도 실행 결과와 같은 형식의 디버그 줄로 남긴다.
export function logToolFail(toolName: ToolName, msg: string): void {
  debugLog("tool:result", `${toolName} fail · ${msg.slice(0, 140)}`);
}
