// 원격(텔레그램·MCP) 요청의 승인 질문(#185). 패널 카드의 글을 그대로 보내지 않는다 — 카드에는 원문 대상 글자(name·context)가
// 들어갈 수 있어서다. 원격 질문은 모델에 이미 보낸 글(modelName·modelContext)과 코드가 만든 고정 문구로만 만들고,
// 만들 수 없으면(허용하지 않는 도구, 잘린 대상, 너무 긴 주소) null — 그 호출은 묻지 않고 거절한다.
import { httpOrigin } from "./url.ts";
import { parseCheckedRequest, placeLine, REGION_LABELS, roleLabel, type TargetInfo } from "./actionTarget.ts";

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
  // 이 채널이 질문 앞에 붙일 고정 줄(#192 — MCP 요청을 텔레그램으로 물을 때 "[MCP 요청]"·요청 글 앞부분). 붙인 최종 글로 비밀 값·길이를 검사한다.
  prefix?: readonly string[];
  ask(q: RemoteQuestion, signal: AbortSignal): Promise<RemoteAskResult>;
}

// 원격 질문의 입력 칸 하나(#192): 대상은 모델에 보낸 글(modelName·modelContext)로만, 값은 모델이 넘긴 인자.
export interface RemoteField {
  target: TargetInfo;
  value: string;
}

// 원격 질문의 선택 카드(#192): 원격에서는 고를 수 없어 기본 선택만 묻는다. url은 스냅숏의 주소(모델이 넘긴 주소와 맞춘 것), note는 코드가 만든 경고.
export interface RemoteChoices {
  kind: "image" | "file" | "link";
  folder?: string;
  picks: Array<{ url: string; note: string }>;
}

export interface RemoteToolInput {
  toolName: string;
  // navigate_to_url: 이동할 주소(미리보기 details).
  url?: string;
  // click_element: 대상(원격 질문 전용 remoteTarget)과 누르면 갈 수 있는 주소들(linkHrefs), 실제 도구 대상 탭의 주소.
  target?: TargetInfo;
  linkHrefs?: string[];
  pageUrl?: string;
  // fill_form_fields(#192): 칸과 넣을 값.
  fields?: RemoteField[];
  // read_document(#192): 주소와 확장자가 있는 파일 링크인지.
  document?: { url: string; hasExtension: boolean };
  // capture_page(#192): 찍을 곳(코드 문구 — "지금 탭"·"따라가는 팝업 창")과 host, 전체 여부, 저장 폴더(실행과 같은 정리 값).
  capture?: { where: string; host: string; fullPage: boolean; folder: string };
  // download_images·download_files·read_linked_pages(#192): 기본 선택.
  choices?: RemoteChoices;
  // 묻는 이유. 원문(칸 이름 등)이 섞일 수 있는 글은 질문에 넣지 않고 있는지 여부만 고정 문구로 알린다(#192).
  guarded: boolean;
  block: string | null;
  chatGrantReason: string | null;
}

function reasonLines(input: RemoteToolInput): string[] {
  const out: string[] = [];
  if (input.guarded) out.push("외부 문서 내용을 읽은 대화라 자동 실행하지 않음");
  // 사유 글(autoApproveBlock·이번 대화 허락 예외)에는 페이지 원문 이름이 섞일 수 있어 그대로 보내지 않는다(#192).
  if (input.block || input.chatGrantReason) out.push("자동 실행 예외가 있어 묻습니다(자세한 이유는 브라우저 패널의 기록에서)");
  return out;
}

