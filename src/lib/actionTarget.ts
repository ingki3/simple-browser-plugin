// 조작 도구(클릭·입력)의 공통 경로: 대상 기술 → 실행 직전 확인 → 승인 카드 → 결과 확인.
// 여기에는 DOM 없이 계산하는 부분만 둔다(비교·문구·이동 판정). DOM 쪽은 src/content/targets.ts.

import type { PageRegion } from "./messages";

// 대상 요소를 사람이 알아볼 수 있게 적은 것. find_* 때 기록하고, 승인 카드와 실행 직전 확인에 쓴다.
export interface TargetInfo {
  tag: string;
  role: string;
  // 클릭 대상은 보이는 글자, 입력 칸은 label(원문 — 비교·승인 카드용, 모델에는 보내지 않는다).
  name: string;
  // 모델에 돌려준 이름(입력값·편집 영역·숨은 글자를 뺀 것). 모델이 본 근거가 바뀌어도 다른 대상으로 본다.
  modelName?: string;
  // 링크의 절대 주소. 링크가 아니면 "".
  href: string;
  region: PageRegion;
  // 같은 출처 iframe 안의 요소면 true.
  inFrame: boolean;
  // 입력 칸의 종류(text, password, select …). 클릭 대상은 "".
  fieldType: string;
  // 결제·비밀번호처럼 값을 보여 줄 때 조심해야 하는 칸.
  sensitive: "password" | "payment" | null;
  // 대상이 든 목록 항목(행)의 글자. 목록 밖이면 "". 같은 버튼 노드를 다른 행에 다시 쓰는 목록에서 행이 바뀐 것을 잡는다.
  context: string;
  // 모델에 돌려준 묶음 문맥(행 글자를 modelText로 만든 것, 구조로 찾은 표제를 앞에). 클릭 대상과 입력 칸(#56).
  // 모델의 선택 근거라 비교한다.
  modelContext?: string;
  // 화면에서 숨긴 checkbox·radio를 구조로 연결된 보이는 label을 눌러 바꾸는 칸(#56). 그 label이 사라지거나
  // 칸이 보이게 되면 다른 대상으로 본다.
  proxy?: boolean;
  // 대상의 ARIA·HTML 상태(aria-selected·aria-checked·aria-pressed·aria-expanded·aria-current·aria-disabled·disabled).
  // 클릭 대상만. 승인 뒤 상태가 바뀌면(이미 체크됨·이미 펼쳐짐) 누르면 반대로 되므로 다른 대상으로 본다.
  states?: Record<string, string>;
  // 선택지(option·menuitem*)를 펼친 트리거와의 관계 확인 상태(linked: aria-controls/owns로 연결, unlinked: 펼쳐진 트리거 0~1개).
  // 관계 자체(요소 참조)는 content script에만 두고 실행 직전에 따로 다시 확인한다.
  popup?: "linked" | "unlinked";
  // 그 트리거(있으면)의 기술과 위험 정보. 승인·사이트 판정은 선택지와 트리거 양쪽을 따로 본다. 모델에는 보내지 않는다.
  trigger?: TargetInfo;
  // 그 트리거 자신이 다른 목록 안의 항목(중첩 메뉴)이면 true. 상위 트리거들의 위험은 따라가지 않으므로 자동 실행하지 않는다.
  nestedPopup?: boolean;
  // 같은 틀의 형제가 3개 이상인 목록 안이면 항목 순번(1부터)과 항목 수. 승인 카드를 띄울 때 계산한다.
  // semantic은 ul·ol·표·role=list 같은 목록 표시가 있는지. 없으면 나란히 놓인 버튼 몇 개일 수도 있어,
  // 카드에는 목록 표시가 있거나 항목이 5개 이상일 때만 보여 준다(확인에는 늘 쓴다).
  list?: { index: number; count: number; semantic: boolean } | null;
  // 승인 카드에 경고만 하는 표시(비교에는 쓰지 않음): 화면에 보이지 않는 입력 칸.
  hidden?: boolean;
  // 자동 실행 예외 판정용(비교에는 쓰지 않음, 대상 확인 때 계산).
  // personal: 이름·연락처·주소·생년월일 같은 개인정보 칸. submitsPersonal: 개인정보·비밀번호·결제 값이 채워진 양식을 제출하는 버튼.
  personal?: boolean;
  submitsPersonal?: boolean;
  // 결제 화면(주소·제목이나 버튼이 든 양식·대화상자의 글자에 결제 단서)의 버튼. 저장된 카드로 '확인'만 누르면 결제되는 화면을 잡는다.
  paymentContext?: boolean;
  // 양식 안 버튼이면 그 양식이 제출되는 주소(formaction 또는 form action을 절대 주소로). 사이트 경계 판정용.
  submitTo?: string;
  // 지금 칸 값으로 제출하면 요청하는 주소(action + 칸 값 쿼리). 값에 실린 바깥 주소(리다이렉트 매개변수) 판정용.
  submitUrl?: string;
  // 선택 칸의 선택지 값 중 주소처럼 보이는 것(절대 주소로 푼 것). 사이트 경계 판정용.
  choiceUrls?: string[];
  // 양식 밖 대상이 처리기로 제출할 수 있는 범위 안 다른 양식들의 제출 주소(사이트 경계·민감 주소 판정용).
  scopeSubmitUrls?: string[];
  // 범위 안 모든 양식의 action(결제·개인정보 주소 판정용, 사이트 경계는 보지 않음).
  scopeFormActions?: string[];
  // 양식 안 입력 칸 주변 범위의 다른 양식 action(사이트 경계와 결제·개인정보 주소를 본다).
  aroundFormActions?: string[];
  // 입력 칸의 name(승인 당시). 처리기가 이름을 바꿔(q → payment) 제출 매개변수를 바꾸지 못하게 비교한다.
  fieldName?: string;
  // 입력 칸 문서의 기준 주소(document.baseURI). 처리기가 상대 주소 입력값을 이 기준으로 풀 수 있다.
  baseUri?: string;
  // 대상 링크의 ping 주소들(사이트 경계·민감 주소 판정용).
  pingUrls?: string[];
  // 대상이 링크 안의 요소면 그 링크 주소(누르면 바깥 링크가 열린다). 사이트 경계 판정용.
  ancestorHref?: string;
  // 대상이 버튼·링크 안의 요소면 실제로 작동하는 그 바깥 버튼·링크의 글자. 결제·제출 문구 판정용.
  outerText?: string;
  // 대상이 클릭 이벤트 경로의 다른 컨트롤(버튼·버튼 역할·summary·label·인라인 onclick) 안에 있는지.
  insideControl?: boolean;
  // 대상이나 감싼 링크에 download 속성이 있는지(누르면 파일을 내려받는다).
  download?: boolean;
  // 승인한 입력 묶음에 개인정보·비밀번호·결제 칸이 있었는지(그런 묶음은 늘 카드로 승인받는다).
  // 그렇다면 묶음 안의 앞선 입력이 양식을 "개인정보가 채워진 양식"으로 만드는 것은 승인한 변화로 본다.
  consentPersonal?: boolean;
  // 그 예외를 준 승인 호출(content script가 허용한 칸 목록을 찾는 키).
  consentCall?: string;
}

