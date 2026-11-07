import { SENSITIVE_TOOLS, type BgToPanel, type RunMode, type Settings, type ToolName } from "@/lib/messages";
import { MissingKeyError, friendlyError } from "@/lib/friendlyError";
import { nowNote } from "@/lib/systemPrompt";
import { describePopup } from "@/lib/actionTarget";
import { remoteActionLines, remoteHopQuestion, remoteRefusal, remoteTaskQuestion, remoteToolQuestion, withPrefix, type RemoteApprover, type RemoteAskResult, type RemoteQuestion } from "@/lib/remoteApproval";
import type { ModelId } from "@/lib/models";
import { internalNavigateAutoBlock, siteOf, userNamedSites } from "@/lib/siteTrust";
import { TOOL_POLICY, needsApprovalWhenProtected } from "@/lib/toolPolicy";
import { isChatGrantTool, type ChatGrantTool } from "@/lib/chatGrant";
import { discardCall as discardTabChoices, setChosen as setChosenTabs } from "../otherTabs";
import { discardLinkCall, setChosenLinks } from "../linkedPages";
import { chosenDownloads, discardDownloadCall, setChosenDownloads } from "../downloadChoices";
import { candidatesMessage, makeOffer, makeOfferResult, OFFER_REFUSAL_TEXT } from "../savedPagesStore";
import { candidateIdsOf } from "@/lib/savedPages";
import { AGENT_MAX_TOKENS } from "@/lib/models";
import { providerAdapter, providerTimeout, type ChatStream, type ProviderId } from "@/lib/providers";
import { activeModel, targetKey } from "@/lib/settings";
import { beginTranslationSession, endTranslationSession } from "../translator";
import {
  type OpenRouterContentPart,
  type OpenRouterMessage,
  type OpenRouterToolCall,
} from "@/lib/openrouter";
import { normalizeRepeatArgs, type RepeatArgs, type RepeatTask } from "@/lib/repeatTask";
import { registerRepeatTask } from "../repeatTasks";
import { buildToolPreview, clearOfferedHints, executeTool, parseToolArgs, recordCancelledAction, recordHandedOffAction } from "../tools/dispatcher";
import type { ToolPreview } from "../tools/dispatcher";
import { takeRebaseOffers, type RebaseOffer } from "../tools/rowRebase";
import { endHandoff, showHandoff, watchHandoff, type HandoffSession } from "../handoff";
import { settlePopups, watchNewTabs } from "../popups";
import {
  LIMIT_NO_ANSWER_NOTE,
  LIMIT_STOP_NOTE,
  REMOTE_REFUSED_NOTE,
  REMOTE_STOP_NOTE,
  TARGET_CHANGED_NOTE,
  TASK_MODE_NOTE,
  availableTools,
  composeSystemPrompt,
  remoteTurnNote,
  spinStopNote,
} from "./prompts";
import { fetchTabHeader, loadedPage, requestTabId, tabLoaded, toolTabUrl, turnTabOf } from "./tabContext";
import { answerSince, closeDanglingToolCalls, confirmRebases, lastAnswerText } from "./history";
import { createReplyAccumulator } from "./streamReply";

// 손 넘기기 클릭이 연 팝업 창(#81): 클릭을 안 뒤 창이 만들어지기를 기다리는 시간, 페이지가 기록한 클릭 시각보다 앞서
// 본 창도 그 클릭의 것으로 보는 작은 여유(같은 시계지만 기록 순서가 어긋날 수 있다). 그보다 먼저 열린 창(기다리는 동안
// 사용자가 다른 곳을 눌러 연 창)은 따라가지 않는다.
const HANDOFF_POPUP_SETTLE_MS = 800;
const HANDOFF_POPUP_LEAD_MS = 200;
import { HANDOFF_LABELS, handoffResultText, isManualSite, type HandoffOutcome } from "@/lib/manualSites";
import { decideApproval, withoutChatGrant, type ApprovalDecision } from "@/lib/approvalDecision";
import { loginSiteFor, newGrantId, signInDecision, MAX_LOGIN_SITES } from "@/lib/loginPolicy";
import { chooseSignInEntry, chosenSignInEntry, discardSignIn } from "../signIn";
import { allSecrets, containsSecret, maskMessagesForModel, maskSyncDeep, maskSyncMessages, warmSecrets } from "../loginSecrets";
import { detachSession, InputSession } from "../trustedInput";
import { prepareGrantImages } from "../tools/grantImages";
import { applySettingsUpdate, getSettings, readFlags, setFlag } from "../storage";
import { beginKeepalive, endKeepalive } from "../keepalive";
import { debugLog, timeSpan } from "../debug";
import { detectPdfAtTab, fetchPdfAsBase64 } from "../pdf";
import {
  resolveTurnTab,
  recheckTabPopup,
  topDocumentId,
  captureTurnTab,
  currentToolTab,
  inheritPopups,
  takeTabNote,
  turnTabIsInternal,
  type TurnTab,
} from "../tools/handlers";
import { commitReads } from "../readRecipes";
import { addUsage, emptyUsageTotal, formatTurnUsage, formatUsage, type ModelUsage, type UsageTotal } from "@/lib/usage";
import {
  canonicalJson,
  clickChangedForSpin,
  detectSpin,
  fingerprint,
  summarizeRuns,
  type ClickEffectLike,
  type ToolRunRecord,
} from "@/lib/hopGuard";

// 모델 요청 한 번의 결과(requestModel).
interface ModelReply {
  // 이 요청 끝에 붙였던 임시 안내(현재 시각·저장 링크 후보·마무리 안내). 문맥을 서명하는 제공자면 응답 앞에 기록으로 남긴다.
  sentNotes: OpenRouterMessage[];
  // 그중 저장 링크 후보 글자(없으면 null).
  sentCandidates: string | null;
  assistantText: string;
  assistantReasoning: string;
  reasoningDetails: unknown[];
  functionCalls: OpenRouterToolCall[];
  finishReason: string | undefined;
  thoughtChars: number;
}

// 이번 요청의 실행 기록에 호출 하나를 더한다(헛돌기 판정과 이어 가기 카드의 요약).
type RecordRun = (
  tool: string,
  argsKey: string,
  ok: boolean,
  result: string,
  summary: string,
  extra?: { changed?: boolean; cancelled?: boolean },
) => void;

// 손 넘기기(클릭) 동안 지금 도구 탭이 여는 창 감시(#81).
type HandoffPopups = { stop(): void; settle(clickedAt: number, stale: () => boolean): Promise<string | null> };

// 도구 호출 하나를 처리하는 동안 함께 쓰는 값.
interface ToolCallContext {
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
const STALE = { kind: "stale" } as const;
const DONE = { kind: "done" } as const;
// 사용자가 직접 조작해 마쳤다(실행하지 않는다).
interface HandedOff {
  kind: "handoff";
  outcome: HandoffOutcome;
  // sign_in 준비의 열쇠(받은 값을 버린다).
  signInToken: string | null;
  // 사용자가 대상을 누른 것으로 끝났을 때만 남긴 창 감시와 그 클릭 시각.
  popups: HandoffPopups | null;
  clickedAt: number;
}
// 실행한다. via: 카드 없이 실행한 이유(이번 대화 허락·자동 실행·맡긴 작업). 카드로 승인했거나 승인 대상이 아니면 null.
interface AuthorizedRun {
  kind: "run";
  execArgs: unknown;
  via: "grant" | "auto" | "task" | null;
  // 이번 대화 허락으로 저장할 이미지를 쿠키 없이 미리 받은 것.
  grantImages?: Map<string, string>;
  // 자동 로그인으로 값을 넣을 출처·단계(실행 직전에 시도로 기록한다).
  signInAttempt: string | null;
  // 내부 페이지에서 자동 이동한 목적지 사이트(이동이 성공하면 이 턴의 사이트로 삼는다).
  internalNavSite: string | null;
}
type CallAuthorization = typeof STALE | typeof DONE | HandedOff | AuthorizedRun;

// 실패한 도구 호출도 실행 결과와 같은 형식의 디버그 줄로 남긴다.
function logToolFail(toolName: ToolName, msg: string): void {
  debugLog("tool:result", `${toolName} fail · ${msg.slice(0, 140)}`);
}

const MAX_DOCUMENT_READS_PER_TURN = 5;

// 원격 대화(텔레그램, #139).
export type AgentChannel = "panel" | "telegram" | "mcp";
export type TurnOutcome = { outcome: "ok" | "aborted"; finalText: string } | { outcome: "error"; finalText: ""; action?: "settings" | "usage" };
// 대화 객체가 이벤트를 보내는 곳(패널 port 또는 원격 채널).
export interface AgentSink {
  postMessage(msg: BgToPanel): void;
}
const REMOTE_BLOCKED_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["sign_in", "open_saved_link", "schedule_repeat_task", "remember_page"]);
const MAX_OTHER_TAB_READS_PER_TURN = 2;

// 턴 시작 옵션. tabId·site: 반복 작업의 이어서 진행(#138). expect: 페이지 제안 실행(#173) — 확인한 탭·주소·문서.
export interface TurnExpect {
  tabId: number;
  url: string;
  documentId: string;
}
// approver: 원격 대화의 승인 질문(#185). 요청마다 채널이 넘긴다(재사용하는 대화가 앞 요청의 연결·신호를 붙잡지 않게).
type TurnOpts = { tabId?: number; site?: string; expect?: TurnExpect; approver?: RemoteApprover };
// buildUserContent가 제안 턴의 대상이 바뀐 것을 알릴 때.
const EXPECT_MISMATCH = Symbol("expect_mismatch");

export class ChatAgent {
  private history: OpenRouterMessage[] = [];
  // 도구 호출의 내부 키를 만드는 값(#221): 대화마다 난수, 호출마다 순번.
  private readonly callNonce = (() => {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  })();
  private callSeq = 0;
  private apiKey: string | null = null;
  private model: ModelId | null = null;
  // 로컬·호환 서버의 정규화한 기본 주소(#193). 이 대화가 보내는 대상(targetKey)의 일부.
  private baseUrl: string | undefined = undefined;
  // 설정에서 보낼 대상이 바뀌어 멈춘 턴(#193). 그 턴의 모델 요청·번역은 더 보내지 않는다.
  private targetChangedTurn = -1;
  // 이 대화가 연 번역 세션(#193 — 탭별). 번역을 멈추거나 대상이 바뀌면 끝낸다.
  private translationSessions = new Map<number, string>();
  // 모델 제공자(#97). 바뀌면 대화 기록을 새로 시작한다(제공자마다 기록 형식·생각 정보가 다르다).
  private provider: ProviderId = "openrouter";
  private customSystemPrompt: string | null = null;
  // 기록을 시작할 때의 빠르게 생각 값(#160). 바뀌면 지침이 달라져 새 대화로 시작한다(서명 제공자의 기존 생각 서명이 무효가 되지 않게).
  private conversationQuick: boolean | null = null;
  // 턴마다 증가. 중단되거나 새 턴에 밀린 루프는 자기 번호가 현재 값과 달라지므로
  // 늦게 끝난 도구 결과를 대화 기록에 쓰지 않고 빠진다.
  private currentTurn = 0;
  // 토큰 사용량(#126): 턴마다의 합계(턴 번호 → 합계, 그 턴이 끝날 때 남기고 지움)와 대화 누계. 누계는 기록을 비울 때 새 객체로
  // 바꾼다 — 끝나지 않은 옛 턴은 시작할 때 붙잡은 옛 누계에 더한다.
  private turnUsage = new Map<number, { total: UsageTotal; conversation: UsageTotal | null; start: number }>();
  private conversationUsage: UsageTotal = emptyUsageTotal();
  private activeRequest: AbortController | null = null;
  // 백그라운드에서 직접 네트워크를 쓰는 도구(read_document)를 중단 시 함께 끊는다.
  private activeTool: AbortController | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  // 자동 실행해도 되는 사이트: 이 턴을 시작한 탭의 사이트와, 이 대화에서 승인 카드로 이동을 허락한 사이트.
  private turnSite: string | null = null;
  private approvedSites = new Set<string>();
  // 이번 요청 글에 사용자가 적은 웹 주소·도메인의 출처(#54). 턴 탭이 내부 페이지(새 탭·설정)일 때의 이동에만 쓴다.
  private turnNamedSites: string[] = [];
  // 승인 카드에서 "이번 요청 동안 링크 이동 묻지 않기"를 고른 턴과 그 카드의 페이지 사이트. 턴 번호는 새 요청·중단마다
  // 바뀌므로 그 요청이 끝나면 저절로 쓰이지 않고, 대화 전체의 신뢰 사이트와 달리 그 사이트 안의 링크에만 쓴다.
  // 그 선택지를 보여 준 카드(callId → 턴·사이트)만 받아들인다.
  private linkGrant: { turn: number; site: string } | null = null;
  private linkGrantOffers = new Map<string, { turn: number; site: string }>();
  // "이번 대화 동안 이 도구 묻지 않기"(#53): 허락한 도구 → 범위(download_images는 저장 폴더). 이 객체는 대화마다 새로
  // 만들어지고(새 대화·패널 닫힘·서비스 워커 재시작) 저장소에 남기지 않으므로 그 대화가 끝나면 함께 사라진다.
  // 링크 이동 허락(linkGrant)과는 대상 도구가 겹치지 않는다: 그쪽은 페이지 상태를 바꾸는 클릭이라 한 요청에만 쓴다.
  // 그 선택지를 보여 준 카드(callId → 도구·범위)만 받아들인다.
  private chatGrants = new Map<ChatGrantTool, string>();
  // 이 대화에서 사용자가 작업을 맡겼는지(#123, 실행 방식 task). 새 대화·다른 실행 방식·패널의 해제로 풀린다.
  // 저장소에 남기지 않으므로 패널을 닫거나 서비스 워커가 다시 뜨면(새 대화 객체) 다시 묻는다.
  private taskApproved = false;
  // 맡긴 작업을 거둘 때(다른 실행 방식·해제·새 대화)마다 올린다. 열려 있던 맡기기 카드의 승인은 세대가 같을 때만 받는다.
  private taskEpoch = 0;
  // 열려 있는 맡기기 카드의 callId(거둘 때 취소한다).
  private pendingTaskCall: string | null = null;
  // 이번 요청에서 사용자가 보낸 글(작업 맡기기 카드에 원문으로 보인다).
  private turnRequest = "";
  // 이 턴에 remember_page로 저장 카드를 띄운 주소(턴 끝 자동 제안이 같은 주소면 띄우지 않는다).
  private rememberedUrls: { turn: number; urls: Set<string> } = { turn: -1, urls: new Set() };
  // 대화별 기준 갱신(#233). pending: 기록에 넣은 도구 결과(바뀐 행 글자를 보여 줌)가 낸 기준 — 그 결과를 실은 모델 요청의 응답이
  // 아직 오지 않았다. confirmed: 응답이 와(모델이 그 결과를 보고 응답함) 이 대화의 대상 확인에 넘기는 기준(대상 id → nonce들).
  // 같은 응답의 뒤 호출은 그 응답보다 늦게 난 결과를 볼 수 없으므로 pending을 쓰지 못한다. 기록을 비우면 함께 비운다.
  private rebasePending: RebaseOffer[] = [];
  private rebaseConfirmed = new Map<string, string[]>();
  // 승인 카드에서 "이 주소는 이번 대화에서 다시 묻지 않기"로 허용한 주소의 열쇠(personalUrlKey — 주소 글자 그대로,
  // 양식 제출 주소는 그 action).
  // 클릭·입력의 자동 실행 판정에서 이 주소들의 개인정보 주소 신호만 면제한다(사이트 경계·다른 신호는 그대로).
  // 대화 객체 메모리에만 두고 저장하지 않는다. 그 선택지를 보여 준 카드(callId → 턴·주소)만 받아들인다.
  private allowedPersonalUrls = new Set<string>();
  private personalUrlOffers = new Map<string, { turn: number; keys: string[] }>();
  private chatGrantOffers = new Map<string, { tool: ChatGrantTool; scope: string }>();
  // 자동 로그인(sign_in): 카드가 제안한 출처(호출별), 사용자가 그 제안을 고른 호출, 이 대화에서 이미 시도한 출처·단계
  // (다시 자동으로 하지 않는다), 페이지가 넣은 값을 다시 보여 가린 적이 있는지(그러면 이 대화에서는 자동 로그인하지 않는다).
  private loginSiteOffers = new Map<string, string>();
  // 카드를 띄운 sign_in 호출의 준비 열쇠(signIn.ts의 token).
  private signInTokens = new Map<string, string>();
  private rememberLogin = new Set<string>();
  private loginAttempts = new Set<string>();
  private secretsMasked = false;
  // 외부 본문 보호: 파일·Google 문서·PDF처럼 외부 유래 데이터가 이 대화의 모델 문맥에 들어오면 켠다(새 대화까지).
  // 켜진 동안은 관측 전용 도구(TOOL_POLICY.observeOnly) 밖의 모든 도구를 자동 실행·링크 허락 없이 승인 카드로 묻는다
  // (외부 내용을 신뢰 사이트의 검색어·입력값·번역 언어·Google 검색어 등으로 내보내지 않게).
  private externalContent = false;
  private lastAttachedPdfUrl: string | null = null;
  // 문맥을 서명하는 제공자(Anthropic)에서 이 대화 기록에 남긴 저장 링크 후보(마지막 글자와 지금까지 보낸 id). 기록에서 거둘 수
  // 없으니, 그중 하나를 지웠거나 기능을 껐으면 다음 요청을 새 대화로 시작한다(forceNewConversation).
  private committedCandidates: { text: string; ids: Set<string> } | null = null;
  // 이 턴의 빠르게 생각 설정(턴 시작에 고정, #160).
  private turnQuick = false;
  // 저장한 링크 후보를 로그에 남긴 턴(턴마다 한 번).
  private candidatesLoggedTurn = -1;
  private forceNewConversation = false;
  private turnTab: TurnTab = { error: "활성 탭을 찾을 수 없습니다." };
  // 이 대화에서 translate_page를 실행한 탭. 중단·새 대화·패널 종료 시 번역을 멈춘다.
  private translatedTabs = new Set<number>();
  // 실제 입력 클릭(0.2.0)의 디버거 상태. 턴이 끝나면 떼고, 새 대화면 새로 만든다(디버깅 취소 선택도 그때 풀린다).
  private inputSession = new InputSession();

