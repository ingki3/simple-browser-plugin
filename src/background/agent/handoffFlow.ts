// 손 넘기기(#263 단계 5, 0.2.2 직접 조작할 사이트): 대상을 페이지에 표시하고 사용자가 직접 조작하기를 기다린다(handOff), 그동안 그 탭이
// 여는 팝업 창을 지켜본다(watchHandoffPopups, #81), 사용자가 마친 호출의 결과를 남긴다(finishHandoff).
// 대화 상태는 ChatAgent가 주인이다. 쓰기·보내기는 콜백으로 한다. 탭은 호출마다 받은 고정 인자(call.turnTab, R4)다.
// 대기는 waitApproval(callId)로 한다: 대기 등록(pendingApprovals.set)을 그 안에서 동기로 한다 — 원격 대화의 send는 카드 대신 거절을
// setTimeout(0)으로 예약하므로, 등록이 그 타이머보다 늦으면 대기가 풀리지 않는다. 풀린 뒤 stopWatch → clearApproval → 표시 해제 순서는
// 옮기기 전 그대로다.
import type { BgToPanel } from "@/lib/messages";
import { describePopup } from "@/lib/actionTarget";
import { HANDOFF_LABELS, handoffResultText, type HandoffOutcome } from "@/lib/manualSites";
import type { OpenRouterMessage } from "@/lib/openrouter";
import { debugLog } from "../debug";
import { endHandoff, showHandoff, watchHandoff, type HandoffSession } from "../handoff";
import { settlePopups, watchNewTabs } from "../popups";
import { discardSignIn } from "../signIn";
import { recordCancelledAction, recordHandedOffAction, type ToolPreview } from "../tools/dispatcher";
import { resolveTurnTab, type TurnTab } from "../tools/handlers";
import { DONE, STALE, logToolFail, type ToolCallContext } from "./toolCall";

// 손 넘기기 클릭이 연 팝업 창(#81): 클릭을 안 뒤 창이 만들어지기를 기다리는 시간, 페이지가 기록한 클릭 시각보다 앞서
// 본 창도 그 클릭의 것으로 보는 작은 여유(같은 시계지만 기록 순서가 어긋날 수 있다). 그보다 먼저 열린 창(기다리는 동안
// 사용자가 다른 곳을 눌러 연 창)은 따라가지 않는다.
const HANDOFF_POPUP_SETTLE_MS = 800;
const HANDOFF_POPUP_LEAD_MS = 200;

// 손 넘기기(클릭) 동안 지금 도구 탭이 여는 창 감시(#81).
export type HandoffPopups = { stop(): void; settle(clickedAt: number, stale: () => boolean): Promise<string | null> };

// 사용자가 직접 조작해 마쳤다(실행하지 않는다).
export interface HandedOff {
  kind: "handoff";
  outcome: HandoffOutcome;
  // sign_in 준비의 열쇠(받은 값을 버린다).
  signInToken: string | null;
  // 사용자가 대상을 누른 것으로 끝났을 때만 남긴 창 감시와 그 클릭 시각.
  popups: HandoffPopups | null;
  clickedAt: number;
}

export interface HandoffDeps {
  isStale(turn: number): boolean;
  send(msg: BgToPanel): void;
  // 도구 결과를 기록에 넣을 글로 만든다(탭 안내 붙이기·넣은 로그인 값 가리기).
  toolContent(turnTab: TurnTab, payload: Record<string, unknown>): string;
  pushHistory(msg: OpenRouterMessage): void;
  // 카드 답을 기다린다. 대기 등록은 이 호출 안에서 동기로 끝난다(위 머리말).
  waitApproval(callId: string): Promise<boolean>;
  // 풀린 대기를 지운다(옮기기 전의 pendingApprovals.delete 자리).
  clearApproval(callId: string): void;
  // 등록된 대기가 있으면 푼다(감시가 사용자의 조작·만료를 알릴 때).
  resolveApproval(callId: string, approved: boolean): void;
}

