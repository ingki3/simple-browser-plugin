// 모델 요청 한 번의 준비(#263 단계 4): 저장 링크 후보 조회, 문맥을 서명하는 제공자의 후보 규칙, 이 요청에만 붙이는 안내 조립,
// 보내기 직전의 마지막 가림, 그 사이의 대상 확인. 마지막 대상 확인(targetMoved(latest))과 연결(openStream)은 ChatAgent.requestModel에
// 남는다 — 그 확인이 끝난 뒤 요청을 열 때까지 기다림이 없어야 해서(#193) 같은 함수·같은 동기 구간에 둔다.
// 대화 상태는 ChatAgent가 주인이다. 여기서는 읽기는 getter로(옮기기 전에 this를 읽던 시점 그대로), 쓰기는 콜백으로 한다.
import { nowNote } from "@/lib/systemPrompt";
import { candidateIdsOf } from "@/lib/savedPages";
import { activeModel } from "@/lib/settings";
import type { OpenRouterMessage } from "@/lib/openrouter";
import type { RunMode } from "@/lib/messages";
import { candidatesMessage } from "../savedPagesStore";
import { maskMessagesForModel, maskSyncMessages } from "../loginSecrets";
import { getSettings } from "../storage";
import { debugLog } from "../debug";
import type { RebaseOffer } from "../tools/rowRebase";
import { TASK_MODE_NOTE } from "./prompts";

export interface PrepDeps {
  systemPrompt: string;
  wrapUpNote?: string;
  // 이 턴의 첫 요청이면 후보를 붙였는지 로그에 남긴다(#156).
  logCandidates: boolean;
  // 후보를 고를 턴 탭(오류 턴 탭이면 null).
  candidateTabId: number | null;
  isStale(): boolean;
  // 설정에서 보낼 대상이 바뀌었는지(이 턴의 멈춤 표시 또는 지금 설정의 대상이 대화의 대상과 다름).
  targetMoved(now: ReturnType<typeof activeModel>): boolean;
  // 대상이 바뀌어 멈출 때: 준비 정리와 이 턴의 멈춤 표시를 하고 던질 오류를 돌려준다.
  stopForTarget(): Error;
  // 준비 단계에서 끝날 때의 정리(#266): 연결 타이머 해제, 자기 요청일 때만 activeRequest 비움.
  releasePrep(): void;
  // 기록에 보낸 후보를 거둘 수 없어 다음 요청을 새 대화로 시작하게 한다.
  forceNewConversation(): void;
  // 마지막 가림이 넣은 로그인 값을 가렸을 때(이 대화에 가린 적이 있다는 표시).
  markMasked(): void;
  // 지금 제공자가 문맥을 서명하는지(읽는 시점마다 다시 읽는다).
  signsContext(): boolean;
  history(): readonly OpenRouterMessage[];
  committedCandidates(): { text: string; ids: Set<string> } | null;
  effectiveRunMode(stored: RunMode): RunMode;
  taskApproved(): boolean;
  rebasePending(): readonly RebaseOffer[];
}

export interface PreparedRequest {
  // 이번 요청에 실을 저장 링크 후보 글자(싣지 않으면 null).
  candidatesNote: string | null;
  // 서명 제공자의 도구 결과 다음 요청인지(현재 시각·후보·맡기기 안내를 붙이지 않는다).
  afterToolResult: boolean;
  // 이 요청에만 붙인 안내(가린 뒤). 서명 제공자면 응답 앞에 기록으로 남긴다.
  sentNotes: OpenRouterMessage[];
  // 이 요청 기록에 실린 결과가 낸 대화별 기준(#233). 응답을 끝까지 받으면 확정한다.
  sentRebases: RebaseOffer[];
  // 마지막 가림을 거친 보낼 메시지.
  outgoing: { value: OpenRouterMessage[]; masked: boolean };
}