// find_* 때와 같은 요소인지: 목록 위치를 뺀 기본 항목이 모두 같아야 한다.
export function sameBase(a: TargetInfo, b: TargetInfo): boolean {
  return (
    a.tag === b.tag &&
    a.role === b.role &&
    a.name === b.name &&
    (a.modelName ?? "") === (b.modelName ?? "") &&
    a.href === b.href &&
    a.region === b.region &&
    a.inFrame === b.inFrame &&
    a.fieldType === b.fieldType &&
    a.sensitive === b.sensitive &&
    a.context === b.context &&
    (a.modelContext ?? "") === (b.modelContext ?? "") &&
    !!a.proxy === !!b.proxy &&
    statesKey(a.states) === statesKey(b.states)
  );
}

export function statesKey(s: Record<string, string> | undefined): string {
  if (!s) return "";
  return Object.keys(s)
    .sort()
    .map((k) => `${k}=${s[k]}`)
    .join(";");
}

// 승인한 대상과 같은지: 기본 항목에 더해 목록 순번도 같아야 한다(항목 수는 더 불러오면 늘 수 있어 보지 않는다).
export function sameApproved(a: TargetInfo, b: TargetInfo): boolean {
  return sameBase(a, b) && (a.list?.index ?? null) === (b.list?.index ?? null);
}