// 손 넘기기(클릭) 동안 지금 도구 탭이 여는 새 탭·창을 지켜본다(#81). settle(clickedAt): 사용자가 대상을 누른 즈음
// (clickedAt 앞 HANDOFF_POPUP_LEAD_MS부터) 열린 창만 클릭과 같은 규칙(settlePopups)으로 따라가고 안내 문구를 돌려준다.
// 손 넘기기는 window.open을 감싸지 않으므로(오래 기다림) 따로 뜬 팝업 창만 따라간다 — 같은 창의 탭으로 열린 것은 그
// 기록이 없어 따라가지 않는다.
async function watchHandoffPopups(
  turnTab: TurnTab,
): Promise<HandoffPopups | null> {
  let tabId: number;
  try {
    tabId = await resolveTurnTab(turnTab);
  } catch {
    return null;
  }
  const before = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? "";
  const sourceWindowId = await chrome.tabs.get(tabId).then((t) => t.windowId, () => null);
  const watch = watchNewTabs(tabId);
  let stopped = false;
  const stop = () => {
    if (stopped) return [];
    stopped = true;
    return watch.stop();
  };
  return {
    stop: () => void stop(),
    settle: async (clickedAt, stale) => {
      // 클릭이 연 창이 만들어질 시간을 잠깐 준다.
      await new Promise((r) => setTimeout(r, HANDOFF_POPUP_SETTLE_MS));
      const created = stop().filter((t) => clickedAt > 0 && (t.at ?? 0) >= clickedAt - HANDOFF_POPUP_LEAD_MS);
      if (!created.length || stale() || "error" in turnTab) return null;
      // 따라갈 창은 사본에서 정하고, 그 사이 중단·새 요청이 없을 때만 이 턴에 반영한다(중단된 턴이 팝업을 남기지 않게).
      const scratch = { ...turnTab, popups: [...(turnTab.popups ?? [])] };
      const popup = await settlePopups(scratch, before, created, { calls: [], complete: false }, tabId, sourceWindowId);
      if (stale()) return null;
      turnTab.popups = scratch.popups;
      turnTab.originDocumentId = scratch.originDocumentId;
      return popup ? describePopup(popup).join(" ") : null;
    },
  };
}

// 손 넘기기: 페이지에 대상을 표시하고 사용자가 직접 조작(클릭·입력·로그인)하기를 기다린다.
export async function handOff(
  call: ToolCallContext,
  preview: ToolPreview,
  signInToken: string | null,
  signInHandoffWhy: string | null,
  deps: HandoffDeps,
): Promise<typeof STALE | typeof DONE | { kind: "cancelled" } | HandedOff> {
  const { turn, turnTab, callId, toolName, parsedArgs, argsKey, failCall } = call;
  const ids =
    toolName === "click_element" || toolName === "sign_in"
      ? [(parsedArgs as { id: string }).id]
      : (parsedArgs as { fills: Array<{ id: string }> }).fills.map((f) => f.id);
  // 사용자가 표시한 대상을 눌러 팝업 창을 열면 그 창을 따라간다(#81). 넘기는 동안 이 탭이 여는 창을 지켜보고,
  // 사용자가 대상을 누른 것(clicked)으로 끝났을 때만 그 즈음 열린 창을 클릭과 같은 규칙으로 따라간다.
  const popups = toolName === "click_element" ? await watchHandoffPopups(turnTab) : null;
  let shown: HandoffSession;
  try {
    // sign_in은 칸을 준비 열쇠(token)로 승인 대상에 남겼다.
    shown = await showHandoff(turnTab, (toolName === "sign_in" && signInToken) || callId, toolName === "click_element" ? "c" : "f", ids);
  } catch (err) {
    popups?.stop();
    if (deps.isStale(turn)) return STALE;
    const msg = err instanceof Error ? err.message : String(err);
    logToolFail(toolName, msg);
    recordCancelledAction(callId, turnTab);
    failCall(msg, argsKey);
    return DONE;
  }
  if (deps.isStale(turn)) {
    void endHandoff(shown);
    popups?.stop();
    return STALE;
  }
  debugLog("tool:handoff", toolName);
  deps.send({
    kind: "tool_pending",
    callId,
    toolName,
    args: parsedArgs,
    previewSummary:
      toolName === "click_element"
        ? "페이지에 표시한 대상을 직접 눌러 주세요. 누르면 이어서 진행합니다."
        : toolName === "sign_in"
          ? `페이지에 표시한 로그인 칸에서 직접 로그인해 주세요(브라우저·비밀번호 관리자의 자동 채우기를 써도 됩니다). 로그인을 마치면 "했어요"를 눌러 주세요.`
          : `페이지에 표시한 칸에 아래 값을 직접 입력하고 "했어요"를 눌러 주세요.`,
    // 사용자가 직접 입력하므로 값을 자르지 않은 전체 목록을 보인다(승인 카드 요약은 10칸·80자까지).
    previewDetails: toolName === "sign_in" ? (signInHandoffWhy ?? "") : (preview.handoffDetails ?? preview.details),
    handoff: true,
  });
  let by: HandoffOutcome = "confirmed";
  let expired = false;
  // 페이지가 기록한 실제 클릭 시각(확인은 0.5초 간격이라 늦다). 없으면 0 — 어느 창이 그 클릭의 것인지 몰라
  // 따라가지 않는다.
  let clickedAt = 0;
  const stopWatch = watchHandoff(shown, (outcome, at) => {
    // 로그인은 문서가 바뀌어도(2단계 인증 화면 등) 끝난 것이 아니다. 사용자가 "했어요"를 누를 때까지 기다린다.
    if (toolName === "sign_in" && outcome !== "expired") return;
    if (outcome === "expired") expired = true;
    else by = outcome;
    if (outcome === "clicked") clickedAt = at ?? 0;
    deps.resolveApproval(callId, !expired);
  });
  const approved = await deps.waitApproval(callId);
  stopWatch();
  deps.clearApproval(callId);
  void endHandoff(shown);
  if (deps.isStale(turn)) {
    popups?.stop();
    return STALE;
  }
  debugLog("tool:handoff_result", `${toolName} ${approved ? by : expired ? "expired" : "cancelled"}`);
  const keepPopups = approved && by === ("clicked" as HandoffOutcome) && clickedAt > 0;
  if (!keepPopups) popups?.stop();
  if (expired) {
    const msg = "사용자가 표시한 대상을 오래 조작하지 않아 직접 조작 안내를 끝냈습니다. 사용자에게 계속할지 물으세요.";
    recordCancelledAction(callId, turnTab);
    failCall(msg, argsKey);
    return DONE;
  }
  if (!approved) return { kind: "cancelled" };
  return { kind: "handoff", outcome: by, signInToken, popups: keepPopups ? popups : null, clickedAt };
}