// 요청을 보낼 준비를 한다. 새 턴에 밀렸으면 정리하고 null, 대상이 바뀌었거나 후보를 거둘 수 없으면 던진다(준비 실패는 호출로
// 세지 않는다). 예외 정리(releasePrep)는 부르는 쪽의 try가 맡는다.
export async function prepareRequest(deps: PrepDeps): Promise<PreparedRequest | null> {
  // 저장한 페이지 후보: 매 요청 직전에 새로 만들고 대화 기록(history)에는 넣지 않는다(지우기·끄기가 다음 요청부터 반영).
  // 마무리 요청(wrapUpNote)에는 붙이지 않는다(이동 후보가 필요 없음).
  // 지금 저장 링크 후보(마무리 요청에도 읽는다 — 기록에 남긴 후보가 지워졌는지 검사용). 실을지는 아래에서 정한다.
  const currentCandidates = await candidatesMessage(deps.candidateTabId, deps.logCandidates).catch(() => null);
  const savedCandidates = deps.wrapUpNote ? null : currentCandidates;
  if (deps.isStale()) {
    deps.releasePrep();
    return null;
  }
  // 턴 도중 설정에서 제공자·키·모델을 바꿨으면 이 턴의 내용을 새 설정으로도, 이전 제공자로도 보내지 않고 멈춘다
  // (고른 제공자로만 보낸다는 약속). 모든 준비가 끝난 뒤 requestModel이 요청을 열기 바로 앞에서 한 번 더 본다 — 그 확인과 요청
  // 사이에는 기다림이 없다. 다음 요청에서 새 설정으로 대화를 새로 시작한다.
  const now = activeModel(await getSettings());
  if (deps.isStale()) {
    deps.releasePrep();
    return null;
  }
  if (deps.targetMoved(now)) throw deps.stopForTarget();
  // 문맥을 서명하는 제공자: 기록에 남긴 후보를 지웠거나 껐으면 거둘 수 없으니 멈추고 새 대화로, 바뀌지 않았으면 다시 싣지 않는다.
  let candidatesNote = savedCandidates;
  // 그런 제공자(Anthropic)는 도구 결과 바로 뒤에 글자 안내를 붙이면 빈 응답으로 끝낼 수 있어, 도구 결과 다음 요청에는
  // 현재 시각·후보 안내를 붙이지 않는다(사용자 요청 직후 요청에만). 마무리 안내는 그대로 붙인다.
  const signs = deps.signsContext();
  const history = deps.history();
  const afterToolResult = signs && history[history.length - 1]?.role === "tool";
  const committed = deps.committedCandidates();
  if (deps.signsContext() && committed) {
    const now = new Set(currentCandidates ? candidateIdsOf(currentCandidates) : []);
    if ([...committed.ids].some((id) => !now.has(id))) {
      deps.releasePrep();
      deps.forceNewConversation();
      throw new Error("저장 링크를 지우거나 꺼서 이 대화에 이미 보낸 후보를 거둘 수 없어 멈췄습니다. 다시 요청하면 새 대화로 시작합니다.");
    }
    if (savedCandidates === committed.text) candidatesNote = null;
  }
  const runMode = deps.effectiveRunMode((await getSettings()).runMode);
  const taskNote = runMode === "task" && !deps.taskApproved() && !afterToolResult ? TASK_MODE_NOTE : null;
  const sentNotes = maskSyncMessages<OpenRouterMessage>([
    ...(afterToolResult ? [] : [{ role: "user" as const, content: nowNote() }]),
    ...(taskNote ? [{ role: "user" as const, content: taskNote }] : []),
    ...(candidatesNote && !afterToolResult ? [{ role: "user" as const, content: candidatesNote }] : []),
    ...(deps.wrapUpNote ? [{ role: "user" as const, content: deps.wrapUpNote }] : []),
    // 문맥을 서명하는 제공자는 이 안내를 기록에 남기므로 남기기 전에 가린다.
  ]).value;
  // 이 요청 기록에 실린 결과가 낸 대화별 기준(#233). 응답을 끝까지 받으면 확정한다(requestModel의 return 앞).
  const sentRebases = [...deps.rebasePending()];
  // 자동 로그인으로 넣은 값은 어디서 왔든(기록·메모·안내) 모델로 보내지 않는다(기록에 넣을 때 이미 가렸고, 여기는 마지막 거르기 —
  // 앞의 가림과 관계없이 둔다).
  const outgoing = await maskMessagesForModel<OpenRouterMessage>([
    { role: "system", content: deps.systemPrompt },
    ...deps.history(),
    // 현재 시각·저장 링크 후보·마무리 안내는 이 요청에만 붙인다(문맥을 서명하는 제공자는 응답과 함께 기록에 남김).
    ...sentNotes,
  ]);
  if (outgoing.masked) {
    deps.markMasked();
    debugLog("login:masked", "모델 요청에서 넣은 로그인 값을 가림", "warn");
  }
  return { candidatesNote, afterToolResult, sentNotes, sentRebases, outgoing };
}
