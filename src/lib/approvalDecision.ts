// 민감 도구 호출의 승인 판정(#90). streamLoop에서 꺼낸 순수 함수다: 탭 주소·내부 페이지 여부·설정처럼 조회가 필요한
// 값은 부르는 쪽이 미리 구해 넘기고, 이 함수는 카드를 띄울지·자동 실행할지·손 넘기기할지와 카드에 함께 보일 제안만 정한다.
// 규칙(우선순위 순):
// 1. 직접 조작할 사이트(0.2.2)의 클릭·입력 → handoff(실행하지 않고 사용자에게 넘김)
// 2. 이번 대화 허락(#53)으로 덮이는 호출 → grant
// 3. 자동 실행(설정 또는 이번 요청 링크 이동 허락 #28)이고 막는 이유(block)가 없으면 → auto
// 4. 그 밖 → card
// 외부 본문 보호 중(guarded, #37)에는 자동 실행·링크 허락을 쓰지 않는다. 되돌리기 어려운 동작(#62, alwaysAsk)은 링크 허락·
// 대화 허락으로도 건너뛰지 않는다.
import type { TargetInfo } from "./actionTarget.ts";
import { autoApproveBlock, grantableLink } from "./autoApprove.ts";
import { chatGrantDecision, type ChatGrantDecision, type ChatGrants } from "./chatGrant.ts";
import type { ToolName } from "./messages.ts";
import { internalNavigateAutoBlock, navigateAutoBlock, pageActionSiteBlock, siteOf } from "./siteTrust.ts";

// 승인 판정에 쓰는 미리보기 필드(background/tools/dispatcher.ts ToolPreview의 부분집합).
export interface ApprovalPreview {
  details?: unknown;
  autoBlock?: string | null;
  alwaysAsk?: string | null;
  linkHrefs?: string[];
  fillValues?: string[];
  baseUrls?: string[];
  clickTarget?: TargetInfo;
  grantBlock?: string | null;
  grantScope?: string;
  personalUrlKeys?: string[];
  autoBlockIfUrlsAllowed?: string | null;
}

export interface ApprovalInput {
  toolName: ToolName;
  preview: ApprovalPreview;
  // 외부 본문 보호 중이라 이 도구에 승인이 필요한지(needsApprovalWhenProtected).
  guarded: boolean;
  // 설정의 자동 실행.
  autoApprove: boolean;
  // 클릭·입력 대상 페이지 주소(따라가는 팝업이면 그 창). 그 밖의 도구는 undefined.
  pageUrl?: string;
  // 지금 페이지가 사용자가 고른 '직접 조작할 사이트'인지(isManualSite).
  manualSite: boolean;
  // 이 대화에서 자동 실행해도 되는 사이트(카드로 허락한 이동의 출처 + 이 턴의 사이트).
  trusted: ReadonlySet<string>;
  turn: number;
  // 이번 요청 링크 이동 허락(#28): 허락한 턴과 그 페이지의 출처.
  linkGrant: { turn: number; site: string } | null;
  // 턴 탭이 내부 페이지(새 탭·설정)에서 하는 이동인지(#54).
  fromInternal: boolean;
  // 요청 글에 사용자가 적은 사이트(#54).
  namedSites: Iterable<string>;
  // 이번 대화에서 다시 묻지 않기로 한 개인정보 모양 주소 열쇠.
  allowedPersonalUrls: ReadonlySet<string>;
  // 이번 대화 허락(#53).
  chatGrants: ChatGrants;
}

export type ApprovalMode = "handoff" | "grant" | "auto" | "card";

export interface ApprovalDecision {
  mode: ApprovalMode;
  // 자동 실행 모드(설정 또는 링크 허락, 보호 중이 아님).
  autoMode: boolean;
  // 자동 실행을 막는 이유(카드에 "자동 실행 예외"로 보임). 없으면 null.
  block: string | null;
  // 카드에 "이번 요청 동안 링크 이동 묻지 않기"를 제안하는지, 이 호출이 그 허락으로 실행되는지.
  linkOffer: boolean;
  linkGranted: boolean;
  // 카드에 "이 개인정보 모양 주소는 이번 대화에서 다시 묻지 않기"를 제안하는지.
  urlOffer: boolean;
  // 지금 페이지의 사이트(링크 허락을 보관할 출처).
  pageSite: string | null;
  chatGrant: ChatGrantDecision;
}

const isPageAction = (tool: ToolName) => tool === "click_element" || tool === "fill_form_fields";