// 입력 도중(입력 처리기가 돈 뒤 change 전, 채운 뒤 반영 확인)의 비교(#56). 원문 행 글자(context)가 그대로면
// 모델용 행 문맥(modelContext)만 바뀐 것은 같은 대상으로 본다 — 행 안에 이미 있던 숨은 안내 글(입력 형식 오류 등)이
// 입력 처리기로 보이게 되면 모델용 글자만 달라진다(#43 C의 오탐을 늘리지 않게). 승인 카드·실행 직전 비교는 sameApproved.
export function sameApprovedInFlight(now: TargetInfo, approved: TargetInfo): boolean {
  if (now.context !== approved.context) return false;
  return sameApproved({ ...now, modelContext: approved.modelContext }, approved);
}

// 서로 다른 항목을 사람이 읽을 수 있게 하나 고른다(실패 메시지용 — 모델에도 간다).
// 글자는 모델에 돌려준 이름(modelName)만 인용한다. 원문 이름에는 입력 칸·편집 영역의 글자가 섞일 수 있다.
export function describeDifference(before: TargetInfo, after: TargetInfo): string {
  if ((before.modelName ?? "") !== (after.modelName ?? "")) {
    return `글자가 '${clip(before.modelName ?? "", 40)}' → '${clip(after.modelName ?? "", 40)}'`;
  }
  if (before.name !== after.name) return "글자가 바뀜";
  if (before.href !== after.href) return "링크 주소가 바뀜";
  if (before.tag !== after.tag || before.role !== after.role) return "요소 종류가 바뀜";
  if (before.fieldType !== after.fieldType || before.sensitive !== after.sensitive) return "입력 칸 종류가 바뀜";
  if (before.region !== after.region) return "페이지 영역이 바뀜";
  if (before.context !== after.context || (before.modelContext ?? "") !== (after.modelContext ?? "")) {
    return "대상이 든 행의 내용이 바뀜";
  }
  if (statesKey(before.states) !== statesKey(after.states)) return "대상의 상태(선택·체크·펼침 등)가 바뀜";
  if (!!before.proxy !== !!after.proxy) return "칸을 바꾸는 보이는 라벨이 바뀜";
  if ((before.list?.index ?? null) !== (after.list?.index ?? null)) return "목록 안 순서가 바뀜";
  return "요소 속성이 바뀜";
}

const ROLE_LABELS: Record<string, string> = {
  link: "링크",
  button: "버튼",
  tab: "탭",
  menuitem: "메뉴 항목",
  checkbox: "체크박스",
  radio: "라디오 버튼",
  switch: "스위치",
  option: "선택 항목",
  combobox: "선택 상자",
  textbox: "입력 칸",
  searchbox: "검색 칸",
};

const REGION_LABELS: Record<PageRegion, string> = {
  main: "본문",
  article: "글",
  nav: "메뉴",
  aside: "옆 영역",
  header: "머리글",
  footer: "바닥글",
  other: "기타 영역",
};

export function roleLabel(info: TargetInfo): string {
  if (ROLE_LABELS[info.role]) return ROLE_LABELS[info.role];
  if (info.tag === "a") return "링크";
  if (info.tag === "button" || info.tag === "input") return "버튼";
  return "요소";
}

