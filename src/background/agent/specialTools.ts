// 특수 도구(#263 단계 5): 반복 작업 등록(schedule_repeat_task, #138)과 "이 페이지 기억해줘"(remember_page). 둘 다 승인 판정(authorizeCall)을
// 거치지 않고 ChatAgent.handleCall이 바로 넘긴다 — 원격 요청에서는 그 앞(REMOTE_BLOCKED_TOOLS)에서 이미 막힌다.
// 대화 상태는 ChatAgent가 주인이다. 읽기는 getter로(옮기기 전에 this를 읽던 시점 그대로), 쓰기는 콜백으로 한다.
// 카드 대기는 waitApproval(callId)로 한다: 대기 등록(pendingApprovals.set)을 그 안에서 동기로 하고, 풀린 뒤 clearApproval로 지운다
// (옮기기 전 `await new Promise(set)` → `delete`와 같은 순서·같은 마이크로태스크).
import type { BgToPanel } from "@/lib/messages";
import type { OpenRouterMessage } from "@/lib/openrouter";
import { providerAdapter } from "@/lib/providers";
import { normalizeRepeatArgs, type RepeatArgs, type RepeatTask } from "@/lib/repeatTask";
import { activeModel } from "@/lib/settings";
import { debugLog } from "../debug";
import { registerRepeatTask } from "../repeatTasks";
import { makeOfferResult, OFFER_REFUSAL_TEXT } from "../savedPagesStore";
import { getSettings } from "../storage";
import { recheckTabPopup, resolveTurnTab, topDocumentId, type TurnTab } from "../tools/handlers";
import { tabLoaded } from "./tabContext";
import { logToolFail, type ToolCallContext } from "./toolCall";

export interface SpecialToolDeps {
  isStale(turn: number): boolean;
  send(msg: BgToPanel): void;
  // 도구 결과를 기록에 넣을 글로 만든다(탭 안내 붙이기·넣은 로그인 값 가리기).
  toolContent(turnTab: TurnTab, payload: Record<string, unknown>): string;
  pushHistory(msg: OpenRouterMessage): void;
  // 카드 답을 기다린다. 대기 등록은 이 호출 안에서 동기로 끝난다(원격의 send 거절이 setTimeout(0)으로 푸는 순서 — 1.2 메모).
  waitApproval(callId: string): Promise<boolean>;
  // 풀린 대기를 지운다(옮기기 전의 pendingApprovals.delete 자리).
  clearApproval(callId: string): void;
  // 취소 결과를 남긴다(ChatAgent.cancelCall, 로그인 열쇠 없음).
  cancelCall(call: ToolCallContext): void;
  // 이번 턴의 사용자 요청 글(읽는 시점마다 다시 읽는다).
  turnRequest(): string;
  // 이 대화에 외부 본문 보호가 켜졌는지(읽는 시점마다 다시 읽는다).
  externalContent(): boolean;
  // 이 턴에 저장 카드를 띄운 주소로 기록한다(턴이 바뀌었으면 새 목록).
  rememberUrl(turn: number, url: string): void;
}