  // channel: 이 대화가 어디서 왔는지. telegram(#139)이면 원격 요청이다 — 생성할 때만 정해지고 설정·메시지 글자로 바뀌지 않는다.
  // 원격 대화는 전역 실행 방식과 관계없이 '묻지 않고 실행'의 판정 규칙을 쓰되, 승인 카드가 필요한 동작은 하지 않는다
  // (카드를 보내지 않고 거절한 뒤 도구 없이 답을 마무리한다). 작업 맡기기·자동 로그인·저장 링크 열기도 쓰지 않는다.
  private readonly channel: AgentChannel;
  // 원격 대화에서 카드가 필요해 거절한 호출이 있었던 턴(그 턴은 도구 없이 마무리한다).
  private remoteRefusedTurn = -1;
  // 그 턴을 마무리하는 이유(원격 질문의 결과에 따라 마무리 지침이 다르다, #185).
  private remoteStopReason: Exclude<RemoteAskResult, "approved" | "aborted"> = "unavailable";
  // 이번 턴의 원격 승인자와, 기다리는 원격 질문의 중단(턴이 끝나면 바로 푼다).
  private turnApprover: RemoteApprover | null = null;
  private remoteAskAbort: AbortController | null = null;
  // 이번 턴에 패널로 보낼 오류(원격 대화의 결과 판정).
  private turnErrors: Array<{ action?: "settings" | "usage" }> = [];
  // 이번 요청의 사용자 메시지를 기록에 넣었으면 그 턴과 위치. 넣기 전에 실패했으면 이전 요청의 답을 이번 답으로 보지 않는다.
  private turnStart: { turn: number; index: number } | null = null;
  // 진행 중인 sendUserTurn 수(#243 idle 판정).
  private runningTurns = 0;

  constructor(
    private port: AgentSink,
    opts: { channel?: AgentChannel } = {},
  ) {
    this.channel = opts.channel ?? "panel";
  }

  private get remote(): boolean {
    return this.channel !== "panel";
  }

  // 원격 대화는 전역 설정과 관계없다. 텔레그램에서 이번 요청의 승인을 버튼으로 물을 수 있으면 '처음에 승인 받고 끝까지 실행'
  // (요청마다 한 번 맡길지 묻는다), 그 밖(MCP, 묻기 꺼짐·연결 끊김)은 auto 판정 규칙(카드가 필요한 것은 원격으로 묻거나 거절).
  // 호출마다 다시 계산하므로 요청 중에 묻기를 끄면 다음 호출부터 auto가 되고 맡긴 작업이 풀린다.
  private effectiveRunMode(stored: RunMode): RunMode {
    if (!this.remote) return stored;
    return this.remoteTaskMode() ? "task" : "auto";
  }

  private remoteTaskMode(): boolean {
    return this.channel === "telegram" && !!this.turnApprover?.canAsk();
  }

  // 설정이 바뀌었을 때(저장소 변경). 이 대화가 쓰던 제공자·키·모델과 달라지면 이 대화가 연 페이지 번역(남은 배치·동적
  // 재번역)을 멈춘다 — 한 번역이 두 제공자에 걸치지 않게(#108 후속, #99). 대화 기록은 다음 요청에서 새로 시작한다.
  onSettingsChanged(next: Settings): void {
    // 다른 실행 방식으로 바꾸는 즉시 맡긴 작업과 열린 맡기기 카드를 거둔다(다시 task로 돌아와도 새로 묻는다, #123).
    if (this.effectiveRunMode(next.runMode) !== "task") this.withdrawTask();
    if (this.apiKey === null) return;
    // 보낼 대상(제공자·키·모델·로컬 서버 주소)이 바뀌면 번역을 멈추고, 진행 중인 모델 요청도 멈춘다(#193 — 그 턴은 더 보내지 않는다).
    if (targetKey(activeModel(next)) !== this.conversationTarget()) {
      this.stopTranslations();
      // 모델 요청 중이든 승인 카드·도구를 기다리는 중이든 지금 턴에 표시를 남긴다(그 턴은 다시 A로 돌아와도 더 보내지 않음, #193 리뷰).
      // 끝난 턴에 남아도 다음 턴은 번호가 바뀌어 영향이 없다.
      this.targetChangedTurn = this.currentTurn;
      this.activeRequest?.abort();
    }
  }

  // 이 대화가 고정한 대상(ensureCredentials가 정함).
  private conversationTarget(): string {
    return targetKey({ provider: this.provider, apiKey: this.apiKey ?? "", model: this.model ?? "", baseUrl: this.baseUrl });
  }