function placeLine(info: TargetInfo): string {
  const parts = [REGION_LABELS[info.region]];
  if (info.list && (info.list.semantic || info.list.count >= 5)) {
    parts.push(`목록 ${info.list.count}개 중 ${info.list.index}번째`);
  }
  if (info.inFrame) parts.push("페이지 안 프레임");
  return parts.join(" · ");
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// 클릭 승인 카드.
export function clickCard(info: TargetInfo): { summary: string; details: string } {
  const label = roleLabel(info);
  const name = info.name ? `'${clip(info.name, 60)}'` : "(글자 없음)";
  const lines = [`대상: ${label} ${name}`, `위치: ${placeLine(info)}`];
  if (info.context && info.context !== info.name) lines.push(`행 내용: '${clip(info.context, 100)}'`);
  if (info.href) lines.push(`주소: ${clip(info.href, 300)}`);
  if (info.trigger) lines.push(`열린 목록의 트리거: ${roleLabel(info.trigger)} '${clip(info.trigger.name, 60)}'`);
  // 체크 위젯(role=checkbox·switch·radio, menuitemcheckbox 등)은 지금 상태를 보여 준다(누르면 반대로 바뀐다).
  const checked = info.states?.checked;
  if (checked !== undefined) lines.push(`지금 상태: ${checked === "true" ? "체크됨" : checked === "mixed" ? "일부 체크" : "체크 안 됨"}`);
  if (!info.name) lines.push("⚠ 글자가 없는 요소입니다. 무엇을 누르는지 확인하기 어렵습니다.");
  return { summary: `${label} ${name}을(를) 클릭합니다.`, details: lines.join("\n") };
}

const TRUTHY_VALUES = /^(true|1|on|yes|y|checked|check|예|네|체크|선택)$/i;

// checkbox·radio에 넣을 값의 해석(실행·기대 상태·최종 확인·승인 카드가 함께 쓴다). 참 = 기존 참 값, 거짓 = "false",
// 그 밖은 null(지정 오류). 칸의 value 속성과는 비교하지 않는다(#43 — 모델은 value를 모르고, value가 "false"인
// 칸에 거짓 요청이 체크로 처리되지 않게).
export function parseCheckedRequest(value: string): boolean | null {
  const v = value.trim();
  if (TRUTHY_VALUES.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return null;
}

// 입력 승인 카드. 비밀번호 칸은 값을 가리고 글자 수만 보여 준다.
// 이름 없는 칸이나 묶음 안에서 이름이 겹치는 칸(메일 목록의 행 체크박스)은 행 문맥을 함께 보여 준다(#56).
export function fillCard(
  items: Array<{ info: TargetInfo; value: string }>,
): { summary: string; details: string } {
  const nameCount = new Map<string, number>();
  for (const { info } of items) nameCount.set(info.name, (nameCount.get(info.name) ?? 0) + 1);
  const shown = items.slice(0, 10).map(({ info, value }) => {
    const name = info.name ? clip(info.name, 40) : "(이름 없는 칸)";
    // 행 문맥은 모델에 돌려준 글자(modelContext)를 쓴다(입력값·편집 영역·숨은 글자 제외).
    const row = (!info.name || (nameCount.get(info.name) ?? 0) > 1) && info.modelContext ? ` — 행: '${clip(info.modelContext, 60)}'` : "";
    const toggle = info.fieldType === "checkbox" || info.fieldType === "radio";
    const want = toggle ? parseCheckedRequest(value) : null;
    const shownValue =
      info.sensitive === "password"
        ? `${"●".repeat(Math.min(value.length, 8))} (${value.length}자)`
        : want === true
          ? "☑ 체크"
          : want === false
            ? "☐ 해제"
            : clip(value, 80);
    let warn =
      info.sensitive === "password" ? " ⚠ 비밀번호 칸" : info.sensitive === "payment" ? " ⚠ 결제 정보 칸" : "";
    if (info.hidden) warn += info.proxy ? " ⚠ 화면에 보이지 않는 칸(보이는 라벨을 눌러 바꿈)" : " ⚠ 화면에 보이지 않는 칸";
    const where = [info.fieldType, REGION_LABELS[info.region]];
    if (info.inFrame) where.push("프레임 안");
    return `• ${name}${row} (${where.join(", ")}): ${shownValue}${warn}`;
  });
  if (items.length > 10) shown.push(`… 그 외 ${items.length - 10}개`);
  return { summary: `입력 칸 ${items.length}개에 값을 채웁니다.`, details: shown.join("\n") };
}

// ---------------------------------------------------------------------------
// 실행 결과 확인
// ---------------------------------------------------------------------------

// fragment: #뒤만 바뀜(같은 문서 안 위치로 이동, 해시 라우터).
export type NavKind = "none" | "fragment" | "same_origin" | "cross_origin" | "error";

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

// 클릭 전후 탭 주소로 이동 종류를 판정한다.
export function navKind(before: string, after: string): NavKind {
  if (!after || after === before) return "none";
  const b = before.split("#")[0];
  const a = after.split("#")[0];
  if (a === b) return "fragment";
  const oa = originOf(a);
  if (!oa) return "error";
  return oa === originOf(b) ? "same_origin" : "cross_origin";
}

// 같은 문서 안에서 관찰한 변화(content script가 클릭 전후로 센 것).
export interface DomEffect {
  mutations: number;
  dialogOpened: boolean;
  // 누르기 바로 앞 재확인에서 대상이 바뀌어 누르지 않았으면 그 이유.
  aborted?: string | null;
  // 대상이 든 같은 출처 iframe이 다른 문서로 이동했는지(탭 주소는 그대로).
  frameNavigated?: boolean;
}

export interface ClickEffect {
  navigation: NavKind;
  url: string;
  // 같은 문서가 그대로 남아 있는지. 주소가 바뀌었는데 문서가 그대로면 페이지 안 이동(SPA)이다.
  // null이면 확인하지 못함(페이지가 응답하지 않음 — 알림창이 떠 있을 수 있음).
  sameDocument: boolean | null;
  newTab: boolean;
  dom: DomEffect | null;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 모델과 사람이 읽을 클릭 결과 한 줄.
export function describeEffect(e: ClickEffect): string {
  if (e.dom?.aborted) return `누르기 직전에 대상이 바뀌어 클릭하지 않았습니다(${e.dom.aborted}). 다시 찾으세요.`;
  const parts: string[] = [];
  if (e.newTab) parts.push("새 탭이 열렸습니다(이 탭은 그대로)");
  if (e.dom?.frameNavigated) parts.push("페이지 안 프레임이 다른 문서로 이동했습니다");
  if (e.navigation === "fragment") {
    const hash = e.url.includes("#") ? e.url.slice(e.url.indexOf("#")) : "#";
    parts.push(`페이지 안 위치(${clip(hash, 60)})로 이동했습니다`);
  }
  if (e.navigation === "error") parts.push("이동했지만 오류 페이지입니다");
  else if (e.navigation === "cross_origin") parts.push(`다른 사이트(${hostOf(e.url)})로 이동했습니다`);
  else if (e.navigation === "same_origin") {
    parts.push(
      e.sameDocument
        ? `페이지 안에서 주소만 바뀌었습니다(${clip(pathOf(e.url), 80)})`
        : `같은 사이트의 다른 페이지로 이동했습니다(${clip(pathOf(e.url), 80)})`,
    );
  } else if (e.sameDocument === false) {
    parts.push("같은 주소로 페이지를 다시 불러왔습니다");
  }
  if ((e.navigation === "none" || e.navigation === "fragment") && e.sameDocument) {
    if (e.dom?.dialogOpened) parts.push("대화상자가 열렸습니다");
    if (e.dom && e.dom.mutations > 0) parts.push(`화면이 바뀌었습니다(변경 ${e.dom.mutations}건)`);
  }
  if (e.sameDocument === null) parts.push("페이지가 응답하지 않습니다(알림창 등이 떠 있을 수 있음)");
  if (!parts.length) return "화면 변화가 감지되지 않았습니다. 클릭이 반영되지 않았을 수 있습니다.";
  return parts.join(", ") + ".";
}
