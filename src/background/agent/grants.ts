// 한 대화의 승인·허락 상태(#263 단계 6). ChatAgent가 대화마다 하나 만들고(새 대화·패널 닫힘·서비스 워커 재시작이면 객체째 새로),
// 저장소에 남기지 않는다. 승인 카드가 보여 준 제안(callId별)과, 사용자가 그 제안을 골라 받은 허락을 함께 둔다.
// 허락은 그 선택지를 보여 준 카드(제안)만 받아들인다 — 제안 없이 온 선택(오래된 카드·조작한 메시지)은 무시한다.
// 순수 상태다: chrome·저장소·패널 전송을 부르지 않고 debugLog만 쓴다. 패널 표시(chat_grants)는 ChatAgent가 보낸다.
// 지우는 곳: clearForCancel(ChatAgent.cancelInFlight — 턴 시작·abort), clearForReconnect(suspendForReconnect),
// takeCallOffers(카드 대기가 끝난 그 callId). 새 기록(ensureCredentials)은 허락을 지우지 않는다.
import { isChatGrantTool, type ChatGrants, type ChatGrantTool } from "@/lib/chatGrant";
import { debugLog } from "../debug";

export type LinkGrant = { turn: number; site: string };

// 승인 카드의 허락 선택지(approveTool의 인자).
export interface AcceptOptions {
  allowLinksThisTurn: boolean;
  allowToolThisChat: boolean;
  allowUrlsThisChat: boolean;
  rememberLoginSite: boolean;
}

// 승인 카드를 띄울 때 함께 보인 제안(askByCard가 넘긴다).
export interface CallOffers {
  turn: number;
  toolName: string;
  linkOffer: boolean;
  pageSite: string | null;
  urlOffer: boolean;
  personalUrlKeys: string[];
  loginOffer: string | null;
  signIn: { token: string } | undefined;
  chatGrantOffer: boolean;
  grantScope: string | undefined;
}

export class ConversationGrants {
  // 이 대화에서 승인 카드(또는 원격 질문)로 이동을 허락한 사이트와 사용자가 연 저장 링크의 사이트. 턴을 시작한 탭의 사이트와 함께
  // 자동 실행해도 되는 범위가 된다(turnSite는 ChatAgent).
  private approvedSites = new Set<string>();
  // 승인 카드에서 "이번 요청 동안 링크 이동 묻지 않기"를 고른 턴과 그 카드의 페이지 사이트. 턴 번호는 새 요청·중단마다
  // 바뀌므로 그 요청이 끝나면 저절로 쓰이지 않고, 대화 전체의 신뢰 사이트와 달리 그 사이트 안의 링크에만 쓴다.
  // 그 선택지를 보여 준 카드(callId → 턴·사이트)만 받아들인다.
  private _linkGrant: LinkGrant | null = null;
  private linkGrantOffers = new Map<string, LinkGrant>();
  // "이번 대화 동안 이 도구 묻지 않기"(#53): 허락한 도구 → 범위(download_images는 저장 폴더). 대화 객체와 함께 사라진다.
  // 링크 이동 허락(linkGrant)과는 대상 도구가 겹치지 않는다: 그쪽은 페이지 상태를 바꾸는 클릭이라 한 요청에만 쓴다.
  // 그 선택지를 보여 준 카드(callId → 도구·범위)만 받아들인다.
  private _chatGrants = new Map<ChatGrantTool, string>();
  private chatGrantOffers = new Map<string, { tool: ChatGrantTool; scope: string }>();
  // 승인 카드에서 "이 주소는 이번 대화에서 다시 묻지 않기"로 허용한 주소의 열쇠(personalUrlKey — 주소 글자 그대로,
  // 양식 제출 주소는 그 action).
  // 클릭·입력의 자동 실행 판정에서 이 주소들의 개인정보 주소 신호만 면제한다(사이트 경계·다른 신호는 그대로).
  // 그 선택지를 보여 준 카드(callId → 턴·주소)만 받아들인다.
  private _allowedPersonalUrls = new Set<string>();
  private personalUrlOffers = new Map<string, { turn: number; keys: string[] }>();
  // 자동 로그인(sign_in): 카드가 제안한 출처(호출별)와 사용자가 그 제안("앞으로 자동 로그인")을 고른 호출.
  // 이미 시도한 출처·값 가림(loginAttempts·secretsMasked)은 더 묻게 만드는 보호 상태라 ChatAgent에 둔다.
  private loginSiteOffers = new Map<string, string>();
  // 카드를 띄운 sign_in 호출의 준비 열쇠(signIn.ts의 token).
  private signInTokens = new Map<string, string>();
  private rememberLogin = new Set<string>();

  // 승인 판정(decideApproval) 입력. 복사하지 않고 같은 객체를 읽기 전용으로 넘긴다.
  get linkGrant(): LinkGrant | null {
    return this._linkGrant;
  }

  get allowedPersonalUrls(): ReadonlySet<string> {
    return this._allowedPersonalUrls;
  }

