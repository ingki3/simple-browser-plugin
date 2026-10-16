// 조작 도구(클릭·입력)의 공통 경로: 대상 기술 → 실행 직전 확인 → 승인 카드 → 결과 확인.
// 여기에는 DOM 없이 계산하는 부분만 둔다(비교·문구·이동 판정). DOM 쪽은 src/content/targets.ts.

import type { PageRegion } from "./messages";

// 대상 요소를 사람이 알아볼 수 있게 적은 것. find_* 때 기록하고, 승인 카드와 실행 직전 확인에 쓴다.
export interface TargetInfo {
  tag: string;
  role: string;
  // 클릭 대상은 보이는 글자, 입력 칸은 label.
  name: string;
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
  // 같은 틀의 형제가 3개 이상인 목록 안이면 항목 순번(1부터)과 항목 수. 승인 카드를 띄울 때 계산한다.
  // semantic은 ul·ol·표·role=list 같은 목록 표시가 있는지. 없으면 나란히 놓인 버튼 몇 개일 수도 있어,
  // 카드에는 목록 표시가 있거나 항목이 5개 이상일 때만 보여 준다(확인에는 늘 쓴다).
  list?: { index: number; count: number; semantic: boolean } | null;
  // 승인 카드에 경고만 하는 표시(비교에는 쓰지 않음): 화면에 보이지 않는 입력 칸.
  hidden?: boolean;
}

// find_* 때와 같은 요소인지: 목록 위치를 뺀 기본 항목이 모두 같아야 한다.
export function sameBase(a: TargetInfo, b: TargetInfo): boolean {
  return (
    a.tag === b.tag &&
    a.role === b.role &&
    a.name === b.name &&
    a.href === b.href &&
    a.region === b.region &&
    a.inFrame === b.inFrame &&
    a.fieldType === b.fieldType &&
    a.sensitive === b.sensitive &&
    a.context === b.context
  );
}

// 승인한 대상과 같은지: 기본 항목에 더해 목록 순번도 같아야 한다(항목 수는 더 불러오면 늘 수 있어 보지 않는다).
export function sameApproved(a: TargetInfo, b: TargetInfo): boolean {
  return sameBase(a, b) && (a.list?.index ?? null) === (b.list?.index ?? null);
}

// 서로 다른 항목을 사람이 읽을 수 있게 하나 고른다(실패 메시지용).
export function describeDifference(before: TargetInfo, after: TargetInfo): string {
  if (before.name !== after.name) return `글자가 '${clip(before.name, 40)}' → '${clip(after.name, 40)}'`;
  if (before.href !== after.href) return "링크 주소가 바뀜";
  if (before.tag !== after.tag || before.role !== after.role) return "요소 종류가 바뀜";
  if (before.fieldType !== after.fieldType || before.sensitive !== after.sensitive) return "입력 칸 종류가 바뀜";
  if (before.region !== after.region) return "페이지 영역이 바뀜";
  if (before.context !== after.context) return "대상이 든 행의 내용이 바뀜";
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
  if (!info.name) lines.push("⚠ 글자가 없는 요소입니다. 무엇을 누르는지 확인하기 어렵습니다.");
  return { summary: `${label} ${name}을(를) 클릭합니다.`, details: lines.join("\n") };
}

// 입력 승인 카드. 비밀번호 칸은 값을 가리고 글자 수만 보여 준다.
export function fillCard(
  items: Array<{ info: TargetInfo; value: string }>,
): { summary: string; details: string } {
  const shown = items.slice(0, 10).map(({ info, value }) => {
    const name = info.name ? clip(info.name, 40) : "(이름 없는 칸)";
    const shownValue =
      info.sensitive === "password" ? `${"●".repeat(Math.min(value.length, 8))} (${value.length}자)` : clip(value, 80);
    let warn =
      info.sensitive === "password" ? " ⚠ 비밀번호 칸" : info.sensitive === "payment" ? " ⚠ 결제 정보 칸" : "";
    if (info.hidden) warn += " ⚠ 화면에 보이지 않는 칸";
    const where = [info.fieldType, REGION_LABELS[info.region]];
    if (info.inFrame) where.push("프레임 안");
    return `• ${name} (${where.join(", ")}): ${shownValue}${warn}`;
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