// 반복 작업 등록(#138): 실행 방식·맡긴 작업·이번 대화 허락과 관계없이 늘 카드로 묻는다(브라우저에 남아 페이지를 다시 여는
// 활동을 새로 만든다). 승인은 이 등록에만 쓰고 맡긴 작업·대화 허락을 주지 않는다. false: 이 요청이 끝났다.
export async function scheduleRepeat(call: ToolCallContext, deps: SpecialToolDeps): Promise<boolean> {
  const { turn, turnTab, callId, toolName, argsKey, failCall } = call;
  let args: Required<RepeatArgs>;
  try {
    args = normalizeRepeatArgs(call.parsedArgs as RepeatArgs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logToolFail(toolName, msg);
    failCall(msg, argsKey);
    return true;
  }
  const { provider } = activeModel(await getSettings());
  if (deps.isStale(turn)) return false;
  const timeOf = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const details = [
    `요청: ${deps.turnRequest().slice(0, 500)}`,
    `확인할 페이지: ${args.url}`,
    `조건: ${args.check}`,
    `조건이 맞으면: ${args.then}`,
    `간격: ${args.intervalMinutes}분마다 · 승인한 때부터 ${args.endsInHours}시간 · 최대 ${args.maxRuns}번`,
    "",
    `· 확인할 때마다 그 페이지를 새로고침하고 화면 글자를 ${providerAdapter(provider).label}로 보내 모델을 한 번 부릅니다(최대 ${args.maxRuns}번, 요금이 듭니다). 입력 칸에 쓴 값은 보내지 않습니다.`,
    "· 조건이 맞으면 알려 드립니다. 다음 일은 '이어서 진행'을 직접 눌러야 새 대화로 시작합니다.",
    "· 이어서 진행한 대화는 지금 실행 방식을 따릅니다('처음에 승인 받고 끝까지 실행'이면 그 대화에서 맡긴 뒤로는 결제·삭제도 묻지 않습니다).",
    "· 설정 → 반복 작업에서 언제든 멈추거나 지울 수 있습니다.",
  ].join("\n");
  debugLog("tool:awaiting_repeat", args.title);
  deps.send({ kind: "tool_pending", callId, toolName, args: call.parsedArgs, previewSummary: "이 반복 작업을 등록할까요?", previewDetails: details });
  const approved = await deps.waitApproval(callId);
  deps.clearApproval(callId);
  if (deps.isStale(turn)) return false;
  if (!approved) {
    deps.cancelCall(call);
    return true;
  }
  let task: RepeatTask;
  try {
    task = await registerRepeatTask(args, deps.turnRequest());
  } catch (err) {
    if (deps.isStale(turn)) return false;
    const msg = err instanceof Error ? err.message : String(err);
    logToolFail(toolName, msg);
    failCall(msg, argsKey);
    return true;
  }
  if (deps.isStale(turn)) return false;
  // 끝나는 시각은 승인한 때부터 센다(실제로 저장한 값으로 알린다).
  const until = timeOf(task.endsAt);
  const summary = `반복 작업 등록: ${task.title} · ${task.intervalMinutes}분마다 · ${until}까지`;
  deps.send({ kind: "tool_result", callId, toolName, ok: true, summary });
  deps.pushHistory({
    role: "tool",
    tool_call_id: call.modelCallId,
    name: toolName,
    content: deps.toolContent(turnTab, {
      result: {
        registered: true,
        intervalMinutes: task.intervalMinutes,
        until,
        maxRuns: task.maxRuns,
        note: "등록했습니다. 지금 대화에서는 다음 일을 하지 않습니다. 조건이 맞으면 사용자가 '이어서 진행'으로 새 대화를 시작합니다. 무엇을 언제까지 확인하는지 짧게 알려 주세요.",
      },
    }),
  });
  call.record(toolName, argsKey, true, `repeat:${task.id}`, summary);
  return true;
}

// "이 페이지 기억해줘": 지금 도구가 동작하는 탭(팝업·새 탭을 따라가는 중이면 그 탭)의 저장 카드를 펼친 채 띄운다.
// 저장은 사용자가 카드에서 저장을 누를 때만 된다(페이지 글의 지시로 모델이 불러도 저장되지 않는다). 외부 본문 보호가 켜진
// 대화면 초안을 자동으로 묻지 않는다(사용자가 "다시 채우기"를 누를 때만 보낸다).
export async function rememberPage(call: ToolCallContext, deps: SpecialToolDeps): Promise<boolean> {
  const { turn, turnTab, callId, toolName, argsKey, failCall } = call;
  // 다른 도구와 같은 탭 검사(따라가는 탭이 앞에 보이는지, 첫 도구 전이면 따라가기 시작한 문서 그대로인지)를 거친다.
  let tabId: number;
  let expectDoc: string | null;
  let expectUrl: string;
  try {
    tabId = await resolveTurnTab(turnTab);
    // 이동 직후 불렸으면 페이지가 뜬 뒤의 문서로 만든다(#240 — 아직 커밋되지 않은 이동이면 이전 페이지의 카드가 뜬다).
    if (!(await tabLoaded(tabId))) throw new Error("페이지가 아직 뜨는 중이라 기억하지 않았습니다. 페이지가 다 뜬 뒤 다시 요청하세요.");
    // 따라가는 탭 팝업이면 확인한 문서에 고정한다(그 사이 바뀌면 만들지 않음). 아니면 지금 문서. 확인하지 못하면(null) 만들지 않는다.
    expectDoc = (await recheckTabPopup(turnTab, tabId)) ?? (await topDocumentId(tabId));
    // 문서를 고정한 뒤의 주소(같은 문서 안 주소 이동도 막는다).
    expectUrl = (await chrome.tabs.get(tabId)).url ?? "";
  } catch (err) {
    if (deps.isStale(turn)) return false;
    const msg = err instanceof Error ? err.message : String(err);
    logToolFail(toolName, msg);
    failCall(msg, argsKey);
    return true;
  }
  if (deps.isStale(turn)) return false;
  const res = await makeOfferResult(tabId, null, { query: deps.turnRequest(), answer: "" }, expectDoc, expectUrl).catch(() => ({ reason: "tab_gone" as const }));
  if (deps.isStale(turn)) return false;
  if ("reason" in res) {
    const msg = OFFER_REFUSAL_TEXT[res.reason];
    logToolFail(toolName, msg);
    failCall(msg, argsKey);
    return true;
  }
  deps.rememberUrl(turn, res.offer.url);
  const autoDraft = !deps.externalContent();
  deps.send({ kind: "page_save_offer", offer: res.offer, open: true, autoDraft });
  const summary = "이 페이지의 저장 카드를 띄움(사용자가 저장을 눌러야 저장)";
  deps.send({ kind: "tool_result", callId, toolName, ok: true, summary });
  deps.pushHistory({
    role: "tool",
    tool_call_id: call.modelCallId,
    name: toolName,
    content: deps.toolContent(turnTab, {
      result: {
        shown: true,
        note: `저장 카드를 띄웠습니다${autoDraft ? "(이름·용도·입력 자리는 자동으로 채워집니다)" : ""}. 아직 저장되지 않았습니다. 사용자가 카드에서 내용을 확인하고 저장을 눌러야 저장된다고 알려 주세요.`,
      },
    }),
  });
  call.record(toolName, argsKey, true, "remember:shown", summary);
  return true;
}