// 입력 질문의 칸 한 줄. 만들 수 없으면 null.
function fieldLine(f: RemoteField, nameCount: Map<string, number>): string | null {
  const t = f.target;
  // 결제 칸은 원격으로 묻지 않는다(값이 그대로 질문에 실린다). 이름이 없거나 잘린 칸, 선택지 트리거가 있는 칸도.
  if (t.sensitive === "payment" || !t.modelName || t.modelNameClipped || t.modelContextClipped || t.trigger) return null;
  const toggle = t.fieldType === "checkbox" || t.fieldType === "radio";
  // 체크·라디오와 이름이 겹치는 칸은 행 문맥이 있어야 어느 칸인지 안다(없으면 묻지 않음).
  const needRow = toggle || (nameCount.get(t.modelName) ?? 0) > 1;
  if (needRow && !t.modelContext) return null;
  const want = toggle ? parseCheckedRequest(f.value) : null;
  if (toggle && want === null) return null;
  const shown = t.sensitive === "password" ? `●(${f.value.length}자)` : toggle ? (want ? "☑ 체크" : "☐ 해제") : f.value;
  const where = [t.fieldType, REGION_LABELS[t.region]].filter(Boolean).join(", ");
  const row = needRow ? ` — 행: '${t.modelContext}'` : "";
  const warn = t.hidden ? " ⚠ 화면에 보이지 않는 칸" : t.proxy ? " ⚠ 보이는 라벨로 표시되는 칸" : "";
  return `• '${t.modelName}'${row} (${where}): ${shown}${warn}`;
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

// 도구 호출 한 번을 원격 질문에 보일 줄(제목·내용). 승인 효과·묻는 이유는 넣지 않는다(질문마다 다르다).
// 허용하는 도구는 이동·클릭과 #192의 입력·파일 읽기·캡처·이미지/파일 저장·링크 읽기이고, 만들 수 없으면 null(그 밖의 도구, 잘린 대상, 다른 목적지가 섞인 클릭, 긴 주소).
export function remoteActionLines(input: RemoteToolInput): { title: string; lines: string[]; origin: string } | null {
  if (input.toolName === "fill_form_fields") {
    const fields = input.fields ?? [];
    const pageOrigin = input.pageUrl ? httpOrigin(input.pageUrl) : null;
    if (!fields.length || !pageOrigin) return null;
    // 제출·요청 주소(입력값이 실려 다른 곳으로 갈 수 있음)가 있는 칸은 원격으로 묻지 않는다(클릭과 같은 기준).
    if ((input.linkHrefs ?? []).some(Boolean)) return null;
    const names = new Map<string, number>();
    for (const f of fields) names.set(f.target.modelName ?? "", (names.get(f.target.modelName ?? "") ?? 0) + 1);
    const lines = [`페이지: ${pageOrigin}${fields.some((f) => f.target.inFrame) ? " (프레임 안 칸 포함)" : ""}`, `입력 칸 ${fields.length}개`];
    for (const f of fields) {
      const line = fieldLine(f, names);
      if (!line) return null;
      lines.push(line);
    }
    return { title: "입력", lines, origin: pageOrigin };
  }
  if (input.toolName === "read_document") {
    const d = input.document;
    const origin = d ? httpOrigin(d.url) : null;
    if (!d || !origin || d.url.length > REMOTE_URL_MAX) return null;
    const lines = [`주소: ${d.url}`, `사이트: ${origin}`, "로그인 쿠키와 함께 받아 읽고, 읽은 내용은 모델 제공자로 갑니다."];
    if (!d.hasExtension) lines.push("⚠ 확장자가 없는 링크라 파일이 아닌 다른 동작(로그아웃·삭제·신청 등)을 하는 주소일 수도 있습니다.");
    return { title: "파일 읽기", lines, origin };
  }
  if (input.toolName === "capture_page") {
    const c = input.capture;
    if (!c || !c.host) return null;
    return {
      title: "화면 캡처",
      lines: [
        `${c.where}(${c.host})의 ${c.fullPage ? "페이지 전체" : "보이는 화면"}를 캡처해 '${c.folder}/' 폴더에 PNG로 저장합니다.`,
        "화면에 보이는 내용(입력한 값·개인정보 포함)이 이미지에 담깁니다. 이미지는 이 기기에만 저장하고 모델 제공자로 보내지 않습니다.",
      ],
      origin: c.host,
    };
  }
  if (input.toolName === "download_images" || input.toolName === "download_files" || input.toolName === "read_linked_pages") {
    const c = input.choices;
    if (!c || !c.picks.length || c.picks.some((p) => !httpOrigin(p.url) || p.url.length > REMOTE_URL_MAX)) return null;
    const head =
      c.kind === "link"
        ? ["로그인 쿠키 없이 받아 본문을 읽고, 읽은 내용은 모델 제공자로 갑니다."]
        : c.kind === "file"
          ? [`로그인 쿠키와 함께 받아 '${c.folder ?? ""}/' 폴더에 저장합니다.`]
          : [`로그인 쿠키와 함께 받아(리다이렉트를 따를 수 있음) '${c.folder ?? ""}/' 폴더에 저장합니다.`];
    const lines = [...head, `원격에서는 고를 수 없어 기본 선택 ${c.picks.length}개만 합니다:`, ...c.picks.map((p) => `- ${p.url}${p.note ? ` (${p.note})` : ""}`)];
    const title = c.kind === "link" ? "링크 읽기" : c.kind === "file" ? "파일 받기" : "이미지 저장";
    return { title, lines, origin: httpOrigin(c.picks[0].url) ?? "" };
  }
  if (input.toolName === "navigate_to_url") {
    const url = input.url ?? "";
    const origin = httpOrigin(url);
    if (!origin || url.length > REMOTE_URL_MAX) return null;
    return { title: "페이지 이동", lines: [`주소: ${url}`, `사이트: ${origin}`], origin };
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
    const lines = [`페이지: ${pageOrigin}`, `대상: ${roleLabel(t)} '${t.modelName}'`, `위치: ${placeLine(t)}`];
    if (t.modelContext && t.modelContext !== t.modelName) lines.push(`행 내용: '${t.modelContext}'`);
    if (t.href) lines.push(`주소: ${t.href}`);
    const checked = checkedLine(t);
    if (checked) lines.push(checked);
    if (t.proxy) lines.push("⚠ 화면에 보이지 않는 체크·선택 칸을 대신 보여 주는 라벨입니다. 누르면 그 칸이 바뀝니다.");
    return { title: "클릭", lines, origin: pageOrigin };
  }
  return null;
}

// 도구 호출의 원격 질문(#185 이동·클릭, #192 입력·파일 읽기·캡처·저장·링크 읽기). 그 밖은 묻지 않고 거절.
export function remoteToolQuestion(input: RemoteToolInput): RemoteQuestion | null {
  const action = remoteActionLines(input);
  if (!action) return null;
  const why = reasonLines(input);
  if (input.toolName === "navigate_to_url") {
    return finish([
      `승인이 필요합니다: ${action.title}`,
      ...action.lines,
      ...why,
      `승인하면 이 대화에서 ${action.origin}와 같은 사이트 안의 일반 이동·클릭·입력도 자동 실행 범위에 들어갑니다(결제·삭제·개인정보 등은 계속 묻습니다).`,
    ]);
  }
  return finish([`승인이 필요합니다: ${action.title}`, ...action.lines, ...why]);
}

// 채널의 고정 줄(prefix)을 앞에 붙인 최종 질문(#192). 합친 글이 상한을 넘으면 null(묻지 않음 — 자르지 않는다).
export function withPrefix(q: RemoteQuestion, prefix: readonly string[] | undefined): RemoteQuestion | null {
  if (!prefix?.length) return q;
  return finish([...prefix, q.text]);
}

// 원격 작업 하나에 물을 수 있는 질문 수(MCP 다리의 상한과 같게, #192 — 텔레그램으로 위임해 물을 때도 센다).
export const REMOTE_ASKS_PER_JOB = 20;

export const REMOTE_TASK_REQUEST_MAX = 500;

// 작업 맡기기의 원격 질문(텔레그램 — 실행 방식 '처음에 승인 받고 끝까지 실행'). request: 사용자가 그 채팅으로 보낸 요청 글,
// plan·risks: 모델이 confirm_task로 넘긴 글(모델 출력). firstAction: 모델이 confirm_task 없이 승인이 필요한 동작을 불렀을 때
// 그 동작(remoteActionLines). 할 일·위험은 자르지 않는다(무엇을 맡기는지가 잘리면 안 된다) — 넘치면 null.
export function remoteTaskQuestion(input: {
  request: string;
  plan: string;
  risks: readonly string[];
  firstAction?: { title: string; lines: string[] } | null;
}): RemoteQuestion | null {
  const req = input.request.trim();
  const request = req.length > REMOTE_TASK_REQUEST_MAX ? `${req.slice(0, REMOTE_TASK_REQUEST_MAX)}…` : req;
  const lines = ["승인이 필요합니다: 작업 맡기기", `요청: ${request}`];
  if (input.plan.trim()) lines.push(`할 일: ${input.plan.trim()}`);
  const risks = input.risks.map((r) => r.trim()).filter(Boolean);
  lines.push(risks.length ? "이 작업의 위험:" : "이 작업의 위험: 모델이 따로 적지 않음");
  for (const r of risks) lines.push(`- ${r}`);
  if (input.firstAction) lines.push(`첫 동작: ${input.firstAction.title}`, ...input.firstAction.lines);
  lines.push(
    "승인하면 이 요청이 끝날 때까지 이동·클릭·입력·저장을 묻지 않고 실행합니다(결제·삭제·다른 사이트로 이동도 묻지 않습니다). 자동 로그인·저장한 링크 열기·반복 작업 등록은 원격에서 하지 않습니다. 멈추려면 /stop.",
  );
  return finish(lines);
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
