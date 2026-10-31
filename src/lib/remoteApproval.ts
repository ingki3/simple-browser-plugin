// 원격(텔레그램·MCP) 요청의 승인 질문(#185). 패널 카드의 글을 그대로 보내지 않는다 — 카드에는 원문 대상 글자(name·context)가
// 들어갈 수 있어서다. 원격 질문은 모델에 이미 보낸 글(modelName·modelContext)과 코드가 만든 고정 문구로만 만들고,
// 만들 수 없으면(허용하지 않는 도구, 잘린 대상, 너무 긴 주소) null — 그 호출은 묻지 않고 거절한다.
import { httpOrigin } from "./url.ts";
import { placeLine, roleLabel, type TargetInfo } from "./actionTarget.ts";

export const REMOTE_URL_MAX = 1000;
export const REMOTE_QUESTION_MAX = 2000;

// 원격 질문의 결과. cancelled: 사용자가 질문 창을 닫음(MCP), unavailable: 물을 수 없음(보내기 실패·설정 꺼짐·오류).
export type RemoteAskResult = "approved" | "denied" | "cancelled" | "expired" | "unavailable" | "aborted";

export interface RemoteQuestion {
  // 질문 글(평문). 승인하면 무엇이 실행되는지 끝까지 담는다(자르지 않는다).
  text: string;
}

export interface RemoteApprover {
  // 이번 요청에서 물을 수 있는지(설정·연결). 원격 안내 문구를 고르는 데 쓴다.
  canAsk(): boolean;
  ask(q: RemoteQuestion, signal: AbortSignal): Promise<RemoteAskResult>;
}

export interface RemoteToolInput {
  toolName: string;
  // navigate_to_url: 이동할 주소(미리보기 details).
  url?: string;
  // click_element: 대상(원격 질문 전용 remoteTarget)과 누르면 갈 수 있는 주소들(linkHrefs), 실제 도구 대상 탭의 주소.
  target?: TargetInfo;
  linkHrefs?: string[];
  pageUrl?: string;
  // 묻는 이유(패널 카드와 같은 고정 문구).
  guarded: boolean;
  block: string | null;
  chatGrantReason: string | null;
}

function reasonLines(input: RemoteToolInput): string[] {
  const out: string[] = [];
  if (input.chatGrantReason) out.push(`이번 대화 허락 예외: ${input.chatGrantReason}`);
  if (input.guarded) out.push("외부 문서 내용을 읽은 대화라 자동 실행하지 않음");
  if (input.block) out.push(`자동 실행 예외: ${input.block}`);
  return out;
}

function finish(lines: string[]): RemoteQuestion | null {
  const text = lines.join("\n");
  return text.length > REMOTE_QUESTION_MAX ? null : { text };
}

function checkedLine(t: TargetInfo): string | null {
  const c = t.states?.checked;
  if (c === undefined) return null;
  return `지금 상태: ${c === "true" ? "체크됨" : c === "mixed" ? "일부 체크" : "체크 안 됨"} (누르면 바뀝니다)`;
}

// 도구 호출의 원격 질문. 허용하는 도구는 이동·클릭뿐이다(그 밖은 이번 범위에서 묻지 않고 거절).
export function remoteToolQuestion(input: RemoteToolInput): RemoteQuestion | null {
  const why = reasonLines(input);
  if (input.toolName === "navigate_to_url") {
    const url = input.url ?? "";
    const origin = httpOrigin(url);
    if (!origin || url.length > REMOTE_URL_MAX) return null;
    return finish([
      "승인이 필요합니다: 페이지 이동",
      `주소: ${url}`,
      `사이트: ${origin}`,
      ...why,
      `승인하면 이 대화에서 ${origin}와 같은 사이트 안의 일반 이동·클릭·입력도 자동 실행 범위에 들어갑니다(결제·삭제·개인정보 등은 계속 묻습니다).`,
    ]);
  }
  if (input.toolName === "click_element") {
    const t = input.target;
    // 모델에 보낸 이름이 없거나 잘렸으면(뒤쪽이 달라도 같아 보임) 묻지 않는다. 원문 이름으로 대신하지 않는다.
    if (!t || !t.modelName || t.modelNameClipped || t.modelContextClipped) return null;
    const pageOrigin = input.pageUrl ? httpOrigin(input.pageUrl) : null;
    if (!pageOrigin) return null;
    // 누르면 갈 수 있는 주소가 링크 주소 하나뿐일 때만(양식 제출 주소 등은 입력값이 실릴 수 있어 원격으로 묻지 않는다).
    const hrefs = [...new Set((input.linkHrefs ?? []).filter(Boolean))];
    if (hrefs.some((h) => h !== t.href)) return null;
    if (t.href && t.href.length > REMOTE_URL_MAX) return null;
    const lines = ["승인이 필요합니다: 클릭", `페이지: ${pageOrigin}`, `대상: ${roleLabel(t)} '${t.modelName}'`, `위치: ${placeLine(t)}`];
    if (t.modelContext && t.modelContext !== t.modelName) lines.push(`행 내용: '${t.modelContext}'`);
    if (t.href) lines.push(`주소: ${t.href}`);
    const checked = checkedLine(t);
    if (checked) lines.push(checked);
    if (t.proxy) lines.push("⚠ 화면에 보이지 않는 체크·선택 칸을 대신 보여 주는 라벨입니다. 누르면 그 칸이 바뀝니다.");
    return finish([...lines, ...why]);
  }
  return null;
}

// 도구 호출 순환 한도의 원격 질문. 결과 글(recent — 제목·주소가 섞임)은 넣지 않고 수치와 도구별 횟수만.
export function remoteHopQuestion(h: {
  used: number;
  extra: number;
  total: number;
  failed: number;
  cancelled: number;
  byTool: ReadonlyArray<{ tool: string; count: number }>;
}): RemoteQuestion | null {
  const tools = h.byTool.map((t) => `${t.tool} ${t.count}회`).join(", ");
  return finish([
    `도구를 ${h.used}번 썼습니다. ${h.extra}번 더 진행할까요?`,
    `지금까지: 모두 ${h.total}회(실패 ${h.failed}, 취소 ${h.cancelled})${tools ? ` · ${tools}` : ""}`,
  ]);
}

// 원격 질문 결과별 도구 기록(모델에 돌려주는 오류 코드와 안내).
export function remoteRefusal(result: Exclude<RemoteAskResult, "approved" | "aborted">): { error: string; note: string; summary: string } {
  switch (result) {
    case "denied":
      return {
        error: "remote_user_denied",
        summary: "사용자가 원격에서 거절함",
        note: "사용자가 원격에서 이 동작을 거절했다. 같은 동작을 다시 시도하지 말고, 지금까지 한 일과 하지 않은 일을 짧게 답하라.",
      };
    case "cancelled":
      return {
        error: "remote_approval_cancelled",
        summary: "사용자가 승인 질문을 닫음",
        note: "사용자가 승인 질문을 닫았다(승인하지 않음). 같은 동작을 다시 시도하지 말고, 지금까지 한 일과 하지 않은 일을 짧게 답하라.",
      };
    case "expired":
      return {
        error: "remote_approval_expired",
        summary: "승인 응답이 없어 하지 않음",
        note: "승인 질문에 응답이 없어 이 동작을 하지 않았다. 다시 시도하지 말고, 지금까지 한 일과 다시 요청하면 이어서 할 수 있음을 짧게 답하라.",
      };
    case "unavailable":
      return { error: "remote_needs_approval", summary: "원격 요청이라 하지 않음", note: "" };
  }
}