export function decideApproval(input: ApprovalInput): ApprovalDecision {
  const { toolName, preview, guarded, pageUrl, trusted, turn } = input;
  const handOff = isPageAction(toolName) && input.manualSite;
  // 클릭·입력은 지금 페이지와 링크·입력값이 사용자가 고른 사이트 안일 때만 자동 실행한다. 상대 주소 입력값은 탭 주소와
  // 페이지가 실제로 쓰는 기준 주소(<base href>) 모두로 풀어 본다.
  const siteBlock = (sites: ReadonlySet<string>): string | null => {
    for (const base of [pageUrl, ...(preview.baseUrls ?? [])]) {
      const why = pageActionSiteBlock(sites, base, preview.linkHrefs ?? [], preview.fillValues ?? []);
      if (why) return why;
    }
    return null;
  };
  // 구조상 일반 링크이고 지금 페이지와 같은 사이트 안으로 가는 클릭이면 링크 이동 허락을 제안한다. 사이트 경계는 대화 전체의
  // 신뢰 사이트가 아니라 지금 페이지의 사이트 하나로만 본다. 되돌리기 어려운 동작은 제안하지도 쓰지도 않는다.
  const pageSite = pageUrl ? siteOf(pageUrl) : null;
  const linkOffer =
    !guarded &&
    !preview.alwaysAsk &&
    toolName === "click_element" &&
    !!pageSite &&
    !!preview.clickTarget &&
    grantableLink(preview.clickTarget, pageUrl) &&
    siteBlock(new Set([pageSite])) === null;
  // 허락은 최초 승인 페이지의 출처로 보관하고, 지금 페이지와 목적지가 그 출처의 같은 사이트 안일 때만 쓴다.
  const grant = input.linkGrant;
  const linkGranted = linkOffer && !!grant && grant.turn === turn && siteBlock(new Set([grant.site])) === null;
  const autoMode = !guarded && (input.autoApprove || linkGranted);
  // 개인정보 모양만 걸린 주소를 모두 이번 대화에서 허용했으면 그 신호를 뺀 판정을 쓴다.
  const personalUrlKeys = preview.personalUrlKeys ?? [];
  const urlsAllowed = personalUrlKeys.length > 0 && personalUrlKeys.every((k) => input.allowedPersonalUrls.has(k));
  const target = String(preview.details ?? "");
  let block: string | null = preview.alwaysAsk
    ? preview.alwaysAsk
    : linkGranted
      ? null
      : toolName === "navigate_to_url"
        ? input.fromInternal
          ? internalNavigateAutoBlock(trusted, input.namedSites, target)
          : navigateAutoBlock(trusted, target)
        : preview.autoBlock !== undefined
          ? urlsAllowed && preview.autoBlockIfUrlsAllowed !== undefined
            ? preview.autoBlockIfUrlsAllowed
            : preview.autoBlock
          : autoApproveBlock(toolName, []);
  // 링크 허락으로 실행하는 클릭은 위에서 지금 페이지의 사이트 안인지 이미 봤다.
  if (autoMode && !linkGranted && !block && isPageAction(toolName)) block = siteBlock(trusted);
  // 카드가 뜨는 이유가 개인정보 모양 주소뿐이면 그 주소를 이번 대화에서 다시 묻지 않는 선택지를 함께 보인다.
  const urlOffer =
    autoMode &&
    !linkGranted &&
    !preview.alwaysAsk &&
    !urlsAllowed &&
    personalUrlKeys.length > 0 &&
    preview.autoBlockIfUrlsAllowed === null &&
    isPageAction(toolName) &&
    siteBlock(trusted) === null;
  const chatGrant = chatGrantDecision(input.chatGrants, {
    tool: toolName,
    protected: guarded,
    // 늘 묻는 동작은 이번 대화 허락으로도 덮지 않는다.
    block: preview.alwaysAsk ?? preview.grantBlock ?? null,
    scope: preview.grantScope ?? "",
  });
  const base = { autoMode, block, linkOffer, linkGranted, urlOffer, pageSite, chatGrant };
  return { ...base, mode: modeOf(handOff, base) };
}

// 이번 대화 허락을 쓰지 못하게 됐을 때(허락으로 저장할 이미지를 미리 받지 못함) 그 이유로 다시 정한다.
export function withoutChatGrant(d: ApprovalDecision, reason: string): ApprovalDecision {
  const next = { ...d, chatGrant: { covered: false, offer: false, reason } };
  return { ...next, mode: modeOf(d.mode === "handoff", next) };
}

function modeOf(handOff: boolean, d: Omit<ApprovalDecision, "mode">): ApprovalMode {
  if (handOff) return "handoff";
  if (d.chatGrant.covered) return "grant";
  if (d.autoMode && !d.block) return "auto";
  return "card";
}