  get chatGrants(): ChatGrants {
    return this._chatGrants;
  }

  // 자동 실행 범위 계산용 복사본(호출한 쪽이 더해도 허락은 바뀌지 않는다).
  approvedSiteSet(): Set<string> {
    return new Set(this.approvedSites);
  }

  addApprovedSite(site: string): void {
    this.approvedSites.add(site);
  }

  signInToken(callId: string): string | undefined {
    return this.signInTokens.get(callId);
  }

  // 패널 표시(chat_grants)용 목록.
  chatGrantList(): Array<{ tool: ChatGrantTool; scope: string }> {
    return [...this._chatGrants].map(([tool, scope]) => ({ tool, scope }));
  }

  // 턴 시작·abort(cancelInFlight): 열린 카드의 허락 제안만 지운다. 받은 허락과 로그인 제안은 남긴다.
  clearForCancel(): void {
    this.linkGrantOffers.clear();
    this.chatGrantOffers.clear();
    this.personalUrlOffers.clear();
  }

  // 패널 연결이 끊겨 기록만 보관할 때(suspendForReconnect): 허용을 넓히는 상태를 모두 지운다.
  clearForReconnect(): void {
    this._chatGrants.clear();
    this.chatGrantOffers.clear();
    this.approvedSites.clear();
    this._linkGrant = null;
    this.linkGrantOffers.clear();
    this._allowedPersonalUrls.clear();
    this.personalUrlOffers.clear();
    this.rememberLogin.clear();
    this.loginSiteOffers.clear();
    this.signInTokens.clear();
  }

  // 승인 카드를 보낸 직후 그 카드가 보인 제안을 callId로 남긴다.
  recordOffers(callId: string, o: CallOffers): void {
    if (o.linkOffer && o.pageSite) this.linkGrantOffers.set(callId, { turn: o.turn, site: o.pageSite });
    if (o.urlOffer) this.personalUrlOffers.set(callId, { turn: o.turn, keys: o.personalUrlKeys });
    if (o.loginOffer) this.loginSiteOffers.set(callId, o.loginOffer);
    if (o.toolName === "sign_in" && o.signIn) this.signInTokens.set(callId, o.signIn.token);
    if (o.chatGrantOffer && isChatGrantTool(o.toolName)) {
      this.chatGrantOffers.set(callId, { tool: o.toolName, scope: o.grantScope ?? "" });
    }
  }

  // 카드 대기가 끝난 뒤(승인·취소·stale 모두) 그 callId의 제안을 지운다. "앞으로 자동 로그인"을 골랐으면 그 출처를 돌려준다.
  takeCallOffers(callId: string): { rememberOrigin?: string } {
    this.linkGrantOffers.delete(callId);
    this.chatGrantOffers.delete(callId);
    this.personalUrlOffers.delete(callId);
    const rememberOrigin = this.rememberLogin.has(callId) ? this.loginSiteOffers.get(callId) : undefined;
    this.loginSiteOffers.delete(callId);
    this.rememberLogin.delete(callId);
    this.signInTokens.delete(callId);
    return { rememberOrigin };
  }

  // 승인 카드의 허락 선택을 받는다(approveTool). 대기 중인 카드(pending)가 보인 제안만, 링크·주소 허락은 같은 턴의 제안만 받는다.
  // chatGrantAccepted: 대화 허락의 수락 조건을 채웠는지(값이 그대로여도 true — 패널 표시를 다시 보낸다).
  acceptOffers(
    callId: string,
    opts: AcceptOptions,
    ctx: { pending: boolean; currentTurn: number },
  ): { chatGrantAccepted: boolean } {
    if (opts.rememberLoginSite && ctx.pending && this.loginSiteOffers.has(callId)) {
      this.rememberLogin.add(callId);
    }
    const offer = this.linkGrantOffers.get(callId);
    if (opts.allowLinksThisTurn && ctx.pending && offer?.turn === ctx.currentTurn) {
      this._linkGrant = offer;
      debugLog("tool:link_grant", `turn ${offer.turn}`);
    }
    const urlOffer = this.personalUrlOffers.get(callId);
    if (opts.allowUrlsThisChat && ctx.pending && urlOffer?.turn === ctx.currentTurn) {
      for (const k of urlOffer.keys) this._allowedPersonalUrls.add(k);
      debugLog("tool:url_allow", `${urlOffer.keys.length}개 주소`);
    }
    const chatOffer = this.chatGrantOffers.get(callId);
    if (opts.allowToolThisChat && ctx.pending && chatOffer) {
      this._chatGrants.set(chatOffer.tool, chatOffer.scope);
      debugLog("tool:chat_grant", `${chatOffer.tool}${chatOffer.scope ? ` · ${chatOffer.scope}` : ""}`);
      return { chatGrantAccepted: true };
    }
    return { chatGrantAccepted: false };
  }

  // 패널에서 대화 허락을 취소한다. 지웠으면 true.
  revokeChatGrant(tool: string): boolean {
    return isChatGrantTool(tool) && this._chatGrants.delete(tool);
  }
}