  private conversationAuth(): { apiKey: string; baseUrl?: string } {
    return { apiKey: this.apiKey ?? "", ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}) };
  }

  // 진행 중인 턴·승인 대기·모델 요청·도구가 없는지(#243 — 끊길 때 기록을 보관할지).
  idle(): boolean {
    return this.runningTurns === 0 && this.pendingApprovals.size === 0 && !this.activeRequest && !this.activeTool;
  }

  // 패널 연결이 끊겨 기록만 잠깐 보관할 때(#243). 진행 중인 것을 멈추고(디버거도 뗌), 허용을 넓히는 상태는 모두 지운다 —
  // 대화 허락·맡긴 작업·이동 허락 사이트·링크 허락·개인정보 주소 허락·자동 로그인 선택·행 기준(#233). 남기는 것: 기록, 더 묻게
  // 만드는 보호 상태(외부 본문 보호·로그인 값 가림·자동 로그인 시도), 기록 형식 상태(제공자·모델·지침·저장 링크 후보·호출 키),
  // 사용량 누계, 디버거 세션(사용자의 디버깅 취소 선택 canceledByUser를 지키려고 — 연결은 abort가 뗀다).
  // 새 상태를 더하면 reset()과 이 함수 중 어느 쪽에서 지울지 정할 것(넓히는 상태면 여기서도 지운다).
  suspendForReconnect(): void {
    this.abort();
    this.chatGrants.clear();
    this.chatGrantOffers.clear();
    this.withdrawTask();
    this.pendingTaskCall = null;
    this.approvedSites.clear();
    this.linkGrant = null;
    this.linkGrantOffers.clear();
    this.allowedPersonalUrls.clear();
    this.personalUrlOffers.clear();
    this.rememberLogin.clear();
    this.loginSiteOffers.clear();
    this.signInTokens.clear();
    this.clearRebases();
  }

  // 보관했던 대화를 새 패널 연결에 붙인다(#243). 패널 표시(허락·맡긴 작업)를 지운 상태와 맞춘다.
  attachPort(port: AgentSink): void {
    this.port = port;
    this.sendChatGrants();
    this.sendTaskState();
  }

  // 하네스용(#243): 사용자가 디버깅 막대를 취소한 것과 같은 상태로 만든다 / 읽는다.
  markInputCanceledForHarness(): void {
    this.inputSession.canceledByUser = true;
  }

  inputCanceled(): boolean {
    return this.inputSession.canceledByUser;
  }

  abort(): void {
    this.currentTurn += 1;
    this.cancelInFlight();
    this.stopTranslations();
    void detachSession(this.inputSession);
  }

  private cancelInFlight(): void {
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.activeTool?.abort();
    this.activeTool = null;
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    this.remoteAskAbort?.abort();
    this.remoteAskAbort = null;
    this.linkGrantOffers.clear();
    this.chatGrantOffers.clear();
    this.personalUrlOffers.clear();
  }

  private isStale(turn: number): boolean {
    return turn !== this.currentTurn;
  }

  // 도구 결과를 기록에 넣은 직후 그 호출이 낸 대화별 기준을 받는다(#233). 기록에 넣지 않은 호출의 것은 받지 않는다.
  private noteRebases(callId: string): void {
    this.rebasePending.push(...takeRebaseOffers(callId));
  }

  private clearRebases(): void {
    this.rebasePending = [];
    this.rebaseConfirmed = new Map();
  }

  // 백그라운드 번역 배치와 동적 재번역 옵저버를 멈춘다. 멈추지 않으면 사용자가
  // 대화를 끝낸 뒤에도 페이지 변화(예: 메일함 갱신)마다 번역 요청이 계속 나간다.
  private stopTranslations(): void {
    for (const id of this.translationSessions.values()) endTranslationSession(id);
    this.translationSessions.clear();
    for (const tabId of this.translatedTabs) {
      chrome.tabs.sendMessage(tabId, { kind: "translate_stop" }).catch(() => {
        /* 탭이 닫혔거나 이동함 — 멈출 대상이 없음 */
      });
      debugLog("translate:stop", `tab ${tabId}`);
    }
    this.translatedTabs.clear();
  }

  approveTool(
    callId: string,
    allowLinksThisTurn = false,
    choiceIds?: string[],
    allowToolThisChat = false,
    allowUrlsThisChat = false,
    rememberLoginSite = false,
  ): void {
    // 선택 카드의 선택은 백그라운드가 고정한 후보의 부분집합만 남긴다(otherTabs.setChosen).
    if (choiceIds && this.pendingApprovals.has(callId)) {
      setChosenTabs(callId, choiceIds);
      setChosenLinks(callId, choiceIds);
      setChosenDownloads(callId, choiceIds);
      const token = this.signInTokens.get(callId);
      if (token) chooseSignInEntry(token, choiceIds);
    }
    if (rememberLoginSite && this.pendingApprovals.has(callId) && this.loginSiteOffers.has(callId)) {
      this.rememberLogin.add(callId);
    }
    const offer = this.linkGrantOffers.get(callId);
    if (allowLinksThisTurn && this.pendingApprovals.has(callId) && offer?.turn === this.currentTurn) {
      this.linkGrant = offer;
      debugLog("tool:link_grant", `turn ${offer.turn}`);
    }
    const urlOffer = this.personalUrlOffers.get(callId);
    if (allowUrlsThisChat && this.pendingApprovals.has(callId) && urlOffer?.turn === this.currentTurn) {
      for (const k of urlOffer.keys) this.allowedPersonalUrls.add(k);
      debugLog("tool:url_allow", `${urlOffer.keys.length}개 주소`);
    }
    const chatOffer = this.chatGrantOffers.get(callId);
    if (allowToolThisChat && this.pendingApprovals.has(callId) && chatOffer) {
      this.chatGrants.set(chatOffer.tool, chatOffer.scope);
      debugLog("tool:chat_grant", `${chatOffer.tool}${chatOffer.scope ? ` · ${chatOffer.scope}` : ""}`);
      this.sendChatGrants();
    }
    this.pendingApprovals.get(callId)?.(true);
  }

  cancelTool(callId: string): void {
    this.pendingApprovals.get(callId)?.(false);
  }

  // 패널에서 허락을 취소한다. 다음 호출부터 다시 카드로 묻는다.
  revokeChatGrant(tool: string): void {
    if (!isChatGrantTool(tool) || !this.chatGrants.delete(tool)) return;
    debugLog("tool:chat_grant_revoked", tool);
    this.sendChatGrants();
  }

  private sendChatGrants(): void {
    this.send({ kind: "chat_grants", grants: [...this.chatGrants].map(([tool, scope]) => ({ tool, scope })) });
  }

  // 패널에서 맡긴 작업을 거둔다(#123). 다음 동작부터 다시 맡길지 묻는다.
  revokeTask(): void {
    this.withdrawTask();
  }

  // 맡긴 작업을 거둔다: 세대를 올리고, 열린 맡기기 카드는 취소로 끝낸다.
  private withdrawTask(): void {
    this.taskEpoch += 1;
    if (this.pendingTaskCall) this.pendingApprovals.get(this.pendingTaskCall)?.(false);
    this.setTaskApproved(false);
  }

  private setTaskApproved(v: boolean): void {
    if (this.taskApproved === v) return;
    this.taskApproved = v;
    debugLog(v ? "task:approved" : "task:cleared");
    this.sendTaskState();
  }

  private sendTaskState(): void {
    this.send({ kind: "task_state", active: this.taskApproved });
  }

  reset(): void {
    this.history = [];
    this.clearRebases();
    this.conversationUsage = emptyUsageTotal();
    this.lastAttachedPdfUrl = null;
    this.committedCandidates = null;
    this.forceNewConversation = false;
    this.approvedSites.clear();
    this.linkGrant = null;
    this.chatGrants.clear();
    this.allowedPersonalUrls.clear();
    this.taskApproved = false;
    this.taskEpoch += 1;
    this.externalContent = false;
    void detachSession(this.inputSession);
    this.inputSession = new InputSession();
  }

  // 도구 결과 메시지 내용. 팝업 창이 닫혀 원래 탭으로 돌아간 것처럼 도구가 동작하는 탭이 바뀌었으면 그 안내(tab)를
  // 함께 싣는다(한 번만).
  private toolContent(turnTab: TurnTab, payload: Record<string, unknown>): string {
    const note = takeTabNote(turnTab);
    if (note) debugLog("popup:note", note);
    // 자동 로그인으로 넣은 값이 페이지 글자로 다시 보이면 기록에 넣기 전에 가린다(탭을 닫아 가림 목록이 지워져도 기록에 원문이
    // 남지 않게). 가렸으면 그렇다고 알리고 이 대화에서는 자동 로그인을 하지 않는다.
    // 직렬화하기 전의 값으로 가린다(JSON 이스케이프로 모양이 바뀐 값을 놓치지 않게).
    const full = note ? { ...payload, tab: note } : payload;
    const masked = maskSyncDeep(full);
    if (!masked.masked) return JSON.stringify(full);
    this.secretsMasked = true;
    debugLog("login:masked", "도구 결과에서 넣은 로그인 값을 가림", "warn");
    return JSON.stringify({
      ...masked.value,
      masked: "페이지가 도우미가 넣은 로그인 정보를 화면에 다시 보여 주어 그 부분을 가렸습니다.",
    });
  }

  private send(msg: BgToPanel): void {
    if (msg.kind === "error") this.turnErrors.push({ action: msg.action });
    // 원격 대화: 승인 카드·한도 카드를 보내지 않고 거절로 푼다. 모든 대기 지점은 카드를 보낸 직후 같은 흐름에서 대기를 등록하므로
    // 다음 차례(setTimeout)에 풀면 그 대기가 거절을 받는다.
    if (this.remote && (msg.kind === "tool_pending" || msg.kind === "hop_limit")) {
      const callId = msg.callId;
      const turn = this.currentTurn;
      if (msg.kind === "tool_pending") {
        this.remoteRefusedTurn = turn;
        this.remoteStopReason = "unavailable";
      }
      debugLog("remote:refuse", msg.kind === "tool_pending" ? msg.toolName : "hop_limit");
      setTimeout(() => this.pendingApprovals.get(callId)?.(false), 0);
      return;
    }
    try {
      this.port.postMessage(msg);
    } catch {
      // port closed
    }
  }

  private async ensureCredentials(): Promise<{
    apiKey: string;
    model: ModelId;
    systemPrompt: string;
  }> {
    const settings = await getSettings();
    const active = activeModel(settings);
    if (!active.ready) {
      throw new MissingKeyError(
        active.missing === "key"
          ? `${providerAdapter(active.provider).label} API 키가 설정되지 않았습니다. 설정에서 키를 입력해 주세요.`
          : "로컬 서버 주소와 모델이 설정되지 않았습니다. 설정에서 넣어 주세요.",
        active.missing ?? "key",
      );
    }
    if (
      this.forceNewConversation ||
      this.apiKey === null ||
      this.conversationTarget() !== targetKey(active) ||
      this.customSystemPrompt !== settings.systemPrompt ||
      this.conversationQuick !== settings.quickThinking
    ) {
      this.provider = active.provider;
      this.apiKey = active.apiKey;
      this.model = active.model;
      this.baseUrl = active.provider === "local" ? active.baseUrl : undefined;
      this.customSystemPrompt = settings.systemPrompt;
      this.conversationQuick = settings.quickThinking;
      this.history = [];
      this.clearRebases();
      this.conversationUsage = emptyUsageTotal();
      // 첨부한 PDF는 지운 기록에 있었다. 새 기록(새 제공자)에는 다시 첨부해야 한다.
      this.lastAttachedPdfUrl = null;
      this.committedCandidates = null;
      this.forceNewConversation = false;
      // 새 기록은 새 대화다: 맡긴 작업도 다시 묻는다.
      this.withdrawTask();
    }
    // 빠르게 생각(#160)은 턴 시작에 한 번 읽어 그 턴 동안 고정한다(지침과 추론 강도가 어긋나지 않게).
    this.turnQuick = settings.quickThinking;
    return {
      apiKey: active.apiKey,
      model: active.model,
      systemPrompt: composeSystemPrompt(settings.systemPrompt, { quickThinking: settings.quickThinking }),
    };
  }

  // 손 넘기기(클릭) 동안 지금 도구 탭이 여는 새 탭·창을 지켜본다(#81). settle(clickedAt): 사용자가 대상을 누른 즈음
  // (clickedAt 앞 HANDOFF_POPUP_LEAD_MS부터) 열린 창만 클릭과 같은 규칙(settlePopups)으로 따라가고 안내 문구를 돌려준다.
  // 손 넘기기는 window.open을 감싸지 않으므로(오래 기다림) 따로 뜬 팝업 창만 따라간다 — 같은 창의 탭으로 열린 것은 그
  // 기록이 없어 따라가지 않는다.
  private async watchHandoffPopups(
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

  // 응답이 앞 문맥까지 서명하는 제공자(Anthropic)면 그 요청에 붙였던 임시 안내를 응답 앞에 기록으로 남긴다 — 다음 요청의
  // 앞 문맥이 서명 때와 같게(기록을 덧붙이기만 한다). 다른 제공자는 지금처럼 요청마다 새로 붙인다.
  private commitNotes(reply: ModelReply): void {
    if (!providerAdapter(this.provider).signsContext) return;
    this.history.push(...reply.sentNotes);
    if (reply.sentCandidates) {
      const ids = new Set(this.committedCandidates?.ids ?? []);
      for (const id of candidateIdsOf(reply.sentCandidates)) ids.add(id);
      this.committedCandidates = { text: reply.sentCandidates, ids };
    }
  }

  private async maybeShowPdfGuidance(): Promise<void> {
    const flags = await readFlags();
    if (flags.pdfGuidanceShown) return;
    this.send({
      kind: "info",
      title: "PDF 문서 분석 안내",
      message: [
        "처음 PDF 탭을 분석합니다. 몇 가지 제한을 참고해 주세요:",
        "",
        "• 파일 크기: 20MB까지만 지원됩니다. 더 큰 파일은 에러로 떨어집니다.",
        "• Chrome 기본 PDF 뷰어로 열린 http(s) PDF만 지원됩니다.",
        "  정상 예: https://www.emerald.com/jdqs/article-pdf/28/2/3/1394459/jdqs-03-2020-0004.pdf",
        "  Adobe Acrobat 같은 다른 PDF 뷰어 확장이 활성화돼 있으면 주소창 URL이 chrome-extension://... 으로 바뀌어 읽지 못합니다. 이 경우 해당 뷰어 확장을 일시 비활성화하고 Chrome 기본 뷰어로 열어 주세요.",
        "• 로컬 파일(file:// URL)은 지원되지 않습니다. Chrome 서비스 워커가 file:// 리소스를 가져올 수 없기 때문이며, 확장 설정의 '파일 URL 액세스' 옵션도 이 제약을 풀지 못합니다. 대안: 공개 http(s) URL로 열거나, 본문 텍스트를 채팅창에 직접 붙여넣어 주세요.",
        "• 로그인·쿠키로 보호된 PDF는 쿠키가 함께 전송되지만, CORS 정책으로 서버가 확장의 접근을 거부할 수 있습니다.",
        "",
        "이 안내는 처음 한 번만 표시됩니다.",
      ].join("\n"),
    });
    await setFlag("pdfGuidanceShown", true);
  }

  // 외부 유래 데이터를 모델 문맥에 넣는 모든 곳이 부르는 공통 관문.
  private noteExternalContent(reason: string): void {
    if (this.externalContent) return;
    this.externalContent = true;
    debugLog("guard:external_content", reason);
    this.send({
      kind: "info",
      title: "외부 문서 내용을 읽은 대화",
      // 실행 방식 셋 모두에 맞는 문구(#129): 맡기기 방식으로 작업을 맡긴 동안은 이 보호도 묻지 않는다(#123 사용자 결정).
      message: `${reason} 이 대화에서는 페이지 관측 외의 모든 동작(이동·클릭·입력·번역·Google 도구 등)을 실행 방식과 관계없이 매번 확인받습니다. 다만 '처음에 승인 받고 끝까지 실행'으로 작업을 맡긴 동안에는 묻지 않습니다. 새 대화를 시작하면 이 보호가 풀립니다.`,
    });
  }

  // 제안 턴(expect)의 대상이 그대로인지: 따라가는 탭이 그 탭이고, 지금 문서·주소가 확인한 것과 같다.
  private async expectHolds(turnTab: TurnTab, expect: TurnExpect): Promise<boolean> {
    if (!("tabId" in turnTab) || turnTab.tabId !== expect.tabId) return false;
    try {
      const url = (await chrome.tabs.get(expect.tabId)).url ?? "";
      return url === expect.url && (await topDocumentId(expect.tabId)) === expect.documentId;
    } catch {
      return false;
    }
  }

  // keepalive: 턴의 try 밖에서 부를 때 true(그 안에서는 finally가 끝낸다).
  private expectFailed(turn: number, endTurn: (outcome: string) => void, keepalive = true): void {
    if (keepalive) endKeepalive();
    if (this.isStale(turn)) {
      endTurn("aborted");
      return;
    }
    debugLog("turn:suggestion_changed", "제안을 확인한 뒤 페이지가 바뀜", "warn");
    this.send({ kind: "error", message: "페이지가 바뀌어 제안을 실행하지 않았습니다. 지금 페이지를 확인한 뒤 다시 요청하세요." });
    this.send({ kind: "assistant_done" });
    endTurn("fail");
  }

  // attached.pdfUrl: 이번에 PDF 파일을 붙였으면 그 주소(부르는 쪽이 기록에 넣을 때 lastAttachedPdfUrl로 확정한다).
  private async buildUserContent(
    userText: string,
    expect?: TurnExpect,
    attached: { pdfUrl: string | null } = { pdfUrl: null },
  ): Promise<string | OpenRouterContentPart[] | typeof EXPECT_MISMATCH> {
    const pdfTabId = await requestTabId(() => this.turnTab);
    // 제안 턴: 따라가는 탭이 확인한 탭이어야 한다(팝업을 잇지 않으므로 같아야 정상).
    if (expect && pdfTabId !== expect.tabId) return EXPECT_MISMATCH;
    const pdfInfo = pdfTabId !== null ? await detectPdfAtTab(pdfTabId) : null;
    // 제안 턴: PDF를 받기 전에 확인한 주소·문서인지 본다(다른 페이지의 파일을 받지 않게).
    if (expect && (pdfInfo?.url !== expect.url || (await topDocumentId(expect.tabId)) !== expect.documentId)) return EXPECT_MISMATCH;

    if (pdfInfo?.isPdf) {
      // PDF 본문(또는 주소·파일 이름이 실릴 수 있는 자동 로드 실패 안내)이 문맥에 들어간다.
      this.noteExternalContent("PDF 문서를 대화에 붙였습니다.");
      await this.maybeShowPdfGuidance();
      // 파일 첨부를 받지 않는 제공자(Gemini 호환 엔드포인트)면 첨부하지 않고 read_document로 읽게 한다.
      // 자동 로그인으로 넣은 값이 있으면(이 브라우저 세션) 원본 파일은 가릴 수 없으므로 첨부하지 않고, 가리기를 거치는 read_document로 읽게 한다.
      if ((await allSecrets()).length > 0) {
        return `[현재 탭: PDF 문서 — ${pdfInfo.url}]\n이 PDF 내용이 필요하면 read_document로 위 주소를 읽어 답한다(페이지 조작 도구는 쓸 수 없다).\n\n[사용자 요청]\n${userText}`;
      }
      if (!providerAdapter(this.provider).supportsFileParts) {
        return `[현재 탭: PDF 문서 — ${pdfInfo.url}]\n지금 모델 제공자는 PDF 첨부를 받지 않는다. 이 PDF 내용이 필요하면 read_document로 위 주소를 읽어 답한다(페이지 조작 도구는 쓸 수 없다).\n\n[사용자 요청]\n${userText}`;
      }
      const alreadyAttached = pdfInfo.url === this.lastAttachedPdfUrl;
      if (alreadyAttached) {
        debugLog("pdf:already_attached", pdfInfo.url);
        return `[현재 탭: 첨부된 PDF — ${pdfInfo.url}]\n\n[사용자 요청]\n${userText}`;
      }
      debugLog("pdf:fetch", pdfInfo.url);
      this.send({ kind: "status", text: "PDF 문서 불러오는 중…" });
      const endFetch = timeSpan("pdf:fetch");
      try {
        const { data, bytes } = await fetchPdfAsBase64(pdfInfo.url);
        endFetch(`${Math.round(bytes / 1024)}KB`);
        // 첨부했다고 치는 것은 기록에 넣을 때(runUserTurn)다 — 그 전에 멈추면 다음에 다시 붙인다.
        attached.pdfUrl = pdfInfo.url;
        // 파일 자체가 모델 제공자로 가는 순간을 알린다(#129).
        this.send({
          kind: "info",
          title: "PDF 파일을 보냅니다",
          message: `이 탭의 PDF 파일(${Math.round(bytes / 1024)}KB)을 설정에서 고른 모델 제공자(${providerAdapter(this.provider).label})에 보내 읽습니다.`,
        });
        return [
          {
            type: "text",
            text: `[현재 탭: PDF 문서 — ${pdfInfo.url}]\n이 대화에서는 페이지 조작 도구(translate_page, find_clickables 등)는 사용할 수 없고, 첨부된 PDF 내용을 직접 읽고 답한다.\n\n[사용자 요청]\n${userText}`,
          },
          {
            type: "file",
            file: {
              filename: "current-tab.pdf",
              file_data: `data:application/pdf;base64,${data}`,
            },
          },
        ];
      } catch (err) {
        endFetch("fail");
        const msg = err instanceof Error ? err.message : String(err);
        debugLog("pdf:error", msg, "warn");
        return `[현재 탭: PDF ${pdfInfo.url} — 자동 로드 실패: ${msg}]\n\n[사용자 요청]\n${userText}`;
      }
    }

    // Normal web page
    const header = await fetchTabHeader(() => this.turnTab);
    const composed = header ? `${header}\n\n[사용자 요청]\n${userText}` : userText;
    return composed;
  }

  // 요청 하나를 처리하고 결과를 돌려준다(원격 채널이 최종 답만 보내는 데 쓴다, #139). finalText: 이번 요청에 들어간 기록 중
  // 도구 호출이 없는 마지막 답. aborted: 중단·새 요청에 밀림. error: 오류로 끝남(action은 다음 행동의 종류).
  async sendUserTurn(userText: string, opts: TurnOpts = {}): Promise<TurnOutcome> {
    this.turnErrors = [];
    this.runningTurns += 1;
    const running = this.runUserTurn(userText, opts);
    // runUserTurn은 첫 await 전에 턴 번호를 올린다.
    const turn = this.currentTurn;
    try {
      await running;
    } finally {
      this.runningTurns -= 1;
    }
    if (this.isStale(turn)) return { outcome: "aborted", finalText: "" };
    const finalText = this.turnStart?.turn === turn ? answerSince(this.history, this.turnStart.index) : "";
    if (finalText) return { outcome: "ok", finalText };
    const err = this.turnErrors[0];
    return err ? { outcome: "error", finalText: "", action: err.action } : { outcome: "ok", finalText: "" };
  }

  // tabId: 반복 작업의 "이어서 진행"(#138)처럼 백그라운드가 정한 탭에서 시작할 때. 없으면 지금 활성 탭.
  // site: 이 요청의 자동 실행 기준 사이트를 탭 주소 대신 이 출처로 고정한다(반복 작업의 이어서 진행 — 등록한 사이트).
  // expect: 페이지 제안(#173)의 실행 — 확인한 탭의 문서·주소에서만 시작한다(앞 턴의 팝업을 잇지 않고, 문맥을 읽기 전후로
  // 다시 확인해 바뀌었으면 기록·모델 요청 없이 끝낸다).
  private async runUserTurn(userText: string, opts: TurnOpts = {}): Promise<void> {
    // 이전 턴이 아직 돌고 있으면 끊는다. 백그라운드 번역은 대화가 이어지는 동안 유지한다.
    this.cancelInFlight();
    const turn = ++this.currentTurn;
    this.turnApprover = this.remote ? (opts.approver ?? null) : null;
    // 원격 대화의 작업 맡기기는 요청 하나 동안만(사용자가 진행을 보고 있지 않으므로 같은 대화의 다음 요청은 다시 묻는다).
    if (this.remote) this.withdrawTask();
    beginKeepalive();
    const endSpan = timeSpan("turn");
    // 이 턴의 사용량 합계(#126)는 턴이 끝날 때 한 번 남긴다(그 사이 새 턴이 시작해도 이 턴의 것은 이 턴이 남긴다).
    this.turnUsage.set(turn, { total: emptyUsageTotal(), conversation: null, start: Date.now() });
    const endTurn = (extra?: string) => {
      const u = this.turnUsage.get(turn);
      this.turnUsage.delete(turn);
      if (u && u.total.calls > 0) debugLog("turn:usage", formatTurnUsage(u.total, Date.now() - u.start, u.conversation ?? this.conversationUsage));
      endSpan(extra);
    };
    const prevTurnTab = this.turnTab;
    this.turnTab = opts.tabId !== undefined ? await turnTabOf(opts.tabId) : await captureTurnTab();
    clearOfferedHints(this.turnTab);
    // 기록에 넣을 때 쓰는 가림 목록을 미리 읽어 둔다(서비스 워커가 다시 시작된 뒤 첫 결과도 가리게). 읽지 못하면 이 요청을
    // 보내지 않는다(가릴 값을 모른 채 페이지 글자를 보내지 않게).
    try {
      await warmSecrets();
    } catch (err) {
      this.send({ kind: "error", message: `자동 로그인 가림 목록을 읽지 못해 요청을 보내지 않았습니다(${err instanceof Error ? err.message : String(err)}). 다시 시도해 주세요.` });
      this.send({ kind: "assistant_done" });
      endTurn("fail");
      endKeepalive();
      return;
    }
    // 다음 턴이 this.turnTab을 바꿔도 이 턴의 읽기 관찰을 정리할 수 있게 붙잡아 둔다.
    const turnTab = this.turnTab;
    // 앞 턴에서 우리 클릭으로 열려 따라가던 팝업 창이 아직 열려 있으면 같은 탭에서 시작한 이번 턴도 그 창에서 이어 간다.
    if (!this.remote && !opts.expect && (await inheritPopups(prevTurnTab, turnTab))) debugLog("turn:popup", "앞 턴의 팝업 창을 이어 따라감");
    if ("tabId" in this.turnTab) {
      debugLog("turn:tab", `tab ${this.turnTab.tabId}${this.turnTab.internal ? " (내부 페이지)" : ""}`);
    } else {
      debugLog("turn:tab", `fail · ${this.turnTab.error}`, "warn");
    }
    // 탭 조회를 기다리는 사이 새 턴이 시작됐으면 그 턴의 신뢰 사이트를 덮어쓰지 않는다.
    let site: string | null = null;
    // 턴이 끝났을 때 다른 화면으로 옮겨 갔는지 보려고 시작 주소(해시 포함)를 기억한다.
    let startUrl: string | null = null;
    if ("tabId" in turnTab) {
      try {
        const url = (await chrome.tabs.get(turnTab.tabId)).url;
        startUrl = url ?? null;
        if (url) site = opts.site ?? siteOf(url);
      } catch {
        /* 탭을 못 읽으면 신뢰 사이트 없이 진행(이동은 카드로 묻는다) */
      }
    }
    if (opts.expect && !(await this.expectHolds(turnTab, opts.expect))) {
      this.expectFailed(turn, endTurn);
      return;
    }
    if (!this.isStale(turn)) {
      this.turnSite = site;
      this.turnNamedSites = userNamedSites(userText);
      this.turnRequest = userText;
      // 패널의 허락 표시를 이 대화 객체의 상태에 맞춘다(서비스 워커가 다시 떠 새 대화 객체면 빈 목록).
      this.sendChatGrants();
      this.sendTaskState();
    }
    try {
      const { apiKey, model, systemPrompt } = await this.ensureCredentials();
      debugLog("turn:model", model);

      // 원격 대화는 요청 앞에 원격 안내를 붙인다(요청 글의 주소 판정·카드의 요청 원문은 사용자가 보낸 글 그대로).
      const prevExternal = this.externalContent;
      const attached = { pdfUrl: null as string | null };
      const remoteSites = this.remote ? (await getSettings()).remoteSites : [];
      const userContent = await this.buildUserContent(this.remote ? `${remoteTurnNote(this.channel, userNamedSites(userText), !!this.turnApprover?.canAsk(), remoteSites)}\n\n요청: ${userText}` : userText, opts.expect, attached);
      if (this.isStale(turn)) {
        endTurn("aborted");
        return;
      }
      // 문맥을 다 읽은 뒤에도 같은 문서·주소여야 한다(아니면 기록·모델 요청 없이 끝낸다).
      if (userContent === EXPECT_MISMATCH || (opts.expect && !(await this.expectHolds(turnTab, opts.expect)))) {
        // 기록에 넣지 않으므로 PDF 첨부도 확정하지 않는다(다음에 같은 PDF면 다시 붙인다). 중단된 턴이면 새 턴의 상태를 건드리지 않는다.
        if (!this.isStale(turn)) {
          // 받은 PDF를 대화에 넣지 않았으니 외부 본문 보호도 되돌린다(이 턴이 켰을 때만).
          if (!prevExternal && this.externalContent) {
            this.externalContent = false;
            debugLog("guard:external_content", "제안 실행을 멈춰 PDF를 넣지 않음 — 보호 되돌림");
          }
        }
        commitReads(turnTab, false);
        // 끝내기(endKeepalive)는 아래 finally가 한다.
        this.expectFailed(turn, endTurn, false);
        return;
      }
      // 확인을 기다리는 사이 중단·새 요청이 있었으면 기록·첨부 상태를 바꾸지 않는다.
      if (this.isStale(turn)) {
        endTurn("aborted");
        return;
      }
      // 이제 기록에 넣는다 — 붙인 PDF를 첨부한 것으로 확정한다.
      if (attached.pdfUrl) this.lastAttachedPdfUrl = attached.pdfUrl;
      this.history.push(...closeDanglingToolCalls(this.history));
      // 사용자 글·탭 문맥(제목 등)도 기록에 넣기 전에 가린다(탭을 닫아 가림 목록이 지워진 뒤에도 원문이 남지 않게).
      const maskedUser = maskSyncMessages<OpenRouterMessage>([{ role: "user", content: userContent }]);
      if (maskedUser.masked) {
        this.secretsMasked = true;
        debugLog("login:masked", "사용자 요청 문맥에서 넣은 로그인 값을 가림", "warn");
      }
      this.history.push(maskedUser.value[0]);
      // 이번 요청의 사용자 메시지 위치(최종 답은 이 뒤에서만 찾는다).
      this.turnStart = { turn, index: this.history.length - 1 };

      const completed = await this.streamLoop(apiKey, model, systemPrompt, turn);
      // 읽기 레시피: 답을 마친 턴에서 통한 읽기 방법만 남긴다(중단·도구 호출 한도 초과는 버림).
      // 외부 본문 보호가 켜진 대화에서는 읽기 레시피를 저장하지 않고 이 턴의 관찰을 버린다(보호 대상에서 유래한
      // 모델 인자가 레시피로 남아 새 대화의 readHints로 다시 들어오지 않게).
      commitReads(turnTab, completed && !this.isStale(turn) && !this.externalContent);
      // 답을 마친 턴에서 탭이 다른 화면에 있으면 "이 페이지 기억하기"를 제안한다(시크릿·꺼짐·같은 주소는 제안 없음).
      if (completed && !this.isStale(turn) && "tabId" in turnTab) {
        const context = { query: userText, answer: lastAnswerText(this.history) };
        let offer: Awaited<ReturnType<typeof makeOffer>> = null;
        if (this.remote) offer = await makeOffer(turnTab.tabId, startUrl, context).catch(() => null);
        else {
          // 패널 카드는 이동을 마친 페이지로 만든다(#240 — 이동 직후 끝난 턴이 옛 주소를 읽어 같은 페이지로 보지 않게).
          // 다 뜬 문서·주소를 고정하고, 제안을 만드는 사이 바뀌면 만들지 않는다. 제때 뜨지 않으면 제안하지 않는다.
          const page = await loadedPage(turnTab.tabId);
          if (page && !this.isStale(turn)) {
            const res = await makeOfferResult(turnTab.tabId, startUrl, context, page.documentId, page.url).catch(() => null);
            offer = res && "offer" in res ? res.offer : null;
          }
        }
        const already = this.rememberedUrls.turn === turn && !!offer && this.rememberedUrls.urls.has(offer.url);
        if (offer && !already && !this.isStale(turn)) this.send({ kind: "page_save_offer", offer });
      }
      endTurn(this.isStale(turn) ? "aborted" : "ok");
    } catch (err) {
      commitReads(turnTab, false);
      if (this.isStale(turn)) {
        endTurn("aborted");
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("turn:error", msg, "error");
      endTurn("fail");
      this.send({ kind: "error", ...friendlyError(err), provider: this.provider });
    } finally {
      // 이 턴이 붙인 디버거를 뗀다. 새 턴에 밀렸으면 그 턴이 끝날 때 뗀다(같은 대화 상태를 쓰므로).
      if (!this.isStale(turn)) void detachSession(this.inputSession);
      endKeepalive();
    }
  }

  // 모델 호출 한 번의 사용량을 타임라인에 남기고 그 턴의 합계·대화 누계에 더한다(#126). 끝난 턴(합계를 이미 남김)이면 줄만 남긴다.
  private recordUsage(turn: number, usage: ModelUsage | null, ms: number, ended?: "중단" | "오류"): void {
    debugLog("model:usage", `${formatUsage(usage, ms)}${ended ? ` · ${ended}` : ""}`);
    const t = this.turnUsage.get(turn);
    if (!t) return;
    t.conversation ??= this.conversationUsage;
    addUsage(t.total, usage);
    addUsage(t.conversation, usage);
  }

  // 모델에 한 번 묻고 스트림을 끝까지 읽는다. 중단·새 턴에 밀렸으면 null.
  // wrapUpNote가 있으면 도구 없이 답만 받는 마무리 요청이다(한도에서 그만두기·헛돌기 감지, #55).
  private async requestModel(
    // 대화가 고정한 자격으로 보낸다(conversationAuth, #193). 호출하는 쪽의 형태를 유지하려고 받기만 한다.
    _apiKey: string,
    model: ModelId,
    systemPrompt: string,
    turn: number,
    opts: { lowReasoning?: boolean; wrapUpNote?: string },
  ): Promise<ModelReply | null> {
    // 로컬 서버는 모델을 처음 올릴 때 첫 응답이 느려 제한을 늘린다(#193).
    const CONNECT_TIMEOUT_MS = providerTimeout(this.provider, 20_000);
    const INACTIVITY_MS = providerTimeout(this.provider, 60_000);
    const controller = new AbortController();
    this.activeRequest = controller;
    // 설정에서 보낼 대상이 바뀌었는지(이 턴에서 멈춤 표시가 됐거나, 지금 설정의 대상이 이 대화의 대상과 다름).
    const targetMoved = (now: Parameters<typeof targetKey>[0]) => this.targetChangedTurn === turn || targetKey(now) !== this.conversationTarget();
    const stopForTarget = () => {
      clearTimeout(connectTimer);
      if (this.activeRequest === controller) this.activeRequest = null;
      this.targetChangedTurn = turn;
      return new Error(TARGET_CHANGED_NOTE);
    };
    // 이 호출의 걸린 시간·사용량(#126). 요청을 연 뒤 끝날 때(정상·오류·중단) 한 번 남긴다.
    let openedAt = 0;
    let connectTimedOut = false;
    const connectTimer = setTimeout(() => {
      connectTimedOut = true;
      controller.abort();
    }, CONNECT_TIMEOUT_MS);
    // 저장한 페이지 후보: 매 요청 직전에 새로 만들고 대화 기록(history)에는 넣지 않는다(지우기·끄기가 다음 요청부터 반영).
    // 마무리 요청(wrapUpNote)에는 붙이지 않는다(이동 후보가 필요 없음).
    // 지금 저장 링크 후보(마무리 요청에도 읽는다 — 기록에 남긴 후보가 지워졌는지 검사용). 실을지는 아래에서 정한다.
    // 후보를 붙였는지는 턴마다 첫 요청에서만 로그에 남긴다(#156).
    const logCandidates = this.candidatesLoggedTurn !== turn;
    this.candidatesLoggedTurn = turn;
    const currentCandidates = await candidatesMessage("tabId" in this.turnTab ? this.turnTab.tabId : null, logCandidates).catch(() => null);
    const savedCandidates = opts.wrapUpNote ? null : currentCandidates;
    if (this.isStale(turn)) {
      clearTimeout(connectTimer);
      return null;
    }
    // 턴 도중 설정에서 제공자·키·모델을 바꿨으면 이 턴의 내용을 새 설정으로도, 이전 제공자로도 보내지 않고 멈춘다
    // (고른 제공자로만 보낸다는 약속). 모든 준비(후보 조회 등)가 끝난 뒤, 요청을 열기 바로 앞에서 본다 — 이 확인과 요청
    // 사이에는 기다림이 없다. 다음 요청에서 새 설정으로 대화를 새로 시작한다.
    const now = activeModel(await getSettings());
    if (this.isStale(turn)) {
      clearTimeout(connectTimer);
      return null;
    }
    if (targetMoved(now)) throw stopForTarget();
    // 문맥을 서명하는 제공자: 기록에 남긴 후보를 지웠거나 껐으면 거둘 수 없으니 멈추고 새 대화로, 바뀌지 않았으면 다시 싣지 않는다.
    let candidatesNote = savedCandidates;
    // 그런 제공자(Anthropic)는 도구 결과 바로 뒤에 글자 안내를 붙이면 빈 응답으로 끝낼 수 있어, 도구 결과 다음 요청에는
    // 현재 시각·후보 안내를 붙이지 않는다(사용자 요청 직후 요청에만). 마무리 안내는 그대로 붙인다.
    const signs = providerAdapter(this.provider).signsContext;
    const afterToolResult = signs && this.history[this.history.length - 1]?.role === "tool";
    if (providerAdapter(this.provider).signsContext && this.committedCandidates) {
      const now = new Set(currentCandidates ? candidateIdsOf(currentCandidates) : []);
      if ([...this.committedCandidates.ids].some((id) => !now.has(id))) {
        clearTimeout(connectTimer);
        if (this.activeRequest === controller) this.activeRequest = null;
        this.forceNewConversation = true;
        throw new Error("저장 링크를 지우거나 꺼서 이 대화에 이미 보낸 후보를 거둘 수 없어 멈췄습니다. 다시 요청하면 새 대화로 시작합니다.");
      }
      if (savedCandidates === this.committedCandidates.text) candidatesNote = null;
    }
    const runMode = this.effectiveRunMode((await getSettings()).runMode);
    const taskNote = runMode === "task" && !this.taskApproved && !afterToolResult ? TASK_MODE_NOTE : null;
    const sentNotes: OpenRouterMessage[] = maskSyncMessages<OpenRouterMessage>([
      ...(afterToolResult ? [] : [{ role: "user" as const, content: nowNote() }]),
      ...(taskNote ? [{ role: "user" as const, content: taskNote }] : []),
      ...(candidatesNote && !afterToolResult ? [{ role: "user" as const, content: candidatesNote }] : []),
      ...(opts.wrapUpNote ? [{ role: "user" as const, content: opts.wrapUpNote }] : []),
      // 문맥을 서명하는 제공자는 이 안내를 기록에 남기므로 남기기 전에 가린다.
    ]).value;
    // 이 요청 기록에 실린 결과가 낸 대화별 기준(#233). 응답을 끝까지 받으면 확정한다(아래 return 앞).
    const sentRebases = [...this.rebasePending];
    // 자동 로그인으로 넣은 값은 어디서 왔든(기록·메모·안내) 모델로 보내지 않는다(기록에 넣을 때 이미 가렸고, 여기는 마지막 거르기).
    const outgoing = await maskMessagesForModel<OpenRouterMessage>([
      { role: "system", content: systemPrompt },
      ...this.history,
      // 현재 시각·저장 링크 후보·마무리 안내는 이 요청에만 붙인다(문맥을 서명하는 제공자는 응답과 함께 기록에 남김).
      ...sentNotes,
    ]);
    if (outgoing.masked) {
      this.secretsMasked = true;
      debugLog("login:masked", "모델 요청에서 넣은 로그인 값을 가림", "warn");
    }
    // 가림 처리 등을 기다리는 사이 대상이 바뀌었을 수 있다 — 모든 준비가 끝난 뒤 한 번 더 보고, 이 확인 다음 줄에서 바로 요청을 연다
    // (어댑터는 첫 await 전에 fetch를 시작한다, #193).
    const latest = activeModel(await getSettings());
    if (this.isStale(turn)) {
      clearTimeout(connectTimer);
      return null;
    }
    if (targetMoved(latest)) throw stopForTarget();
    let stream: ChatStream;
    try {
      openedAt = Date.now();
      stream = await providerAdapter(this.provider).openStream(
        this.conversationAuth(),
        {
          model,
          messages: outgoing.value,
          tools: availableTools().map((fn) => ({
            type: "function" as const,
            function: fn,
          })),
          // 기록에 도구 호출·결과가 있어 도구 정의는 그대로 보내고, 마무리 요청은 도구를 부르지 못하게 한다.
          toolChoice: opts.wrapUpNote ? "none" : "auto",
          parallelToolCalls: false,
          reasoning: opts.lowReasoning || this.turnQuick ? "agent_low" : "agent",
          maxTokens: AGENT_MAX_TOKENS,
        },
        controller.signal,
      );
    } catch (err) {
      // 연결 단계에서 실패한 호출도 한 번으로 센다(사용량은 모름).
      this.recordUsage(turn, null, Date.now() - openedAt, this.isStale(turn) ? "중단" : "오류");
      if (this.targetChangedTurn === turn && !this.isStale(turn)) throw new Error(TARGET_CHANGED_NOTE);
      if (connectTimedOut) {
        throw new Error(
          `${providerAdapter(this.provider).label} 연결이 ${Math.round(CONNECT_TIMEOUT_MS / 1000)}초 안에 열리지 않았습니다. 네트워크 상태나 API 키를 확인하고 다시 시도해 주세요.`,
        );
      }
      if (this.isStale(turn)) return null;
      throw err;
    } finally {
      clearTimeout(connectTimer);
    }

    debugLog("stream:connected");
    const reply = createReplyAccumulator({
      onText: (text) => this.send({ kind: "assistant_chunk", text }),
      onThought: (text) => this.send({ kind: "thought_chunk", text }),
    });
    try {
      await stream.read((chunk) => reply.onChunk(chunk), INACTIVITY_MS);
    } catch (err) {
      controller.abort();
      // 끊기기 전에 받은 사용량도 남긴다(요금은 이미 나갔다).
      this.recordUsage(turn, reply.usage(), Date.now() - openedAt, this.isStale(turn) ? "중단" : "오류");
      if (this.isStale(turn)) return null;
      // 설정에서 대상이 바뀌어 멈췄으면 받은 조각은 기록에 넣지 않고 화면에서도 거둔다(#193).
      if (this.targetChangedTurn === turn) {
        this.send({ kind: "assistant_retract" });
        throw new Error(TARGET_CHANGED_NOTE);
      }
      throw err;
    } finally {
      if (this.activeRequest === controller) this.activeRequest = null;
    }
    this.recordUsage(turn, reply.usage(), Date.now() - openedAt);
    // 다 받은 직후에도 대상이 그대로인지 본다(끝나는 순간에 바뀌었으면 그 답을 쓰지 않는다).
    const after = activeModel(await getSettings());
    if (this.isStale(turn)) return null;
    if (targetMoved(after)) {
      this.targetChangedTurn = turn;
      this.send({ kind: "assistant_retract" });
      throw new Error(TARGET_CHANGED_NOTE);
    }
    const { assistantText, assistantReasoning, reasoningDetails, functionCalls, finishReason, chunkCount, textChars, thoughtChars } = reply.result();
    debugLog(
      "stream:done",
      `chunks=${chunkCount} text=${textChars} thought=${thoughtChars} fn=${functionCalls.length} finish=${finishReason ?? "?"}`,
    );
    if (this.isStale(turn)) return null;
    this.rebasePending = confirmRebases(this.rebasePending, this.rebaseConfirmed, sentRebases);
    return { sentNotes, sentCandidates: afterToolResult ? null : candidatesNote, assistantText, assistantReasoning, reasoningDetails, functionCalls, finishReason, thoughtChars };
  }

  // 도구 호출 순환 한도에 닿았을 때 지금까지 한 일을 보여 주고 extra번 더 진행할지 묻는다(#55). 사용자의 명시적 선택으로만
  // 한도를 넓힌다. 승인 카드와 같은 대기 목록(pendingApprovals)을 써서 중단·새 요청·패널 닫힘이면 거부로 풀린다.
  private async askToContinue(turn: number, used: number, extra: number, runs: readonly ToolRunRecord[]): Promise<{ proceed: boolean; note: string }> {
    const callId = `hop-limit-${turn}-${used}`;
    debugLog("hop:limit", `${used}회 · +${extra} 물음`);
    const summary = summarizeRuns(runs);
    // 원격 대화: 패널 카드 대신 원격 채널로 묻는다(결과 글은 넣지 않고 수치만, #185).
    if (this.remote) {
      const r = await this.remoteAsk(turn, remoteHopQuestion({ used, extra, total: summary.total, failed: summary.failed, cancelled: summary.cancelled, byTool: summary.byTool }));
      if (!this.isStale(turn)) debugLog("hop:limit_result", r === "approved" ? `continue +${extra}` : `stop (${String(r)})`);
      if (r === "approved") return { proceed: true, note: "" };
      return { proceed: false, note: r === "denied" || r === "cancelled" ? LIMIT_STOP_NOTE : LIMIT_NO_ANSWER_NOTE };
    }
    this.send({ kind: "status", text: null });
    this.send({ kind: "hop_limit", callId, used, extra, summary });
    const proceed = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve);
    });
    this.pendingApprovals.delete(callId);
    if (!this.isStale(turn)) debugLog("hop:limit_result", proceed ? `continue +${extra}` : "stop");
    return { proceed, note: LIMIT_STOP_NOTE };
  }

  // 원격 승인 질문(#185). 질문을 만들지 못했거나(null) 이번 턴에 물을 곳이 없으면 unavailable. 턴이 끝나면(중단·새 요청) STALE.
  // 질문마다 새 중단 신호를 쓰고, 결과는 이 호출의 반환값으로만 전한다(pendingApprovals를 거치지 않는다 — 같은 callId의 다른 대기를 건드리지 않게).
  private async remoteAsk(turn: number, q: RemoteQuestion | null): Promise<Exclude<RemoteAskResult, "aborted"> | typeof STALE> {
    const approver = this.turnApprover;
    if (!q || !approver || !approver.canAsk()) return "unavailable";
    // 채널의 고정 줄(MCP 요청을 텔레그램으로 물을 때의 요청 글 앞부분 등, #192)을 붙인 최종 글로 길이·비밀 값을 본다.
    const full = withPrefix(q, approver.prefix);
    if (!full) {
      debugLog("remote:ask_skipped", "질문이 너무 김");
      return "unavailable";
    }
    q = full;
    // 질문 글에 자동 로그인 값이 들어 있으면 묻지 않는다(가리면 무엇을 승인하는지 보이지 않는다). 목록을 못 읽으면 들어 있다고 본다.
    const secret = await containsSecret(q.text).catch(() => true);
    if (this.isStale(turn)) return STALE;
    if (secret) {
      debugLog("remote:ask_skipped", "자동 로그인 값이 들어 있음");
      return "unavailable";
    }
    const ctl = new AbortController();
    this.remoteAskAbort?.abort();
    this.remoteAskAbort = ctl;
    debugLog("remote:ask", `${q.text.length}자`);
    let r: RemoteAskResult;
    try {
      r = await approver.ask(q, ctl.signal);
    } catch (err) {
      debugLog("remote:ask_error", err instanceof Error ? err.message : String(err), "warn");
      r = "unavailable";
    } finally {
      if (this.remoteAskAbort === ctl) this.remoteAskAbort = null;
    }
    if (this.isStale(turn)) return STALE;
    debugLog("remote:ask_result", r);
    // 턴이 끝나지 않았는데 중단으로 돌아왔으면(채널 쪽 철회) 물을 수 없었던 것으로 본다.
    return r === "aborted" ? "unavailable" : r;
  }

  // 도구 없이 지금까지의 관측으로 답을 한 번 받아 턴을 끝낸다(한도에서 그만두기·헛돌기 감지). 모델이 그래도 도구를
  // 부르면 실행하지 않고 기록에도 남기지 않는다(결과 없는 tool_calls가 다음 요청을 깨지 않게).
  private async finishWithoutTools(
    apiKey: string,
    model: ModelId,
    systemPrompt: string,
    turn: number,
    note: string,
  ): Promise<void> {
    this.send({ kind: "status", text: "지금까지의 결과로 답을 정리하는 중…" });
    const reply = await this.requestModel(apiKey, model, systemPrompt, turn, { wrapUpNote: note, lowReasoning: true });
    if (!reply) return;
    if (reply.functionCalls.length) debugLog("wrapup:ignored_tool_calls", `${reply.functionCalls.length}`, "warn");
    const text = reply.assistantText.trim();
    if (text) {
      this.commitNotes(reply);
      this.history.push({
        role: "assistant",
        content: reply.assistantText,
        ...(reply.reasoningDetails.length
          ? { reasoning_details: reply.reasoningDetails }
          : reply.assistantReasoning
            ? { reasoning: reply.assistantReasoning }
            : {}),
      });
    }
    this.send({ kind: "status", text: null });
    this.send({ kind: "assistant_done", finishReason: reply.finishReason });
    if (!text) {
      this.send({ kind: "error", message: "도구 사용을 멈췄지만 모델이 정리한 답을 만들지 못했습니다. 다시 요청해 주세요." });
    } else if (reply.finishReason === "length") {
      this.send({
        kind: "error",
        message: "답이 응답 길이 한도에서 잘렸습니다. \"이어서\"라고 보내면 계속 씁니다.",
      });
    }
  }

  // 도구 호출 하나: 인자 해석 → 승인(손 넘기기·이번 대화 허락·자동 실행·카드) → 실행 → 결과 기록.
  // false: 이 요청이 끝났다(중단·새 요청). true: 결과를 남겼으니 다음 호출로 간다.
  private async handleCall(
    fc: OpenRouterToolCall,
    turn: number,
    turnTab: TurnTab,
    record: RecordRun,
    reads: { documents: number; otherTabs: number },
  ): Promise<boolean> {
    const toolName = fc.function.name as ToolName;
    // 모델이 준 id는 대화 기록에만 쓰고, 나머지는 내부 키로 찾는다(#221 — 다른 대화·같은 대화의 다른 턴이 같은 id를 줘도 겹치지 않게).
    const modelCallId = fc.id;
    const callId = `k${this.callNonce}-${++this.callSeq}`;
    // 이 호출을 실패로 끝낸다: 패널 결과 줄, 대화 기록(모델이 보는 오류), 헛돌기 감지 기록을 함께 남긴다.
    // panelSummary: 패널에만 다르게 보일 문구(허락으로 실행한 호출 등).
    const failCall = (msg: string, key: string, panelSummary = msg): void => {
      this.send({ kind: "tool_result", callId, toolName, ok: false, summary: panelSummary });
      this.history.push({ role: "tool", tool_call_id: modelCallId, name: toolName, content: this.toolContent(turnTab, { error: msg }) });
      this.noteRebases(callId);
      record(toolName, key, false, `error:${msg}`, msg);
    };

    let parsedArgs: unknown;
    try {
      parsedArgs = parseToolArgs(toolName, JSON.parse(fc.function.arguments || "{}"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToolFail(toolName, msg);
      failCall(msg, fc.function.arguments);
      return true;
    }
    const argsKey = canonicalJson(parsedArgs);

    if (toolName === "read_other_tabs" && ++reads.otherTabs > MAX_OTHER_TAB_READS_PER_TURN) {
      const msg = `한 요청에서 다른 탭 읽기는 최대 ${MAX_OTHER_TAB_READS_PER_TURN}번입니다. 지금까지 읽은 내용으로 답하세요.`;
      failCall(msg, argsKey);
      return true;
    }

    if (toolName === "read_document" && ++reads.documents > MAX_DOCUMENT_READS_PER_TURN) {
      const msg = `한 요청에서 파일은 최대 ${MAX_DOCUMENT_READS_PER_TURN}개까지 읽을 수 있습니다. 지금까지 읽은 내용으로 답하고, 더 필요하면 사용자에게 다음 요청으로 나눠 달라고 하세요.`;
      failCall(msg, argsKey);
      return true;
    }

    const call: ToolCallContext = { turn, turnTab, callId, modelCallId, toolName, parsedArgs, argsKey, failCall, record };
    // 원격 대화에서 쓰지 않는 도구: 자동 로그인(승인한 사이트여도), 저장 링크(요청 글에 적지 않은 사이트로 간다), 반복 작업 등록.
    if (this.remote && REMOTE_BLOCKED_TOOLS.has(toolName)) {
      this.cancelCall(call, null);
      return true;
    }
    if (toolName === "confirm_task") return this.confirmTask(call);
    if (toolName === "schedule_repeat_task") return this.scheduleRepeat(call);
    if (toolName === "remember_page") return this.rememberPage(call);
    const auth = await this.authorizeCall(call);
    if (auth.kind === "stale") return false;
    if (auth.kind === "done") return true;
    if (auth.kind === "handoff") return this.finishHandoff(call, auth);
    return this.runAuthorized(call, auth);
  }

  // 승인 단계. 승인 대상이 아닌 도구는 그대로 실행하고, 대상이면 판정(src/lib/approvalDecision.ts)에 따라
  // 손 넘기기·이번 대화 허락·자동 실행·카드 중 하나로 정한다. 취소·실패는 여기서 결과를 남기고 done을 돌려준다.
  private async authorizeCall(call: ToolCallContext): Promise<CallAuthorization> {
    const { turn, turnTab, callId, toolName, parsedArgs, argsKey, failCall } = call;
    // 외부 본문 보호가 켜졌으면 관측 전용이 아닌 도구는 평소 승인 대상이 아니어도(번역·Google 읽기 등) 묻는다.
    const guarded = this.externalContent && needsApprovalWhenProtected(toolName);
    if (!SENSITIVE_TOOLS.has(toolName) && !guarded) {
      return { kind: "run", execArgs: parsedArgs, via: null, signInAttempt: null, internalNavSite: null };
    }
    let preview: ToolPreview;
    try {
      preview = await buildToolPreview(toolName, parsedArgs, callId, turnTab, this.rebaseConfirmed);
    } catch (err) {
      // 미리보기 실패가 턴 전체를 끝내지 않도록 이 호출의 오류 결과로 돌려준다.
      if (this.isStale(turn)) return STALE;
      const msg = err instanceof Error ? err.message : String(err);
      logToolFail(toolName, msg);
      failCall(msg, argsKey);
      return DONE;
    }
    // 대상 확인을 기다리는 동안 사용자가 중단하거나 새 대화를 시작했으면 카드를 띄우지 않는다.
    if (this.isStale(turn)) return STALE;
    // 실행 인자. 미리보기가 정한 값(이미지 저장 폴더)이 있으면 그것으로 고정한다(승인·허락 판정과 같은 폴더).
    let execArgs: unknown = preview.execArgs !== undefined ? preview.execArgs : parsedArgs;
    // 자동 실행: 켜져 있고 예외(결제·개인정보 제출 등)가 아니면 카드 없이 실행한다.
    const { runMode: storedRunMode, manualSites, remoteSites } = await getSettings();
    const runMode = this.effectiveRunMode(storedRunMode);
    if (this.isStale(turn)) return STALE;
    const autoApprove = runMode === "auto";
    // 다른 실행 방식으로 바꿨으면 맡긴 작업을 거둔다(다시 task로 바꾸면 새로 묻는다).
    if (runMode !== "task") this.setTaskApproved(false);
    const trusted = new Set(this.approvedSites);
    if (this.turnSite) trusted.add(this.turnSite);
    // 원격 요청에서 묻지 않을 사이트(#192): 원격 대화면 호출마다 지금 설정에서 읽어 더한다(대화에 쌓지 않음 — 목록에서 빼면 다음 호출부터 빠짐).
    const remoteTrusted = new Set<string>();
    if (this.remote) {
      for (const origin of remoteSites) {
        const site = siteOf(origin);
        if (site) {
          remoteTrusted.add(site);
          trusted.add(site);
        }
      }
    }
    let pageUrl: string | undefined;
    if (toolName === "click_element" || toolName === "fill_form_fields" || toolName === "sign_in") {
      try {
        // 팝업 창을 따라가는 중이면 그 창의 주소로 사이트 경계를 본다(다른 사이트의 팝업은 이동과 같게 묻는다).
        pageUrl = await toolTabUrl(turnTab);
      } catch {
        pageUrl = undefined;
      }
      if (this.isStale(turn)) return STALE;
    }
    // 턴 탭이 지금 내부 페이지(새 탭·설정)면 이동은 요청 글에 사용자가 적은 사이트·카드로 허락한 사이트 안에서만
    // 자동 실행한다(#54). 내부 페이지에는 페이지 글이 없어 숨긴 지시문이 끼어들 수 없다.
    const fromInternal = toolName === "navigate_to_url" && (await turnTabIsInternal(turnTab));
    if (this.isStale(turn)) return STALE;
    // 승인 판정(손 넘기기·이번 대화 허락·자동 실행·카드)과 카드에 함께 보일 제안. 규칙은 src/lib/approvalDecision.ts.
    let decision = decideApproval({
      toolName,
      preview,
      guarded,
      autoApprove,
      taskMode: runMode === "task",
      pageUrl,
      manualSite: isManualSite(manualSites, pageUrl),
      trusted,
      turn,
      linkGrant: this.linkGrant,
      fromInternal,
      namedSites: this.turnNamedSites,
      allowedPersonalUrls: this.allowedPersonalUrls,
      chatGrants: this.chatGrants,
    });
    // 자동 로그인으로 값을 넣을 출처·단계(실행 직전에 시도로 기록한다).
    let signInAttempt: string | null = null;
    // sign_in 준비의 열쇠(취소·손 넘기기로 끝나면 받은 값을 버린다).
    let signInToken: string | null = null;
    let loginOffer: string | null = null;
    let signInHandoffWhy: string | null = null;
    if (toolName === "sign_in" && preview.signIn) {
      const sp = preview.signIn;
      if (sp.origin) signInAttempt = `${sp.origin}|${sp.shape.step}`;
      signInToken = sp.token;
      const login = await this.signInApproval(call, preview, guarded, isManualSite(manualSites, pageUrl));
      if (!login) return STALE;
      decision = login.decision;
      loginOffer = login.loginOffer;
      signInHandoffWhy = login.handoffWhy;
      if (login.execArgs !== undefined) execArgs = login.execArgs;
    }
    // 이번 대화 허락으로 저장할 이미지를 이 호출을 위해 쿠키 없이 미리 받은 것(실행 옵션으로 직접 넘긴다).
    let grantImages: Map<string, string> | undefined;
    // 이미지 저장을 허락으로 실행할 때는 쿠키 없이·리다이렉트 없이 이미지를 미리 받아 그 바이트만 저장한다.
    // 받지 못하면(리다이렉트·이미지 아님·너무 큼·로그인 필요) 허락을 쓰지 않고 그 이유와 함께 카드로 묻는다.
    if (decision.mode === "grant" && toolName === "download_images") {
      // 허락으로 받는 것은 모델이 넘긴 주소의 고정 후보뿐이다(카드에 선택 해제로 함께 보일 페이지의 다른 이미지는 아님).
      // 카드로 넘어가면 사용자가 고른 것으로 다시 정한다.
      setChosenDownloads(callId, preview.grantChoiceIds ?? []);
      // 받는 동안 중단·새 대화·패널 닫힘이면(cancelInFlight가 activeTool을 끊는다) 남은 주소로 요청하지 않는다.
      const prefetchAbort = new AbortController();
      this.activeTool = prefetchAbort;
      let got: Awaited<ReturnType<typeof prepareGrantImages>>;
      try {
        got = await prepareGrantImages(
          chosenDownloads(callId, "image").map((c) => c.url),
          prefetchAbort.signal,
        );
      } finally {
        if (this.activeTool === prefetchAbort) this.activeTool = null;
      }
      if (this.isStale(turn)) return STALE;
      if ("why" in got) decision = withoutChatGrant(decision, got.why);
      else grantImages = got.images;
    }

    if (decision.mode === "handoff") {
      const handed = await this.handOff(call, preview, signInToken, signInHandoffWhy);
      if (handed.kind !== "cancelled") return handed;
      return this.cancelCall(call, signInToken);
    }
    // 원격 질문에 보일 이 호출(모델에 보낸 글·고정 문구로만, #185).
    const remoteInput = {
      toolName,
      url: toolName === "navigate_to_url" ? String(preview.details ?? "") : undefined,
      target: preview.remoteTarget,
      linkHrefs: preview.linkHrefs,
      pageUrl,
      fields: preview.remoteFields,
      document: preview.remoteDocument,
      capture: preview.remoteCapture,
      choices: preview.remoteChoices,
      guarded,
      block: decision.block,
      chatGrantReason: decision.chatGrant.reason,
    };
    if (decision.mode === "task") {
      if (!this.taskApproved) {
        // 모델이 confirm_task로 맡기지 않고 승인이 필요한 동작을 불렀다: 이 동작을 할 일로 보여 한 번 묻는다.
        // 원격은 카드 글(원문 대상 글자가 섞일 수 있음) 대신 원격 질문 재료로 만든 줄만 보이고, 만들 수 없으면 묻지 않고 거절한다.
        const firstAction = this.remote ? remoteActionLines(remoteInput) : null;
        if (this.remote && !firstAction) return this.remoteNeedsTask(call, signInToken);
        const asked = await this.askTask(call, this.remote ? "" : `첫 동작: ${preview.summary}`, [], firstAction);
        if (asked === null) {
          discardSignIn(signInToken);
          return STALE;
        }
        if (!asked.approved) return this.cancelCall(call, signInToken, asked.remote);
      }
      debugLog("tool:task_run", toolName);
      // 고르는 카드(링크 읽기·저장)는 미리보기가 정한 기본 선택(모델이 넘긴 후보 중 경고가 없는 것)으로 실행한다.
      if (preview.choices) {
        const ids = preview.choiceDefaults ?? [];
        setChosenLinks(callId, ids);
        setChosenDownloads(callId, ids);
      }
      return { kind: "run", execArgs, via: "task", signInAttempt, internalNavSite: null };
    }
    if (decision.mode === "grant") {
      debugLog("tool:chat_grant_approved", toolName);
      // 선택 카드는 미리보기가 정한 후보를 고른 것으로 한다(링크 읽기는 고정한 후보 전부, 이미지 저장은 모델이 넘긴
      // 주소의 후보). 경고가 붙은 후보가 있으면 위에서 덮지 않았다.
      if (preview.grantChoiceIds) {
        setChosenLinks(callId, preview.grantChoiceIds);
        setChosenDownloads(callId, preview.grantChoiceIds);
      }
      return { kind: "run", execArgs, via: "grant", grantImages, signInAttempt, internalNavSite: null };
    }
    if (decision.mode === "auto") {
      debugLog(
        "tool:auto_approved",
        `${toolName}${decision.linkGranted && !autoApprove ? " (link grant)" : ""}${fromInternal ? " (내부 페이지에서)" : ""}`,
      );
      // 내부 페이지에서 사용자가 적은 사이트로 자동 이동했으면, 이동이 성공한 뒤 그 사이트를 이 턴의 사이트로 삼아
      // 이후 클릭·입력의 자동 실행 범위로 쓴다(카드로 허락한 이동이 approvedSites가 되는 것과 같은 범위).
      // 원격 허용 사이트 덕분에 자동으로 간 이동은 턴의 사이트로 올리지 않는다(설정에서 빼면 바로 빠지게, #192).
      // 판정은 자동 이동과 같은 경계(withinTrusted — 같은 등록 도메인 포함)로: 허용 사이트를 빼고도 자동이었을 때만 올린다.
      const navTarget = String(preview.details ?? "");
      const navSite = fromInternal && !this.turnSite ? siteOf(navTarget) : null;
      const withoutRemote = new Set(this.approvedSites);
      const onlyRemote = !!navSite && remoteTrusted.size > 0 && internalNavigateAutoBlock(withoutRemote, this.turnNamedSites, navTarget) !== null;
      const internalNavSite = onlyRemote ? null : navSite;
      return { kind: "run", execArgs, via: "auto", signInAttempt, internalNavSite };
    }
    // 원격 대화: 카드 대신 원격 채널로 묻는다(#185). 질문은 모델에 보낸 글·고정 문구로만 만들고, 만들 수 없으면 거절.
    if (this.remote) {
      const r = await this.remoteAsk(turn, remoteToolQuestion(remoteInput));
      if (typeof r !== "string") {
        discardSignIn(signInToken);
        return STALE;
      }
      if (r !== "approved") return this.cancelCall(call, signInToken, r);
      // 원격으로 허락한 이동의 출처도 카드로 허락한 것과 같게 이 대화의 자동 이동 범위에 둔다.
      if (toolName === "navigate_to_url") {
        const site = siteOf(String(preview.details ?? ""));
        if (site) this.approvedSites.add(site);
      }
      // 선택 카드는 원격에서 고를 수 없어 질문에 보인 기본 선택만 실행한다(#192).
      if (preview.choices) {
        const ids = preview.choiceDefaults ?? [];
        setChosenLinks(callId, ids);
        setChosenDownloads(callId, ids);
      }
      debugLog("tool:remote_approved", toolName);
      return { kind: "run", execArgs, via: null, signInAttempt, internalNavSite: null };
    }
    const asked = await this.askByCard(call, preview, decision, guarded, loginOffer);
    if (asked.kind === "cancelled") return this.cancelCall(call, signInToken);
    if (asked.kind !== "approved") return asked;
    return {
      kind: "run",
      execArgs: asked.execArgs ?? execArgs,
      via: null,
      signInAttempt,
      internalNavSite: null,
    };
  }

  // 자동 로그인(sign_in)의 승인 판정: 출처 → 항목 승인(설정)과 로그인 양식의 구조로 따로 정한다(src/lib/loginPolicy.ts).
  // 비밀번호 관리자를 쓸 수 없거나 직접 조작할 사이트면 칸을 표시해 사용자가 직접 로그인하게 한다(손 넘기기).
  // null: 이 요청이 끝났다.
  private async signInApproval(
    call: ToolCallContext,
    preview: ToolPreview,
    guarded: boolean,
    manualSite: boolean,
  ): Promise<{ decision: ApprovalDecision; loginOffer: string | null; handoffWhy: string | null; execArgs?: unknown } | null> {
    const sp = preview.signIn!;
    const asMode = (mode: ApprovalDecision["mode"], block: string | null): ApprovalDecision => ({
      mode,
      autoMode: mode === "card",
      block,
      linkOffer: false,
      linkGranted: false,
      urlOffer: false,
      pageSite: null,
      chatGrant: { covered: false, offer: false, reason: null },
      taskCovered: false,
    });
    const handoffWhy = manualSite
      ? "사용자가 '직접 조작할 사이트'로 정한 사이트입니다"
      : !sp.origin
        ? "https 로그인 페이지가 아니어서 비밀번호 관리자를 쓰지 않습니다"
        : sp.manager === "none"
          ? "비밀번호 관리자(KeePassXC)가 연결되지 않았습니다(설정 → 자동 로그인)"
          : sp.manager === "error"
            ? `비밀번호 관리자에서 항목을 받지 못했습니다(${sp.managerError ?? "오류"})`
            : sp.entries.length === 0
              ? "비밀번호 관리자에 이 주소의 항목이 없습니다"
              : null;
    if (handoffWhy || !sp.origin) return { decision: asMode("handoff", handoffWhy), loginOffer: null, handoffWhy };
    const { loginSites } = await getSettings();
    if (this.isStale(call.turn)) return null;
    const site = loginSiteFor(loginSites, sp.origin);
    const d = signInDecision({
      shape: sp.shape,
      origin: sp.origin,
      site,
      entryUuids: sp.entries.map((e) => e.uuid),
      attempted: this.loginAttempts.has(`${sp.origin}|${sp.shape.step}`),
      maskedHere: this.secretsMasked,
      guarded,
    });
    if (d.auto && site) {
      return {
        decision: asMode("auto", null),
        loginOffer: null,
        handoffWhy: null,
        execArgs: { ...(call.parsedArgs as object), uuid: site.uuid, token: sp.token },
      };
    }
    // 승인한 항목이 있으면 처음부터 골라 둔다. 승인 목록에 없거나 다른 항목이면 사용자가 직접 고른다.
    if (site && sp.entries.some((e) => e.uuid === site.uuid)) preview.choiceDefaults = [site.uuid];
    const loginOffer = !site || sp.entries.every((e) => e.uuid !== site.uuid) ? sp.origin : null;
    return { decision: asMode("card", d.auto ? null : d.reason), loginOffer, handoffWhy: null };
  }

  // 작업 맡기기 카드(#123): 사용자가 보낸 요청 글(원문)과 할 일·위험을 보이고 한 번 묻는다. 맡기면 이 대화가 끝날 때까지
  // 승인 카드를 띄우지 않는다(손 넘기기·로그인 항목·탭 고르기는 그대로). null: 이 요청이 끝났다.
  // 원격(텔레그램)은 카드 대신 원격 질문으로 묻는다(firstAction: 맡기지 않고 부른 첫 동작의 원격 질문 줄). remote: 승인하지 않은 원격 결과.
  private async askTask(
    call: ToolCallContext,
    plan: string,
    risks: string[],
    firstAction: { title: string; lines: string[] } | null = null,
  ): Promise<{ approved: boolean; remote?: Exclude<RemoteAskResult, "approved" | "aborted"> } | null> {
    const { turn, callId, toolName, parsedArgs } = call;
    const epoch = this.taskEpoch;
    debugLog("tool:awaiting_task", toolName);
    if (this.remote) {
      const r = await this.remoteAsk(turn, remoteTaskQuestion({ request: this.turnRequest, plan, risks, firstAction }));
      if (typeof r !== "string") return null;
      if (r !== "approved") {
        debugLog("tool:task_result", r);
        return { approved: false, remote: r };
      }
      const runMode = this.effectiveRunMode((await getSettings()).runMode);
      if (this.isStale(turn)) return null;
      // 묻는 사이 묻기를 껐거나 맡긴 작업을 거뒀으면(다시 켰어도) 그 승인은 쓰지 않는다.
      if (epoch !== this.taskEpoch || runMode !== "task") {
        debugLog("tool:task_result", "withdrawn");
        return { approved: false };
      }
      debugLog("tool:task_result", "approved");
      this.setTaskApproved(true);
      return { approved: true };
    }
    this.send({
      kind: "tool_pending",
      callId,
      toolName,
      args: parsedArgs,
      previewSummary: "이 일을 맡기고 끝까지 실행할까요?",
      task: { request: this.turnRequest.slice(0, 2000), plan, risks },
    });
    this.pendingTaskCall = callId;
    let approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve);
    });
    this.pendingApprovals.delete(callId);
    if (this.pendingTaskCall === callId) this.pendingTaskCall = null;
    if (this.isStale(turn)) return null;
    // 카드가 열린 사이 다른 방식으로 바꿨거나 거뒀으면(돌아왔어도) 그 카드의 승인은 쓰지 않는다.
    if (approved) {
      const runMode = this.effectiveRunMode((await getSettings()).runMode);
      if (this.isStale(turn)) return null;
      if (epoch !== this.taskEpoch || runMode !== "task") approved = false;
    }
    debugLog("tool:task_result", approved ? "approved" : "cancelled");
    if (approved) this.setTaskApproved(true);
    return { approved };
  }

  // confirm_task(#123): 실행 방식이 task이고 아직 맡기지 않았으면 작업 맡기기 카드로 묻는다. false: 이 요청이 끝났다.
  private async confirmTask(call: ToolCallContext): Promise<boolean> {
    const { turn, turnTab, callId, toolName, argsKey } = call;
    const args = call.parsedArgs as { summary: string; risks: string[] };
    const runMode = this.effectiveRunMode((await getSettings()).runMode);
    if (this.isStale(turn)) return false;
    let summary: string;
    let note: string;
    if (runMode !== "task") {
      this.setTaskApproved(false);
      summary = "지금 실행 방식에서는 맡기지 않음";
      note = "지금 실행 방식은 '처음에 승인 받고 끝까지 실행'이 아닙니다. confirm_task 없이 평소처럼 진행하세요(승인이 필요한 동작은 카드로 묻습니다).";
    } else if (this.taskApproved) {
      summary = "이미 맡긴 작업";
      note = "이 대화에서 이미 작업을 맡겼습니다. 승인 카드 없이 진행하세요.";
    } else {
      const asked = await this.askTask(call, args.summary, args.risks);
      if (asked === null) return false;
      if (!asked.approved) {
        this.cancelCall(call, null, asked.remote);
        return true;
      }
      summary = "작업을 맡김 · 이 대화에서는 묻지 않고 실행";
      note = "사용자가 작업을 맡겼습니다. 이 대화에서는 승인 카드 없이 진행합니다. 맡긴 일의 범위를 벗어나는 동작은 하지 않습니다.";
    }
    this.send({ kind: "tool_result", callId, toolName, ok: true, summary });
    this.history.push({ role: "tool", tool_call_id: call.modelCallId, name: toolName, content: this.toolContent(turnTab, { result: { note } }) });
    call.record(toolName, argsKey, true, `task:${summary}`, summary);
    return true;
  }

  // 반복 작업 등록(#138): 실행 방식·맡긴 작업·이번 대화 허락과 관계없이 늘 카드로 묻는다(브라우저에 남아 페이지를 다시 여는
  // 활동을 새로 만든다). 승인은 이 등록에만 쓰고 맡긴 작업·대화 허락을 주지 않는다. false: 이 요청이 끝났다.
  private async scheduleRepeat(call: ToolCallContext): Promise<boolean> {
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
    if (this.isStale(turn)) return false;
    const timeOf = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const details = [
      `요청: ${this.turnRequest.slice(0, 500)}`,
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
    this.send({ kind: "tool_pending", callId, toolName, args: call.parsedArgs, previewSummary: "이 반복 작업을 등록할까요?", previewDetails: details });
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve);
    });
    this.pendingApprovals.delete(callId);
    if (this.isStale(turn)) return false;
    if (!approved) {
      this.cancelCall(call, null);
      return true;
    }
    let task: RepeatTask;
    try {
      task = await registerRepeatTask(args, this.turnRequest);
    } catch (err) {
      if (this.isStale(turn)) return false;
      const msg = err instanceof Error ? err.message : String(err);
      logToolFail(toolName, msg);
      failCall(msg, argsKey);
      return true;
    }
    if (this.isStale(turn)) return false;
    // 끝나는 시각은 승인한 때부터 센다(실제로 저장한 값으로 알린다).
    const until = timeOf(task.endsAt);
    const summary = `반복 작업 등록: ${task.title} · ${task.intervalMinutes}분마다 · ${until}까지`;
    this.send({ kind: "tool_result", callId, toolName, ok: true, summary });
    this.history.push({
      role: "tool",
      tool_call_id: call.modelCallId,
      name: toolName,
      content: this.toolContent(turnTab, {
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
  private async rememberPage(call: ToolCallContext): Promise<boolean> {
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
      if (this.isStale(turn)) return false;
      const msg = err instanceof Error ? err.message : String(err);
      logToolFail(toolName, msg);
      failCall(msg, argsKey);
      return true;
    }
    if (this.isStale(turn)) return false;
    const res = await makeOfferResult(tabId, null, { query: this.turnRequest, answer: "" }, expectDoc, expectUrl).catch(() => ({ reason: "tab_gone" as const }));
    if (this.isStale(turn)) return false;
    if ("reason" in res) {
      const msg = OFFER_REFUSAL_TEXT[res.reason];
      logToolFail(toolName, msg);
      failCall(msg, argsKey);
      return true;
    }
    if (this.rememberedUrls.turn !== turn) this.rememberedUrls = { turn, urls: new Set() };
    this.rememberedUrls.urls.add(res.offer.url);
    const autoDraft = !this.externalContent;
    this.send({ kind: "page_save_offer", offer: res.offer, open: true, autoDraft });
    const summary = "이 페이지의 저장 카드를 띄움(사용자가 저장을 눌러야 저장)";
    this.send({ kind: "tool_result", callId, toolName, ok: true, summary });
    this.history.push({
      role: "tool",
      tool_call_id: call.modelCallId,
      name: toolName,
      content: this.toolContent(turnTab, {
        result: {
          shown: true,
          note: `저장 카드를 띄웠습니다${autoDraft ? "(이름·용도·입력 자리는 자동으로 채워집니다)" : ""}. 아직 저장되지 않았습니다. 사용자가 카드에서 내용을 확인하고 저장을 눌러야 저장된다고 알려 주세요.`,
        },
      }),
    });
    call.record(toolName, argsKey, true, "remember:shown", summary);
    return true;
  }

  // 손 넘기기: 페이지에 대상을 표시하고 사용자가 직접 조작(클릭·입력·로그인)하기를 기다린다.
  private async handOff(
    call: ToolCallContext,
    preview: ToolPreview,
    signInToken: string | null,
    signInHandoffWhy: string | null,
  ): Promise<typeof STALE | typeof DONE | { kind: "cancelled" } | HandedOff> {
    const { turn, turnTab, callId, toolName, parsedArgs, argsKey, failCall } = call;
    const ids =
      toolName === "click_element" || toolName === "sign_in"
        ? [(parsedArgs as { id: string }).id]
        : (parsedArgs as { fills: Array<{ id: string }> }).fills.map((f) => f.id);
    // 사용자가 표시한 대상을 눌러 팝업 창을 열면 그 창을 따라간다(#81). 넘기는 동안 이 탭이 여는 창을 지켜보고,
    // 사용자가 대상을 누른 것(clicked)으로 끝났을 때만 그 즈음 열린 창을 클릭과 같은 규칙으로 따라간다.
    const popups = toolName === "click_element" ? await this.watchHandoffPopups(turnTab) : null;
    let shown: HandoffSession;
    try {
      // sign_in은 칸을 준비 열쇠(token)로 승인 대상에 남겼다.
      shown = await showHandoff(turnTab, (toolName === "sign_in" && signInToken) || callId, toolName === "click_element" ? "c" : "f", ids);
    } catch (err) {
      popups?.stop();
      if (this.isStale(turn)) return STALE;
      const msg = err instanceof Error ? err.message : String(err);
      logToolFail(toolName, msg);
      recordCancelledAction(callId, turnTab);
      failCall(msg, argsKey);
      return DONE;
    }
    if (this.isStale(turn)) {
      void endHandoff(shown);
      popups?.stop();
      return STALE;
    }
    debugLog("tool:handoff", toolName);
    this.send({
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
      this.pendingApprovals.get(callId)?.(!expired);
    });
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve);
    });
    stopWatch();
    this.pendingApprovals.delete(callId);
    void endHandoff(shown);
    if (this.isStale(turn)) {
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

  // 승인 카드로 묻고 답을 기다린다. 카드에 함께 보인 제안(링크 허락·개인정보 주소·자동 로그인·이번 대화 허락)은
  // 사용자가 고른 것을 각 처리기가 기록하고, 여기서는 기다린 뒤 정리한다.
  private async askByCard(
    call: ToolCallContext,
    preview: ToolPreview,
    decision: ApprovalDecision,
    guarded: boolean,
    loginOffer: string | null,
  ): Promise<typeof STALE | typeof DONE | { kind: "cancelled" } | { kind: "approved"; execArgs?: unknown }> {
    const { turn, turnTab, callId, toolName, parsedArgs, argsKey, failCall } = call;
    const { autoMode, block, linkOffer, urlOffer, pageSite, chatGrant } = decision;
    const personalUrlKeys = preview.personalUrlKeys ?? [];
    const withUrlOffer = (details: unknown) =>
      `${typeof details === "string" && details ? `${details}\n` : ""}개인정보 모양이 걸린 주소:\n${(preview.personalUrls ?? []).map((u) => `- ${u}`).join("\n")}`;
    if (autoMode) debugLog("tool:auto_blocked", `${toolName} · ${block}`);
    if (chatGrant.reason) debugLog("tool:chat_grant_blocked", `${toolName} · ${chatGrant.reason}`);
    debugLog("tool:awaiting_approval", `${toolName}`);
    this.send({
      kind: "tool_pending",
      callId,
      toolName,
      args: parsedArgs,
      // 이 도구를 이번 대화에서 허락했는데 묻는 것이면 그 이유를 먼저 보인다(보호 중이라 쓰지 않는 경우 포함).
      previewSummary: chatGrant.reason
        ? `${preview.summary} (이번 대화 허락 예외: ${chatGrant.reason})`
        : guarded
          ? `${preview.summary} (외부 문서 내용을 읽은 대화라 자동 실행하지 않음)`
          : autoMode
            ? `${preview.summary} (자동 실행 예외: ${block})`
            : preview.summary,
      previewDetails: urlOffer ? withUrlOffer(preview.details) : preview.details,
      // 전체 보기(#132)에도 개인정보 주소 목록을 같은 글로 붙인다(펼쳐도 무엇을 허용하는지 보이게).
      ...(preview.fullDetails ? { previewFullDetails: urlOffer ? withUrlOffer(preview.fullDetails) : preview.fullDetails } : {}),
      ...(linkOffer ? { linkGrantOffer: true } : {}),
      ...(urlOffer ? { personalUrlOffer: true } : {}),
      ...(loginOffer ? { loginSiteOffer: loginOffer } : {}),
      ...(chatGrant.offer ? { chatGrantOffer: true } : {}),
      ...(preview.choices
        ? { choices: preview.choices, choiceLimit: preview.choiceLimit, choiceDefaults: preview.choiceDefaults }
        : {}),
    });
    if (linkOffer && pageSite) this.linkGrantOffers.set(callId, { turn, site: pageSite });
    if (urlOffer) this.personalUrlOffers.set(callId, { turn, keys: personalUrlKeys });
    if (loginOffer) this.loginSiteOffers.set(callId, loginOffer);
    if (toolName === "sign_in" && preview.signIn) this.signInTokens.set(callId, preview.signIn.token);
    if (chatGrant.offer && isChatGrantTool(toolName)) {
      this.chatGrantOffers.set(callId, { tool: toolName, scope: preview.grantScope ?? "" });
    }
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(callId, resolve);
    });
    this.pendingApprovals.delete(callId);
    this.linkGrantOffers.delete(callId);
    this.chatGrantOffers.delete(callId);
    this.personalUrlOffers.delete(callId);
    const rememberOrigin = this.rememberLogin.has(callId) ? this.loginSiteOffers.get(callId) : undefined;
    this.loginSiteOffers.delete(callId);
    this.rememberLogin.delete(callId);
    this.signInTokens.delete(callId);
    if (this.isStale(turn)) {
      discardSignIn(preview.signIn?.token);
      return STALE;
    }
    debugLog(
      "tool:approval_result",
      `${toolName} ${approved ? "approved" : "cancelled"}`,
    );
    if (!approved) return { kind: "cancelled" };
    let execArgs: unknown;
    // 자동 로그인: 카드에서 고른 항목으로 실행한다. "앞으로 자동 로그인"을 골랐으면 그 출처에 이 항목을 묶어 둔다.
    if (toolName === "sign_in") {
      const token = preview.signIn?.token ?? "";
      const uuid = chosenSignInEntry(token);
      if (!uuid) {
        discardSignIn(token);
        recordCancelledAction(callId, turnTab);
        failCall("로그인할 항목을 고르지 않아 넣지 않았습니다.", argsKey);
        return DONE;
      }
      execArgs = { ...(parsedArgs as object), uuid, token };
      const entry = preview.signIn?.entries.find((e) => e.uuid === uuid);
      if (rememberOrigin && entry) {
        await applySettingsUpdate((cur) => ({
          loginSites: [
            ...cur.loginSites.filter((s) => s.origin !== rememberOrigin),
            { origin: rememberOrigin, uuid, entryName: entry.name || "(제목 없는 항목)", totp: false, grantId: newGrantId() },
          ].slice(-MAX_LOGIN_SITES),
        })).catch((err) => debugLog("login:remember_failed", err instanceof Error ? err.message : String(err), "warn"));
        debugLog("login:site_approved", rememberOrigin);
        if (this.isStale(turn)) {
          discardSignIn(token);
          return STALE;
        }
      }
    }
    // 사용자가 카드로 허락한 이동의 출처는 이 대화에서 자동 이동해도 되는 곳으로 둔다.
    if (toolName === "navigate_to_url") {
      try {
        const site = siteOf(String(preview.details));
        if (site) this.approvedSites.add(site);
      } catch {
        /* ignore */
      }
    }
    return { kind: "approved", execArgs };
  }

  // 원격 task에서 모델이 맡기지 않고 부른 동작을 원격 질문으로 보일 수 없을 때(그 밖의 도구·잘린 대상 등): 실행하지 않고, 먼저
  // confirm_task로 맡기라고 돌려준다(턴을 마무리하지 않음 — 모델이 맡긴 뒤 다시 부르게).
  private remoteNeedsTask(call: ToolCallContext, signInToken: string | null): typeof DONE {
    const { turnTab, callId, toolName, argsKey } = call;
    discardSignIn(signInToken);
    discardTabChoices(callId);
    discardLinkCall(callId);
    discardDownloadCall(callId);
    const summary = "작업을 맡기기 전이라 하지 않음";
    debugLog("remote:task_needed", toolName);
    this.send({ kind: "tool_result", callId, toolName, ok: false, summary });
    this.history.push({
      role: "tool",
      tool_call_id: call.modelCallId,
      name: toolName,
      content: this.toolContent(turnTab, {
        error: "remote_task_not_confirmed",
        note: "아직 작업을 맡지 않아 실행하지 않았다. 먼저 confirm_task(할 일 요약, 이 작업의 위험)를 불러 사용자에게 맡길지 묻고, 맡기면 이 동작을 다시 불러라.",
      }),
    });
    call.record(toolName, argsKey, false, "remote_task_not_confirmed", summary);
    return DONE;
  }

  // 사용자가 취소한 호출(카드 취소·손 넘기기 취소)의 결과를 남기고 준비한 것을 버린다.
  private cancelCall(
    call: ToolCallContext,
    signInToken: string | null,
    remoteResult: Exclude<RemoteAskResult, "approved" | "aborted"> = "unavailable",
  ): typeof DONE {
    const { turnTab, callId, toolName, argsKey } = call;
    recordCancelledAction(callId, turnTab);
    discardSignIn(signInToken);
    discardTabChoices(callId);
    discardLinkCall(callId);
    discardDownloadCall(callId);
    if (this.remote) {
      // 원격 대화에서 승인이 필요해 하지 않은 호출.
      this.remoteRefusedTurn = call.turn;
      this.remoteStopReason = remoteResult;
      const refusal = remoteRefusal(remoteResult);
      const note = remoteResult === "unavailable" ? REMOTE_REFUSED_NOTE : refusal.note;
      this.send({ kind: "tool_result", callId, toolName, ok: false, summary: refusal.summary, cancelled: true });
      this.history.push({ role: "tool", tool_call_id: call.modelCallId, name: toolName, content: this.toolContent(turnTab, { error: refusal.error, note }) });
      call.record(toolName, argsKey, false, refusal.error, refusal.summary, { cancelled: true });
      return DONE;
    }
    this.send({
      kind: "tool_result",
      callId,
      toolName,
      ok: false,
      summary: "사용자가 취소했습니다.",
      cancelled: true,
    });
    this.history.push({
      role: "tool",
      tool_call_id: call.modelCallId,
      name: toolName,
      content: this.toolContent(turnTab, { error: "user_cancelled" }),
    });
    call.record(toolName, argsKey, false, "user_cancelled", "사용자가 취소했습니다.", { cancelled: true });
    return DONE;
  }

  // 사용자가 직접 조작해 마친 호출(실행하지 않는다)의 결과를 남긴다. false: 이 요청이 끝났다.
  private async finishHandoff(call: ToolCallContext, handed: HandedOff): Promise<boolean> {
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
        ? await handed.popups.settle(handed.clickedAt, () => this.isStale(turn)).catch(() => null)
        : null;
      if (this.isStale(turn)) return false;
      // 손 넘기기는 클릭·입력·로그인에만 한다(decideApproval의 isPageAction, signInApproval).
      note = `${handoffResultText(toolName as "click_element" | "fill_form_fields", outcome)}${popupNote ? ` ${popupNote}` : ""}`;
      summary = `직접 조작 · ${HANDOFF_LABELS[outcome]}`;
    }
    this.send({ kind: "tool_result", callId, toolName, ok: true, summary });
    this.history.push({
      role: "tool",
      tool_call_id: call.modelCallId,
      name: toolName,
      content: this.toolContent(turnTab, { result: { handedOff: true, outcome, note } }),
    });
    // 사용자가 한 일이라 같은 대상을 다시 넘겨도 헛돌기로 세지 않는다.
    call.record(toolName, argsKey, true, `handoff:${outcome}`, note, { changed: true });
    return true;
  }

  // 승인된(또는 승인 대상이 아닌) 호출을 실행하고 결과를 남긴다. false: 이 요청이 끝났다.
  private async runAuthorized(call: ToolCallContext, auth: AuthorizedRun): Promise<boolean> {
    const { turn, turnTab, callId, toolName, argsKey, failCall } = call;
    const { via } = auth;
    let { execArgs } = auth;
    const grantRan = via === "grant";
    // 번역 세션(#193): 이 대화가 고정한 대상으로만 번역 배치를 보낸다. 실패하면(시간 초과 포함) 세션을 끝내 늦게 온 배치도 보내지 않는다.
    let translationSession: string | null = null;
    const translationTabs: number[] = [];
    // 실행 전에 등록해야 번역 도중 중단해도 translate_stop이 이 탭에 간다.
    // 팝업 창을 기다리는 사이 중단·새 요청이 오면 실행하지 않는다. 번역 중 팝업이 닫히면 도구는 원래 탭으로 돌아가므로
    // 지금 탭과 원래 탭을 함께 등록한다(멈춤 요청은 번역하지 않은 탭에는 아무 일도 하지 않는다).
    if (toolName === "translate_page") {
      const current = await currentToolTab(turnTab);
      if (this.isStale(turn)) return false;
      if (current) translationTabs.push(current.tabId);
      if ("tabId" in turnTab) translationTabs.push(turnTab.tabId);
      // 승인 카드를 띄운 사이 설정에서 보낼 대상을 바꿨으면 번역하지 않는다(대화 대상과 지금 설정이 같아야 함).
      const now = activeModel(await getSettings());
      if (this.isStale(turn)) return false;
      if (this.targetChangedTurn === turn || targetKey(now) !== this.conversationTarget()) {
        this.targetChangedTurn = turn;
        failCall("설정에서 모델 제공자·API 키·모델·서버 주소가 바뀌어 번역하지 않았습니다.", argsKey);
        return true;
      }
      for (const tabId of translationTabs) this.translatedTabs.add(tabId);
      // 같은 탭의 앞 번역 세션은 끝낸다(새 번역이 대신한다 — 세션이 쌓여 다른 탭의 진행 중 세션을 밀어내지 않게).
      for (const tabId of translationTabs) {
        const old = this.translationSessions.get(tabId);
        if (old) endTranslationSession(old);
      }
      translationSession = beginTranslationSession({
        provider: this.provider,
        apiKey: this.apiKey ?? "",
        model: this.model ?? "",
        ...(this.baseUrl !== undefined ? { baseUrl: this.baseUrl } : {}),
        ready: true,
        missing: null,
      });
      for (const tabId of translationTabs) this.translationSessions.set(tabId, translationSession);
      execArgs = { ...(execArgs as object), session: translationSession };
    }
    const toolAbort = new AbortController();
    this.activeTool = toolAbort;
    // 외부 데이터를 가져오는 도구는 성공·실패와 관계없이(오류에도 파일 이름 등이 실린다) 결과를 문맥에 넣기 전에 보호를 켠다.
    // 같은 응답의 다음 도구 호출은 이 뒤에 순서대로 실행되므로 바로 적용된다.
    if (TOOL_POLICY[toolName].bringsExternal) {
      this.noteExternalContent(`외부 데이터를 가져오는 도구(${toolName})를 실행했습니다.`);
    }
    // 자동 로그인: 값을 넣기 시작하기 전에 시도를 기록한다(넣은 뒤 응답이 끊기거나 늦어도 같은 출처·단계를 다시 자동으로 하지 않게).
    if (auth.signInAttempt) this.loginAttempts.add(auth.signInAttempt);
    try {
      const result = await executeTool(toolName, execArgs, callId, turnTab, toolAbort.signal, {
        viaGrant: grantRan,
        ...(grantRan && auth.grantImages ? { grantImages: auth.grantImages } : {}),
        inputSession: this.inputSession,
        timeoutScale: providerAdapter(this.provider).timeoutScale,
      });
      if (this.isStale(turn)) return false;
      debugLog(
        "tool:result",
        `${toolName} ${result.ok ? "ok" : "fail"} · ${result.summary.slice(0, 140)}`,
      );
      this.send({
        kind: "tool_result",
        callId,
        toolName,
        ok: result.ok,
        summary: grantRan
          ? `이번 대화 허락으로 실행 · ${result.summary}`
          : via === "auto"
            ? `자동 실행 · ${result.summary}`
            : via === "task"
              ? `맡긴 작업 · ${result.summary}`
              : result.summary,
      });
      this.history.push({
        role: "tool",
        tool_call_id: call.modelCallId,
        name: toolName,
        content: this.toolContent(turnTab, { result: result.data }),
      });
      this.noteRebases(callId);
      // 클릭은 뒤따른 이동·화면 변화가 관측되면 같은 id를 다시 누르는 것('다음 달' 등)이 반복이 아니다.
      // 실패한 클릭(실제 입력이 도중에 막힘 등, #241)의 화면 변화는 반복 연속을 끊지 않는다.
      const changed =
        toolName === "click_element" &&
        clickChangedForSpin(result.ok, (result.data as { effect?: ClickEffectLike } | null)?.effect);
      call.record(toolName, argsKey, result.ok, `${result.ok ? "ok" : "fail"}:${JSON.stringify(result.data) ?? ""}`, result.summary, { changed });
      if (auth.internalNavSite && result.ok && !this.turnSite) {
        this.turnSite = auth.internalNavSite;
        debugLog("turn:site", `${auth.internalNavSite} (내부 페이지에서 요청 글의 사이트로 이동)`);
      }
      // 저장한 링크(사용자가 저장한 출처)를 열었으면 그 사이트를 이 대화에서 사용자가 고른 사이트로 둔다
      // (카드로 허락한 navigate_to_url과 같은 범위 — 이후 클릭·입력의 자동 실행 경계).
      if (toolName === "open_saved_link" && result.ok) {
        const site = siteOf(String((execArgs as { url?: unknown }).url ?? ""));
        if (site) this.approvedSites.add(site);
      }
    } catch (err) {
      // 번역이 실패하면(시간 초과 포함) 그 탭의 번역을 멈추고 세션을 끝낸다 — 늦게 온 배치 응답은 content의 번역 세대가 바뀌어 적용되지 않고,
      // 그 뒤 배치는 세션이 없어 어디로도 보내지 않는다(#193).
      if (translationSession) {
        endTranslationSession(translationSession);
        for (const tabId of translationTabs) {
          if (this.translationSessions.get(tabId) === translationSession) this.translationSessions.delete(tabId);
          // 그 탭이 이미 새 번역을 시작했으면 그 번역은 멈추지 않는다(세션이 같을 때만).
          chrome.tabs.sendMessage(tabId, { kind: "translate_stop", session: translationSession }).catch(() => {});
        }
      }
      if (this.isStale(turn)) return false;
      const msg = err instanceof Error ? err.message : String(err);
      // 턴 탭 해석(내부 페이지·닫힌 탭) 등 실행 전 단계에서 실패해도 결과 줄을 남긴다(#54).
      logToolFail(toolName, msg);
      failCall(msg, argsKey, grantRan ? `이번 대화 허락으로 실행 · ${msg}` : msg);
    } finally {
      if (this.activeTool === toolAbort) this.activeTool = null;
    }
    return true;
  }

  private async streamLoop(
    apiKey: string,
    model: ModelId,
    systemPrompt: string,
    turn: number,
  ): Promise<boolean> {
    // 이 요청의 탭. 도구가 기다리는 사이 새 요청이 this.turnTab을 바꿔도 이 요청의 실행·결과·정리는 이 탭(과 그 팝업)에만 한다.
    const turnTab = this.turnTab;
    const { maxToolHops } = await getSettings();
    // 이번 요청의 한도. 닿으면 이어 가기 카드로 묻고, 사용자가 허락하면 설정한 한도만큼 늘린다(#55).
    let limit = maxToolHops;
    // 이번 요청에서 실행을 마친 도구 호출(헛돌기 판정과 이어 가기 카드의 요약).
    const runs: ToolRunRecord[] = [];
    const record: RecordRun = (tool, argsKey, ok, result, summary, extra = {}) => {
      runs.push({ tool, argsKey, ok, resultKey: fingerprint(result), summary, changed: extra.changed === true, cancelled: extra.cancelled });
    };
    // 승인 카드를 연달아 띄워 습관적으로 허용하게 만드는 것을 막는다.
    const reads = { documents: 0, otherTabs: 0 };
    // 생각만 하다 응답 상한에 걸려 빈 답이 나오면 생각을 줄여 한 번 더 시도한다(턴마다 한 번).
    let lengthRetried = false;
    let lowReasoning = false;
    for (let hop = 0; ; hop += 1) {
      if (this.isStale(turn)) return false;
      // 한도에 닿음: 마지막 단계의 도구 결과까지 기록에 있다. 이어 가면 다음 요청이 그 결과를 보고, 그만두면
      // 도구 없이 지금까지의 결과로 답한다.
      if (hop >= limit) {
        const asked = await this.askToContinue(turn, hop, maxToolHops, runs);
        if (this.isStale(turn)) return false;
        if (!asked.proceed) {
          await this.finishWithoutTools(apiKey, model, systemPrompt, turn, asked.note);
          return false;
        }
        limit += maxToolHops;
      }
      debugLog("hop:start", `#${hop + 1}/${limit}`);

      this.send({ kind: "hop_progress", used: hop + 1, limit });
      const reply = await this.requestModel(apiKey, model, systemPrompt, turn, { lowReasoning });
      if (!reply) return false;
      const { assistantText, assistantReasoning, reasoningDetails, functionCalls, finishReason, thoughtChars } = reply;

      // 응답 상한에 걸렸는데 답도 도구 호출도 없으면, 기록에 남기지 않고 생각을 줄여 다시 묻는다.
      if (finishReason === "length" && functionCalls.length === 0 && !assistantText.trim()) {
        if (!lengthRetried) {
          lengthRetried = true;
          lowReasoning = true;
          debugLog("stream:length_retry", `thought=${thoughtChars}`, "warn");
          this.send({ kind: "status", text: "생각이 길어져 응답 한도에 걸렸습니다. 생각을 줄여 다시 시도하는 중…" });
          // 재시도는 도구 호출 순환 한도를 쓰지 않는다(마지막 순환에서도 실제로 다시 묻게).
          hop -= 1;
          continue;
        }
        throw new Error(
          "모델이 생각만 하다 응답 길이 한도에 걸려 답을 만들지 못했습니다. 요청을 나눠서 다시 보내거나 다른 모델을 골라 주세요.",
        );
      }

      this.commitNotes(reply);
      this.history.push({
        role: "assistant",
        content: assistantText || null,
        ...(functionCalls.length ? { tool_calls: functionCalls } : {}),
        ...(reasoningDetails.length
          ? { reasoning_details: reasoningDetails }
          : assistantReasoning
            ? { reasoning: assistantReasoning }
            : {}),
      });

      if (functionCalls.length === 0) {
        this.send({ kind: "status", text: null });
        this.send({ kind: "assistant_done", finishReason });
        if (finishReason === "length") {
          this.send({
            kind: "error",
            message: "답이 응답 길이 한도에서 잘렸습니다. \"이어서\"라고 보내면 계속 씁니다.",
          });
        }
        return true;
      }

      for (const fc of functionCalls) {
        if (this.isStale(turn)) return false;
        if (!(await this.handleCall(fc, turn, turnTab, record, reads))) return false;
        // 원격 대화에서 승인이 필요해 거절했으면 남은 호출을 하지 않고 도구 없이 답을 마무리한다.
        if (this.remoteRefusedTurn === turn) break;
      }
      if (this.remoteRefusedTurn === turn && !this.isStale(turn)) {
        this.history.push(...closeDanglingToolCalls(this.history));
        const stopNote = this.remoteStopReason === "unavailable" ? REMOTE_STOP_NOTE : `${remoteRefusal(this.remoteStopReason).note} 도구를 더 부르지 마라.`;
        await this.finishWithoutTools(apiKey, model, systemPrompt, turn, stopNote);
        return false;
      }

      // 헛돌기 감지(#55): 한도와 별개로, 같은 호출이 같은 결과로 되풀이되거나 한 도구가 거듭 실패하면 멈추고 알린다.
      if (this.isStale(turn)) return false;
      const spin = detectSpin(runs);
      if (spin) {
        debugLog("hop:spin", `${spin.kind} · ${spin.tool} ×${spin.count}`, "warn");
        const what =
          spin.kind === "repeat"
            ? `${spin.tool}를 같은 인자로 ${spin.count}번 연속 불렀지만 결과가 같고 화면도 바뀌지 않았습니다.`
            : `${spin.tool}가 성공 없이 ${spin.count}번 실패했습니다.`;
        this.send({ kind: "info", title: "같은 동작이 되풀이되어 멈춤", message: `${what} 단계를 더 쓰지 않고 지금까지의 결과로 답합니다.` });
        await this.finishWithoutTools(apiKey, model, systemPrompt, turn, spinStopNote(what));
        return false;
      }
    }
  }
}