// 사용자가 직접 조작해 마친 호출(실행하지 않는다)의 결과를 남긴다. false: 이 요청이 끝났다.
export async function finishHandoff(call: ToolCallContext, handed: HandedOff, deps: HandoffDeps): Promise<boolean> {
  const { turn, turnTab, callId, toolName, argsKey } = call;
  const { outcome } = handed;
  let note: string;
  let summary: string;
  if (toolName === "sign_in") {
    discardSignIn(handed.signInToken);
    note = "사용자가 직접 로그인을 마쳤다고 알렸습니다. 결과는 페이지를 다시 관측해 확인하세요.";
    summary = "직접 로그인 · 사용자가 마쳤다고 알림";
  } else {
    recordHandedOffAction(callId, turnTab);
    // 사용자의 클릭이 팝업 창을 열었으면 따라가고 그 안내를 붙인다(클릭 결과와 같은 문구).
    const popupNote = handed.popups
      ? await handed.popups.settle(handed.clickedAt, () => deps.isStale(turn)).catch(() => null)
      : null;
    if (deps.isStale(turn)) return false;
    // 손 넘기기는 클릭·입력·로그인에만 한다(decideApproval의 isPageAction, signInApproval).
    note = `${handoffResultText(toolName as "click_element" | "fill_form_fields", outcome)}${popupNote ? ` ${popupNote}` : ""}`;
    summary = `직접 조작 · ${HANDOFF_LABELS[outcome]}`;
  }
  deps.send({ kind: "tool_result", callId, toolName, ok: true, summary });
  deps.pushHistory({
    role: "tool",
    tool_call_id: call.modelCallId,
    name: toolName,
    content: deps.toolContent(turnTab, { result: { handedOff: true, outcome, note } }),
  });
  // 사용자가 한 일이라 같은 대상을 다시 넘겨도 헛돌기로 세지 않는다.
  call.record(toolName, argsKey, true, `handoff:${outcome}`, note, { changed: true });
  return true;
}
