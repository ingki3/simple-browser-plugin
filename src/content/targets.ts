// 조작 대상 등록·확인. find_clickables·find_form_fields가 돌려준 id를 그때의 대상 기술(TargetInfo)과 함께
// 이 content script 메모리에 둔다(페이지 스크립트는 볼 수 없다). 승인 카드를 띄울 때 지금 요소가 그때와 같은지
// 확인하고 승인할 기술을 남기며, 실행 직전에 다시 그 기술과 같을 때만 실행한다.
// 요소가 다시 그려져 사라졌으면 멈춘다. 비슷한 요소로 대신하지 않는다.

import { looksPersonalValue } from "@/lib/autoApprove";
import type { PageRegion } from "@/lib/messages";
import {
  clip,
  describeDifference,
  onlyRowDiffers,
  rowDriftDiag,
  sameApproved,
  sameApprovedInFlight,
  sameBase,
  type TargetInfo,
} from "@/lib/actionTarget";
import { getAccessibleDocs, getAccessibleRoots, isShadowRoot } from "./docs";
import { eventParent, fieldValueSignature, linkHrefOf } from "./context";
import { choiceState, type ChoiceState } from "./choiceState";
import { cleanModelText } from "@/lib/modelText";
import { groupLabel, modelText } from "./modelText";

export interface TargetKind {
  // id 앞글자("c" 클릭, "f" 입력 칸).
  prefix: string;
  visible(el: HTMLElement): boolean;
  // 클릭은 보이는 요소만. 입력 칸은 find_form_fields({onlyVisible:false})로 숨은 칸도 고를 수 있어
  // 막지 않고 승인 카드에 경고만 한다.
  requireVisible: boolean;
  name(el: HTMLElement): string;
  // 모델에 돌려주는 이름(입력값·편집 영역·숨은 글자 제외, modelText.ts). 비교에도 넣는다.
  modelName(el: HTMLElement): string;
  fieldType(el: HTMLElement): string;
  sensitive(el: HTMLElement): TargetInfo["sensitive"];
  // 자동 실행 예외 판정용 표시(대상 확인 때만 계산, 비교에는 쓰지 않음).
  // 그 칸의 양식에서 값이 채워진 개인정보·비밀 칸들(묶음 승인 예외 판정용).
  personalElements?(el: HTMLElement): Element[];
  // 클릭 대상: 모델용 묶음 문맥(modelContext)·상태(states)를 기술에 넣고, 선택지(option·menuitem*)는 트리거 관계를 고정한다.
  detail?: boolean;
  // 입력 칸: 모델용 행 문맥(modelContext)만 기술에 넣는다(#56 — 라벨 없는 행 체크박스를 행 글자로 구분).
  rowContext?: boolean;
  // 숨긴 칸을 보이는 대리 요소(연결된 label)로 바꾸면 그 label의 표시 이름, 아니면 null(#56).
  // 기술의 proxy·proxyLabel로 고정하고 승인 카드에 보여 준다.
  proxyLabelName?(el: HTMLElement): string | null;
  // 입력 칸: deleteParam이 입력 묶음이 승인받은 삭제 선택지들(칸 → 선택지 글자)만으로 설명되는지(재검사의 예상된 변화, #62).
  deleteParamExplained?(el: HTMLElement, writes: ReadonlyMap<Element, ChoiceState>): boolean;
  // deleteMethod(구조 선언)에 대한 같은 예외(#62).
  deleteMethodExplained?(el: HTMLElement, writes: ReadonlyMap<Element, ChoiceState>): boolean;
  risk?(el: HTMLElement): Pick<TargetInfo, "personal" | "submitsPersonal" | "paymentContext" | "submitTo" | "submitUrl" | "ancestorHref" | "outerText" | "choiceUrls" | "download" | "deleteMethod" | "deleteParam" | "opaqueRequest" | "deleteChoices" | "insideControl" | "scopeSubmitUrls" | "scopeFormActions" | "aroundFormActions" | "pingUrls" | "fieldName" | "baseUri">;
}

interface Entry {
  kind: TargetKind;
  ref: WeakRef<HTMLElement>;
  base: TargetInfo;
  approved: { callId: string; info: TargetInfo; relation: Relation | null } | null;
  // 선택지(option·menuitem*)면 찾을 때 확인한 트리거 관계. 승인 카드 때 지금 관계와 같아야 한다.
  relation: Relation | null;
  // 이 항목을 마지막으로 돌려준 탐색 회차. 한도를 넘어 정리할 때 이번 탐색 결과는 지우지 않는다.
  gen: number;
}

// content script가 새로 뜰 때마다(페이지 이동) 바뀐다. 이전 페이지의 id가 새 페이지의 다른 요소를 가리키지 않게 한다.
const TOKEN = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
const MAX_ENTRIES = 3000;
const registry = new Map<string, Entry>();
// 요소 → id(종류별). 같은 요소를 다시 찾으면 같은 id를 준다. 페이지 DOM에는 아무것도 쓰지 않는다(#43).
const idsByKind = new Map<string, WeakMap<Element, string>>();
let counter = 0;
let generation = 0;

export function detectRegion(el: Element): PageRegion {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== cur.ownerDocument.body && depth < 40) {
    const tag = cur.tagName.toLowerCase();
    const role = (cur.getAttribute("role") ?? "").toLowerCase();
    if (tag === "article" || role === "article") return "article";
    if (tag === "main" || role === "main") return "main";
    if (tag === "nav" || role === "navigation") return "nav";
    if (tag === "aside" || role === "complementary") return "aside";
    if (tag === "header" || role === "banner") return "header";
    if (tag === "footer" || role === "contentinfo") return "footer";
    // shadow root 경계에서는 parentElement가 null이므로 host로 넘어간다.
    const rootNode = cur.getRootNode();
    cur = cur.parentElement ?? (isShadowRoot(rootNode) ? rootNode.host : null);
    depth += 1;
  }
  return "other";
}

function implicitRole(el: HTMLElement): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.toLowerCase();
  const tag = el.localName;
  if (tag === "a") return el.hasAttribute("href") ? "link" : "";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const t = (el.getAttribute("type") ?? "text").toLowerCase();
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    if (t === "search") return "searchbox";
    return "textbox";
  }
  return "";
}

function hrefOf(el: HTMLElement): string {
  return linkHrefOf(el);
}

// 행 문맥: 대상이 든 목록 항목(li·tr·role=row 등, 또는 같은 틀 형제가 2개 이상인 반복 구조)의 글자.
// 가상 목록이나 순번으로 그리는 목록은 같은 버튼 노드를 다른 행에 다시 쓰므로, 이름·순번만으로는
// 행이 바뀐 것을 모른다. 행 글자가 달라지면 다른 대상으로 본다.
const ROW_SELECTOR =
  "li, tr, dt, dd, article, [role='listitem'], [role='row'], [role='option'], [role='article'], [role='treeitem']";

const CONTEXT_MAX = 2000;

// exclude: 글자에서 뺄 하위 요소(입력 도중 확인에서 승인 뒤 새로 붙은 자동완성 목록, pinnedRowOf). 빼는 것이 없으면
// textContent 그대로다.
function textOf(el: Element, exclude: Element[] = []): string {
  let raw: string;
  if (!exclude.length) raw = el.textContent ?? "";
  else {
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    raw = "";
    // textContent와 같게 끝까지 모은다(중간에 끊으면 긴 공백 뒤에 덧붙인 글자를 놓친다). 자르기는 공백 정리 뒤에 한다.
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (exclude.some((x) => x.contains(node))) continue;
      raw += node.nodeValue ?? "";
    }
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, CONTEXT_MAX);
}

function repeated(cur: Element): boolean {
  const parent = cur.parentElement;
  if (!parent || parent === cur.ownerDocument.body) return false;
  const shape = shapeOf(cur);
  let count = 0;
  for (const sib of parent.children) {
    if (sib.localName === cur.localName && shapeOf(sib) === shape && ++count >= 2) return true;
  }
  return false;
}

// 부모 요소. shadow root 맨 위에서는 host로 넘어간다(웹 컴포넌트 안의 버튼도 바깥 행까지 본다).
function parentAcross(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return isShadowRoot(root) ? root.host : null;
}

// 대상 자신의 글자만 있는 단계(같은 모양 버튼이 나란히 있는 '수정'·'삭제' 묶음 등)는 행이 아니니 더 올라간다.
function rowElement(el: HTMLElement): { row: Element; text: string } | null {
  const own = textOf(el);
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 10; depth++) {
    if (cur === cur.ownerDocument.body) break;
    if (cur.matches(ROW_SELECTOR) || repeated(cur)) {
      const text = textOf(cur);
      if (text !== own) return { row: cur, text };
    }
    cur = parentAcross(cur);
  }
  return null;
}

const MODEL_CONTEXT_MAX = 200;
// 묶음 안의 표제(구조로만 판정): 제목 요소·role=heading·표 caption·fieldset legend.
const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role='heading'], caption, legend";

// 모델에 돌려주는 묶음 문맥: 행 글자를 modelText로(입력 칸·편집 영역·숨은 글자 제외) 만들고, 묶음의 접근성 이름이나
// 묶음 안 첫 표제가 있으면 앞에 둔다(두 달 달력의 같은 날짜, 상품 행마다 있는 같은 버튼을 구분하게).
function modelContextOf(row: Element | null): string {
  if (!row) return "";
  const text = modelText(row, MODEL_CONTEXT_MAX);
  if (!text) return "";
  const heading = groupHeading(row);
  return cleanModelText(heading && !text.startsWith(heading) ? `${heading} · ${text}` : text, MODEL_CONTEXT_MAX);
}

const GROUP_CLIMB = 6;

// 행의 표제. 행 자신의 접근성 이름·행 안의 첫 표제, 없으면 위로 올라가며(최대 6단계) 그 묶음에 구조로 연결된 표제를 찾는다:
// 접근성 이름, 표의 caption, fieldset의 legend, 그리고 묶음 안의 표제가 하나뿐이면 그 표제
// (여럿이면 어느 것이 이 행의 표제인지 구조로 정할 수 없어 쓰지 않는다).
function groupHeading(row: Element): string {
  const own = groupLabel(row, 80);
  if (own) return own;
  const inRow = row.querySelector(HEADING_SELECTOR);
  if (inRow) return modelText(inRow, 80);
  let cur = parentAcross(row);
  for (let depth = 0; cur && cur !== cur.ownerDocument.body && depth < GROUP_CLIMB; depth++) {
    const label = groupLabel(cur, 80);
    if (label) return label;
    const tag = cur.localName;
    const child =
      tag === "table"
        ? (cur as HTMLTableElement).caption
        : tag === "fieldset"
          ? (Array.from(cur.children).find((c) => c.localName === "legend") ?? null)
          : null;
    if (child) {
      const t = modelText(child, 80);
      if (t) return t;
    }
    const headings = cur.querySelectorAll(HEADING_SELECTOR);
    if (headings.length === 1) {
      const t = modelText(headings[0], 80);
      if (t) return t;
    }
    if (headings.length > 1) return "";
    cur = parentAcross(cur);
  }
  return "";
}

// 대상의 ARIA·HTML 상태. class 이름으로 상태를 추측하지 않는다.
const STATE_ATTRS = ["selected", "checked", "pressed", "expanded", "current"] as const;

function statesOf(el: HTMLElement): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of STATE_ATTRS) {
    const v = el.getAttribute(`aria-${name}`);
    if (v !== null) out[name] = v.trim().toLowerCase().slice(0, 20);
  }
  const ariaDisabled = (el.getAttribute("aria-disabled") ?? "").trim().toLowerCase() === "true";
  if (ariaDisabled || el.hasAttribute("disabled")) out.disabled = "true";
  return Object.keys(out).length ? out : undefined;
}

// pinnedRow: 입력 도중 확인에서 승인 때 찾은 행 요소(아래 approvedRows)와 그 글자에서 뺄 새 자동완성 목록. 구조가
// 그대로임을 확인한 경우에만 주어지며, 다시 찾지 않고 그 행의 글자를 쓴다.
function baseInfo(kind: TargetKind, el: HTMLElement, pinnedRow?: PinnedRow | null): TargetInfo {
  const row = pinnedRow ? { row: pinnedRow.row, text: textOf(pinnedRow.row, pinnedRow.exclude) } : rowElement(el);
  const detail: Partial<TargetInfo> = {};
  if (kind.detail || kind.rowContext) {
    const modelContext = modelContextOf(row?.row ?? null);
    if (modelContext) detail.modelContext = modelContext;
  }
  if (kind.detail) {
    const states = statesOf(el);
    if (states) detail.states = states;
  }
  const pressed = kind.proxyLabelName?.(el) ?? null;
  if (pressed !== null) {
    detail.proxy = true;
    detail.proxyLabel = pressed;
  }
  return {
    tag: el.localName,
    role: implicitRole(el),
    name: kind.name(el),
    modelName: kind.modelName(el),
    href: hrefOf(el),
    region: detectRegion(el),
    inFrame: el.ownerDocument !== document,
    fieldType: kind.fieldType(el),
    sensitive: kind.sensitive(el),
    context: row?.text ?? "",
    ...detail,
  };
}

// 목록 판별용 틀: 태그 + role + 자식 태그 모양. 같은 틀 형제가 3개 이상이면 목록으로 본다.
// class는 보지 않는다 — focus·filled·valid 같은 상태 class가 붙었다 떨어지면 목록 구성과 순번이 흔들린다.
function shapeOf(el: Element): string {
  const role = el.getAttribute("role") ?? "";
  const kids = new Set<string>();
  for (const k of el.children) kids.add(k.localName);
  return `${el.localName}[${role}](${[...kids].sort().join(",")})`;
}

const LIST_MIN_ITEMS = 3;
const LIST_ITEM_TAGS = new Set(["li", "tr", "dt", "dd", "article", "option"]);
const LIST_CONTAINER_TAGS = new Set(["ul", "ol", "tbody", "thead", "table", "dl", "menu", "select"]);
const LIST_ROLES = /^(list|listbox|grid|treegrid|table|tablist|menu|menubar|tree|listitem|row|option|tab|treeitem|menuitem|article)$/;

function semanticList(item: Element, container: Element): boolean {
  return (
    LIST_ITEM_TAGS.has(item.localName) ||
    LIST_CONTAINER_TAGS.has(container.localName) ||
    LIST_ROLES.test(item.getAttribute("role") ?? "") ||
    LIST_ROLES.test(container.getAttribute("role") ?? "")
  );
}

function listPosition(el: HTMLElement): TargetInfo["list"] {
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 8; depth++) {
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      // shadow root 맨 위: 형제를 셀 부모가 없으니 host로 넘어가 바깥 목록을 본다.
      cur = parentAcross(cur);
      continue;
    }
    if (parent === cur.ownerDocument.body) break;
    const shape = shapeOf(cur);
    let index = 0;
    let count = 0;
    for (const sib of parent.children) {
      if (sib.localName !== cur.localName || shapeOf(sib) !== shape) continue;
      count++;
      if (sib === cur) index = count;
    }
    if (count >= LIST_MIN_ITEMS) return { index, count, semantic: semanticList(cur, parent) };
    cur = parent;
  }
  return null;
}

function fullInfo(kind: TargetKind, el: HTMLElement, pinnedRow?: PinnedRow | null): TargetInfo {
  return { ...baseInfo(kind, el, pinnedRow), list: listPosition(el) };
}

// ---------------------------------------------------------------------------
// 선택지와 그것을 펼친 트리거의 관계(#43 B). 소속을 포함 구조나 글자로 추론하지 않는다.
// - linked: 펼쳐진(aria-expanded=true) 트리거(combobox·aria-haspopup 요소) 중 aria-controls/aria-owns로 선택지나
//   선택지를 담은 팝업(가장 가까운 listbox·menu 조상, 없으면 선택지 자신)을 가리키는 것이 정확히 하나.
// - unlinked: 그런 연결이 없고, 접근 가능한 모든 문서에서 펼쳐진 트리거가 0개나 1개.
// - 그 밖(펼쳐진 트리거가 둘 이상인데 연결 없음, 연결이 둘 이상)은 어느 위젯의 선택지인지 정할 수 없어 클릭 대상으로 돌려주지 않는다.
// 관계는 찾을 때·승인 카드 때·실행 직전·스크롤과 포커스 뒤에 다시 계산해 같아야 한다.
// ---------------------------------------------------------------------------

const CHOICE_ROLES = new Set(["option", "menuitem", "menuitemradio", "menuitemcheckbox"]);
const POPUP_ROLES = new Set(["listbox", "menu", "menubar"]);

export interface Relation {
  mode: "linked" | "unlinked";
  via: "controls" | "owns" | null;
  trigger: WeakRef<HTMLElement> | null;
  triggerBase: TargetInfo | null;
  // 트리거 자신이 다른 목록 안의 항목인지(중첩 메뉴). 실행 직전에도 같아야 한다.
  nested: boolean;
  popup: WeakRef<Element>;
}

export function isChoice(el: HTMLElement): boolean {
  return CHOICE_ROLES.has(implicitRole(el));
}

function isTrigger(el: Element): boolean {
  if ((el.getAttribute("role") ?? "").trim().toLowerCase() === "combobox") return true;
  const popup = el.getAttribute("aria-haspopup");
  return popup !== null && popup.trim().toLowerCase() !== "false";
}

// 합성 트리 부모: 슬롯에 배치된 노드는 슬롯, shadow root 맨 위는 host, 같은 출처 iframe 문서 맨 위는 frame 요소.
function composedParent(el: Element): Element | null {
  const parent = eventParent(el);
  if (parent) return parent;
  try {
    return el.ownerDocument.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

// 가장 가까운 listbox·menu 조상(합성 트리 경로). 없으면 자신. 끝까지 보지 못하면 null(소속을 정할 수 없음).
function popupOf(el: HTMLElement): Element | null {
  let cur: Element | null = composedParent(el);
  for (let depth = 0; cur; depth++) {
    if (depth >= 200) return null;
    if (POPUP_ROLES.has((cur.getAttribute("role") ?? "").trim().toLowerCase())) return cur;
    cur = composedParent(cur);
  }
  return el;
}

// 트리거가 다른 목록 안의 항목(중첩 메뉴)인지. 소속을 끝까지 확인하지 못해도 중첩으로 본다(더 묻는 쪽).
function nestedTrigger(trigger: HTMLElement): boolean {
  if (isChoice(trigger)) return true;
  const popup = popupOf(trigger);
  return popup === null || popup !== trigger;
}

// 펼쳐진 트리거들(접근 가능한 모든 문서·열린 shadow root).
export function expandedTriggers(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const root of getAccessibleRoots()) {
    for (const t of root.querySelectorAll<HTMLElement>('[aria-expanded="true" i]')) {
      if (isTrigger(t)) out.push(t);
    }
  }
  return out;
}

// 트리거가 aria-controls/aria-owns로 대상(팝업 또는 선택지)을 가리키는지. 참조는 트리거와 같은 Document/ShadowRoot 안에서만 푼다.
function linkVia(trigger: Element, targets: Element[]): "controls" | "owns" | null {
  const root = trigger.getRootNode() as Document | ShadowRoot;
  for (const attr of ["controls", "owns"] as const) {
    for (const id of (trigger.getAttribute(`aria-${attr}`) ?? "").split(/\s+/).filter(Boolean)) {
      const ref = root.getElementById?.(id) ?? null;
      if (ref && targets.includes(ref)) return attr;
    }
  }
  return null;
}

// 선택지의 관계. 정할 수 없으면 null.
export function choiceRelation(kind: TargetKind, el: HTMLElement, expanded = expandedTriggers()): Relation | null {
  const popup = popupOf(el);
  if (!popup) return null;
  const linked: Array<{ trigger: HTMLElement; via: "controls" | "owns" }> = [];
  for (const t of expanded) {
    const via = linkVia(t, [popup, el]);
    if (via) linked.push({ trigger: t, via });
  }
  const make = (mode: Relation["mode"], trigger: HTMLElement | null, via: Relation["via"]): Relation => ({
    mode,
    via,
    trigger: trigger ? new WeakRef(trigger) : null,
    triggerBase: trigger ? baseInfo(kind, trigger) : null,
    nested: trigger ? nestedTrigger(trigger) : false,
    popup: new WeakRef(popup),
  });
  if (linked.length === 1) return make("linked", linked[0].trigger, linked[0].via);
  if (linked.length > 1) return null;
  if (expanded.length <= 1) return make("unlinked", expanded[0] ?? null, null);
  return null;
}

// 두 관계가 같은지. 다르면 이유.
function relationDifference(before: Relation, now: Relation | null): string | null {
  if (!now) return "선택지를 연 위젯을 정할 수 없게 됨";
  if (before.mode !== now.mode || before.via !== now.via) return "선택지와 트리거의 연결이 바뀜";
  if (before.popup.deref() !== now.popup.deref()) return "선택지 목록이 바뀜";
  if ((before.trigger?.deref() ?? null) !== (now.trigger?.deref() ?? null)) return "펼쳐진 트리거가 바뀜";
  if (before.nested !== now.nested) return "펼쳐진 트리거가 다른 목록 안으로 옮겨짐";
  if (before.triggerBase && now.triggerBase && !sameBase(before.triggerBase, now.triggerBase)) {
    return `펼쳐진 트리거의 ${describeDifference(before.triggerBase, now.triggerBase)}`;
  }
  return null;
}

// 선택지면 지금 관계를 다시 계산해 before와 비교한다(선택지가 아니면 늘 null).
// (선택지가 아니던 요소가 선택지 역할로 바뀐 것은 sameBase의 role 비교가 잡는다.)
function relationChanged(kind: TargetKind, el: HTMLElement, before: Relation | null): string | null {
  if (!before) return null;
  return relationDifference(before, choiceRelation(kind, el));
}

// 승인 기술에 트리거의 기술·위험 정보와 관계 확인 상태를 붙인다(background가 양쪽을 따로 판정한다).
function withTrigger(kind: TargetKind, info: TargetInfo, relation: Relation | null): TargetInfo {
  if (!relation) return info;
  const trigger = relation.trigger?.deref();
  return {
    ...info,
    popup: relation.mode,
    ...(trigger ? { trigger: { ...fullInfo(kind, trigger), ...kind.risk?.(trigger) } } : {}),
    // 트리거가 선택지이거나 다른 목록(listbox·menu) 안에 있으면 중첩 메뉴다.
    ...(relation.nested ? { nestedPopup: true } : {}),
  };
}

// 승인한 트리거에 그 뒤 위험이 생겼는지.
function triggerRiskAdded(kind: TargetKind, relation: Relation | null, info: TargetInfo): string | null {
  const trigger = relation?.trigger?.deref();
  if (!trigger || !info.trigger) return null;
  const added = riskAdded(kind, trigger, info.trigger);
  return added ? `펼쳐진 트리거: ${added}` : null;
}

// 탐색(find_clickables·find_form_fields) 한 번을 감싼다. 한도를 넘은 오래된 항목은 탐색이 끝난 뒤,
// 이번 탐색에서 돌려주지 않은 것만 지운다(방금 돌려준 id가 같은 탐색 안에서 밀려나지 않게).
export function scanTargets<T>(fn: () => T): T {
  generation += 1;
  try {
    return fn();
  } finally {
    for (const [id, entry] of registry) {
      if (registry.size <= MAX_ENTRIES) break;
      if (entry.gen !== generation) registry.delete(id);
    }
  }
}

// relation: 선택지(option·menuitem*)면 찾을 때 확인한 트리거 관계(choiceRelation).
export function registerTarget(kind: TargetKind, el: HTMLElement, relation: Relation | null = null): string {
  let ids = idsByKind.get(kind.prefix);
  if (!ids) {
    ids = new WeakMap();
    idsByKind.set(kind.prefix, ids);
  }
  const existing = ids.get(el);
  const entry = existing ? registry.get(existing) : undefined;
  const base = baseInfo(kind, el);
  if (existing && entry && entry.ref.deref() === el) {
    // 다시 찾을 때 글자 등이 바뀌었으면 새 기술로 갱신한다(모델은 지금 결과를 보고 고른다).
    entry.base = base;
    entry.relation = relation;
    entry.approved = null;
    entry.gen = generation;
    return existing;
  }
  counter += 1;
  const id = `${kind.prefix}${counter}-${TOKEN}`;
  ids.set(el, id);
  registry.set(id, { kind, ref: new WeakRef(el), base, relation, approved: null, gen: generation });
  return id;
}

// 등록한 대상의 기술(찾기 결과에 모델용 문맥·상태를 붙이려고).
export function registeredInfo(id: string): TargetInfo | undefined {
  return registry.get(id)?.base;
}

// 모델에 보내는 오류 문구와 따로, 백그라운드 디버그 로그에만 남길 진단(diag)을 싣는 오류.
export class TargetDriftError extends Error {
  constructor(
    message: string,
    readonly diag: string,
  ) {
    super(message);
  }
}

function staleError(id: string): Error {
  return new Error(
    `id '${id}'는 지금 페이지에서 찾은 대상이 아닙니다(페이지가 바뀌었거나 다시 불러옴). find_clickables·find_form_fields로 다시 찾으세요.`,
  );
}

// 등록한 그 요소만 쓴다. 다시 그려져 사라졌으면 비슷한 요소로 바꾸지 않고 멈춘다 — 같은 이름·순번의 요소가
// 다른 행일 수 있다(승인한 행이 지워지고 다음 행이 올라온 경우). 모델이 다시 찾아 새 승인을 받는다.
// 요소 참조만으로 확인하고 페이지를 바꾸지 않는다(모델이 고른 대상이 페이지에 드러나지 않게).
function resolve(id: string): { entry: Entry; el: HTMLElement } {
  const entry = registry.get(id);
  if (!entry) throw staleError(id);
  const el = entry.ref.deref();
  // iframe이 다른 문서로 이동하면 이전 문서의 요소도 그 문서 안에서는 isConnected다. 지금 보이는 문서인지도 본다.
  if (!el || !el.isConnected || !getAccessibleDocs().includes(el.ownerDocument)) {
    throw new Error(`대상 '${entry.base.modelName || id}'이(가) 페이지에서 다시 그려지거나 사라졌습니다. 다시 찾으세요.`);
  }
  return { entry, el };
}

function entryOf(id: string, prefix: string): Entry {
  const entry = registry.get(id);
  if (!entry) throw staleError(id);
  if (entry.kind.prefix !== prefix) {
    throw new Error(
      prefix === "f"
        ? `id '${id}'는 입력 칸이 아닙니다. find_form_fields가 준 id를 쓰세요.`
        : `id '${id}'는 클릭 대상이 아닙니다. find_clickables가 준 id를 쓰세요.`,
    );
  }
  return entry;
}

function checkVisible(entry: Entry, el: HTMLElement, name: string, acting: boolean): void {
  if (entry.kind.requireVisible && !entry.kind.visible(el)) {
    throw new Error(`대상 '${name}'이(가) 지금 화면에 보이지 않${acting ? "아 실행하지 않았" : ""}습니다.`);
  }
}

// 승인 카드용: 지금 요소가 find_* 때와 같은지 확인하고, 목록 위치까지 담은 기술을 이 호출(callId)의 승인 대상으로 남긴다.
export function inspectTarget(id: string, callId: string, prefix: string): TargetInfo {
  entryOf(id, prefix);
  const { entry, el } = resolve(id);
  const now = baseInfo(entry.kind, el);
  if (!sameBase(now, entry.base)) {
    if (onlyRowDiffers(entry.base, now)) {
      // 같은 요소인데 든 행의 글자만 바뀌었다(운임·남은 시간이 계속 갱신되는 목록 등). 다시 찾기와 같이 지금 기술로
      // 바꿔 두고, 지금 행 글자(모델용)를 돌려준다. 모델이 그 행이 맞는지 보고 같은 id로 다시 부르면 지금 기술과 비교한다.
      const diag = rowDriftDiag(entry.base, now);
      entry.base = now;
      entry.approved = null;
      const row = now.modelContext ? ` 지금 행: '${clip(now.modelContext, 200)}'.` : "";
      throw new TargetDriftError(
        `대상 '${id}'이(가) 든 행의 내용이 찾은 뒤 바뀌었습니다.${row} 이 행이 고르려던 것이 맞으면 같은 id로 다시 호출하고, 아니면 다시 찾으세요.`,
        `row_drift ${diag}`,
      );
    }
    throw new Error(`대상 '${id}'의 ${describeDifference(entry.base, now)}. 다시 찾으세요.`);
  }
  checkVisible(entry, el, entry.base.modelName || id, false);
  // 선택지면 지금 트리거 관계가 찾을 때와 같아야 한다. 승인은 지금 관계를 기준으로 남긴다.
  let relation: Relation | null = null;
  if (entry.relation) {
    relation = choiceRelation(entry.kind, el);
    const changed = relationDifference(entry.relation, relation);
    if (changed) throw new Error(`대상 '${id}'의 ${changed}. 다시 찾으세요.`);
  }
  const info = withTrigger(
    entry.kind,
    { ...fullInfo(entry.kind, el), hidden: !entry.kind.visible(el), ...entry.kind.risk?.(el) },
    relation,
  );
  entry.approved = { callId, info, relation };
  const row = rowElement(el)?.row;
  const texts = row ? rowTextNodes(row) : null;
  if (row && texts) {
    approvedRows.set(el, {
      row: new WeakRef(row),
      path: ancestorsUpTo(el, row).map((a) => new WeakRef(a)),
      texts,
      combo: comboboxField(el),
    });
  } else approvedRows.delete(el);
  return info;
}

// 승인 카드용 묶음 확인. 묶음에 개인정보·비밀번호·결제 칸이 있으면 각 항목에 표시해 둔다(riskAdded 참고).
// 승인 당시 값이 채워져 있던 개인정보·비밀 칸과 그때의 값. 실행 직전에 값이 바뀌었으면(이 호출이 쓴 값이 아니면) 멈춘다.
const consentAllowed = new Map<string, Map<Element, string>>();
// 입력 묶음이 쓴 선택 칸들의 쓴 직후 상태(칸 → ChoiceState, #62). 호출(callId)마다.
const consentDeleteChoices = new Map<string, Map<Element, ChoiceState>>();

// 입력 묶음이 선택 칸에 상태를 쓴 직후(페이지 처리기가 돌기 전) 그 상태를 기록한다(#62, forms.ts fillOne의 onWritten).
// 재검사는 이 기록과 지금 상태가 그대로 같은 칸만 예상된 변화로 뺀다(deleteParamExplained).
export function noteChoiceWritten(callId: string, el: Element): void {
  const state = choiceState(el);
  if (!state) return;
  let m = consentDeleteChoices.get(callId);
  if (!m) {
    m = new Map();
    consentDeleteChoices.set(callId, m);
    while (consentDeleteChoices.size > 50) {
      const oldest = consentDeleteChoices.keys().next().value;
      if (oldest === undefined) break;
      consentDeleteChoices.delete(oldest);
    }
  }
  m.set(el, state);
}
// 이 호출이 실제로 써 넣은 칸과 값(처리기가 돌기 전에 정한 값). 그 칸이 지금도 그 값이면 승인한 변화로 본다.
const writtenByCall = new Map<string, Map<Element, string>>();

export function noteWritten(callId: string, el: Element, value: string): void {
  let m = writtenByCall.get(callId);
  if (!m) {
    m = new Map();
    writtenByCall.set(callId, m);
    while (writtenByCall.size > 50) {
      const oldest = writtenByCall.keys().next().value;
      if (oldest === undefined) break;
      writtenByCall.delete(oldest);
    }
  }
  m.set(el, value);
}

// 예외는 개인정보 칸이 든 양식(양식 밖 칸은 그 칸 자신)에만 붙인다 — 다른 양식에 새로 생긴 개인정보는 허용하지 않는다.
export function inspectTargets(ids: string[], callId: string, prefix: string, values?: string[]): TargetInfo[] {
  const infos = ids.map((id) => inspectTarget(id, callId, prefix));
  // 이번 호출이 선택 칸에 쓴 상태는 쓰는 순간 기록한다(noteChoiceWritten). 승인 때 지난 기록이 있으면 지운다.
  consentDeleteChoices.delete(callId);
  // 승인 때 이미 값이 채워져 있던 개인정보·비밀 칸을 기억해 둔다. 실행 직전에 이 목록 밖의 칸이 채워져 있으면
  // (자동 완성된 비밀번호 등) 양식에 원래 개인정보가 있었든 없었든 멈춘다.
  // 칸 단서가 없어도 입력할 값이 개인정보(이메일·전화 등)면 승인 카드가 뜨므로 개인정보 묶음으로 본다.
  const personalAt = (i: number) =>
    !!(infos[i].personal || infos[i].sensitive) || (values?.[i] !== undefined && looksPersonalValue(values[i]));
  const batchHasPersonal = infos.some((_, i) => personalAt(i));
  const scopeOf = (id: string): Element | null => {
    const el = registry.get(id)?.ref.deref();
    if (!el) return null;
    return (el as HTMLInputElement).form ?? el.closest("form") ?? el;
  };
  // 승인 때 이미 채워져 있던 개인정보 칸과 이 묶음이 채울 칸만 허용한다(뒤에 자동 완성된 비밀번호 등은 아님).
  const allowed = new Map<Element, string>();
  ids.forEach((id) => {
    const entry = registry.get(id);
    const el = entry?.ref.deref();
    if (!entry || !el) return;
    for (const p of entry.kind.personalElements?.(el) ?? []) allowed.set(p, fieldValueSignature(p));
    // 선택지를 연 트리거 쪽 양식의 개인정보·비밀 칸도 승인 당시 상태로 남긴다(실행 직전 트리거 재검사가 쓴다).
    const trigger = entry.approved?.callId === callId ? entry.approved.relation?.trigger?.deref() : undefined;
    if (trigger) for (const p of entry.kind.personalElements?.(trigger) ?? []) allowed.set(p, fieldValueSignature(p));
  });
  consentAllowed.set(callId, allowed);
  while (consentAllowed.size > 50) {
    const oldest = consentAllowed.keys().next().value;
    if (oldest === undefined) break;
    consentAllowed.delete(oldest);
  }
  if (!batchHasPersonal) {
    return ids.map((id, i) => {
      const entry = registry.get(id);
      const info = stampConsent(infos[i], callId);
      if (entry?.approved?.callId === callId) entry.approved = { ...entry.approved, info };
      return info;
    });
  }
  const consentScopes = new Set<Element>();
  ids.forEach((id, i) => {
    if (personalAt(i)) {
      const scope = scopeOf(id);
      if (scope) consentScopes.add(scope);
    }
  });
  return ids.map((id, i) => {
    const scope = scopeOf(id);
    const entry = registry.get(id);
    if (!scope || !consentScopes.has(scope)) {
      const info = stampConsent(infos[i], callId);
      if (entry?.approved?.callId === callId) entry.approved = { ...entry.approved, info };
      return info;
    }
    const info = { ...stampConsent(infos[i], callId), consentPersonal: true };
    if (entry?.approved?.callId === callId) entry.approved = { ...entry.approved, info };
    return info;
  });
}

// 승인 호출을 기술에 붙인다. 트리거 기술에도 붙여 트리거 재검사가 같은 허용 목록을 보게 한다.
function stampConsent(info: TargetInfo, callId: string): TargetInfo {
  return {
    ...info,
    consentCall: callId,
    ...(info.trigger ? { trigger: { ...info.trigger, consentCall: callId } } : {}),
  };
}

// 승인 뒤 위험(개인정보·제출 주소·이름 등)이 새로 생겨 멈췄다는 표시. 묶음 입력은 남은 칸도 멈춘다.
export class RiskAddedError extends Error {}

// 실행 직전: 이 호출에서 승인한 기술과 지금 요소가 같을 때만 요소를 돌려준다. 승인은 한 번만 쓴다.
// inFlight: 같은 승인 묶음의 앞 칸에 이미 입력 이벤트를 보낸 뒤면 입력 도중의 비교(sameApprovedInFlight)를 쓴다.
export function takeApproved(
  id: string,
  callId: string,
  prefix: string,
  inFlight = false,
): { el: HTMLElement; info: TargetInfo; relation: Relation | null } {
  const known = entryOf(id, prefix);
  const approved = known.approved;
  if (!approved || approved.callId !== callId) {
    throw new Error(`대상 '${id}'은(는) 이 호출에서 승인되지 않았습니다.`);
  }
  const { entry, el } = resolve(id);
  entry.approved = null;
  // 묶음의 앞 칸 입력이 이 칸의 형제 묶음 틀을 바꿔(자동완성 목록이 붙음) 행이 다른 요소로 잡힐 수 있어, 입력 도중이면
  // 승인 때의 행을 구조가 그대로일 때만 다시 쓴다(pinnedRowOf).
  const pinned = inFlight ? pinnedRowOf(el) : null;
  const now = fullInfo(entry.kind, el, pinned);
  if (!(inFlight ? sameApprovedInFlight(now, approved.info) : sameApproved(now, approved.info))) {
    const msg = `승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${describeDifference(approved.info, now)}). 다시 찾으세요.`;
    // 민감한 칸(비밀번호·결제·인증번호)이나 개인정보 칸으로 바뀐 것, 그 밖의 위험이 생긴 것은 위험 변화다
    // (묶음 입력의 남은 칸도 멈춘다).
    if ((now.sensitive ?? null) !== (approved.info.sensitive ?? null)) throw new RiskAddedError(msg);
    if (riskAdded(entry.kind, el, approved.info)) throw new RiskAddedError(msg);
    throw new Error(msg);
  }
  const added = riskAdded(entry.kind, el, approved.info) ?? triggerRiskAdded(entry.kind, approved.relation, approved.info);
  if (added) throw new RiskAddedError(`승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${added}). 다시 찾으세요.`);
  const relationMoved = relationChanged(entry.kind, el, approved.relation);
  if (relationMoved) throw new Error(`승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${relationMoved}). 다시 찾으세요.`);
  checkVisible(entry, el, approved.info.modelName || id, true);
  return { el, info: approved.info, relation: approved.relation };
}

// 승인 카드 때 없던 위험(개인정보 칸, 개인정보가 채워진 양식의 버튼)이 그 뒤에 생겼는지.
// 자동 완성·페이지 스크립트가 승인 뒤에 칸을 채우면, 자동 실행이든 사람이 승인한 카드든 그대로 실행하지 않는다.
function riskAdded(kind: TargetKind, el: HTMLElement, info: TargetInfo): string | null {
  const now = kind.risk?.(el);
  if (!now) return null;
  if (now.personal && !info.personal) return "개인정보 칸으로 바뀜";
  const allowed = info.consentCall ? consentAllowed.get(info.consentCall) : undefined;
  const filled = kind.personalElements?.(el) ?? [];
  // 승인 때 목록에 없던 개인정보·비밀 칸이 채워졌으면(기존 개인정보 유무와 관계없이) 멈춘다.
  const written = info.consentCall ? writtenByCall.get(info.consentCall) : undefined;
  // 이 호출이 써 넣은 값과 같은 값이 같은 양식의 다른 칸에 복사된 것(처리기의 같은 값 동기화)도 승인한 변화로 본다.
  // 개인정보 칸을 카드로 승인받은 묶음(consentPersonal)이고, 직접 쓴 칸과 같은 양식일 때만.
  const formOf = (e: Element) => (e as HTMLInputElement).form ?? e.closest("form");
  const syncAllowed = (p: Element) => {
    if (!info.consentPersonal || !written) return false;
    const sig = fieldValueSignature(p);
    const pf = formOf(p);
    if (!pf || !sig) return false;
    for (const [w, v] of written) if (v === sig && formOf(w) === pf) return true;
    return false;
  };
  const explained = (p: Element) =>
    (allowed?.has(p) && allowed.get(p) === fieldValueSignature(p)) ||
    // 선택 칸은 선택 상태 전체(다중 선택에 처리기가 더한 선택지 포함)를 비교한다.
    (written?.has(p) && written.get(p) === fieldValueSignature(p)) ||
    (!written?.has(p) && syncAllowed(p));
  if (allowed && filled.some((p) => !explained(p))) return "승인 뒤 양식에 개인정보가 채워짐";
  // 클릭은 묶음 입력이 아니므로, 승인 뒤 개인정보 제출로 바뀌었으면(버튼 자신의 값 포함) 그대로 멈춘다.
  // 입력 칸은 허용 목록으로 판정하고, 목록이 없을 때만(오래되어 지워진 경우 등) 양식 단위로 본다.
  if (now.submitsPersonal && !info.submitsPersonal && (kind.prefix !== "f" || !allowed)) {
    return "승인 뒤 양식에 개인정보가 채워짐";
  }
  if (now.paymentContext && !info.paymentContext) return "결제 화면으로 바뀜";
  if ((now.submitTo ?? "") !== (info.submitTo ?? "")) return "양식 제출 주소가 바뀜";
  if ((now.ancestorHref ?? "") !== (info.ancestorHref ?? "")) return "감싼 링크 주소가 바뀜";
  // 입력 칸은 묶음 안의 앞선 입력이 같은 양식 값을 바꾸므로 제출 주소의 값 부분은 비교하지 않는다
  // (기존 값에 실린 바깥 주소는 승인 카드 판정 때 이미 본다). 클릭은 값이 바뀌면 멈춘다.
  if (kind.prefix !== "f" && (now.submitUrl ?? "") !== (info.submitUrl ?? "")) return "양식에 담긴 값이 바뀜";
  if ((now.outerText ?? "") !== (info.outerText ?? "")) return "감싼 버튼 글자가 바뀜";
  if (now.download && !info.download) return "내려받기 링크로 바뀜";
  // 같은 입력 묶음이 선택 칸에 쓴 상태 그대로로만 생긴 신호는 예상된 변화다(#62 — deleteMethod·deleteParam 모두, 그 칸과
  // 같은 양식의 다른 칸 모두). 다른 원인이면 멈춘다.
  const writes = info.consentCall ? consentDeleteChoices.get(info.consentCall) : undefined;
  if (now.deleteMethod && !info.deleteMethod && !(writes && kind.deleteMethodExplained?.(el, writes))) {
    return "삭제 요청으로 바뀜";
  }
  if (now.opaqueRequest && !info.opaqueRequest) return "확인할 수 없는 htmx 요청으로 바뀜";
  if (now.deleteParam && !info.deleteParam && !(writes && kind.deleteParamExplained?.(el, writes))) {
    return "삭제 요청으로 바뀜";
  }
  if ((now.deleteChoices ?? []).join("\n") !== (info.deleteChoices ?? []).join("\n")) return "삭제 선택지가 바뀜";
  if (now.insideControl && !info.insideControl) return "버튼 안으로 옮겨짐";
  if ((now.choiceUrls ?? []).join(" ") !== (info.choiceUrls ?? []).join(" ")) return "선택지 주소가 바뀜";
  // 범위 안 다른 양식의 제출 주소: 클릭은 값까지 비교한다. 입력 칸은 묶음 입력이 주변 양식 값을 바꿀 수 있어
  // 여기서는 action 목록(scopeFormActions)만 비교하고, 값에 새로 생긴 주소·개인정보는 입력 직전 검사가 본다.
  if (kind.prefix !== "f" && (now.scopeSubmitUrls ?? []).join(" ") !== (info.scopeSubmitUrls ?? []).join(" ")) {
    return "주변 양식의 제출 주소가 바뀜";
  }
  if ((now.scopeFormActions ?? []).join(" ") !== (info.scopeFormActions ?? []).join(" ")) return "주변 양식의 제출 주소가 바뀜";
  if ((now.aroundFormActions ?? []).join(" ") !== (info.aroundFormActions ?? []).join(" ")) return "주변 양식의 제출 주소가 바뀜";
  if ((now.fieldName ?? "") !== (info.fieldName ?? "")) return "칸 이름이 바뀜";
  if ((now.baseUri ?? "") !== (info.baseUri ?? "")) return "문서 기준 주소가 바뀜";
  if ((now.pingUrls ?? []).join(" ") !== (info.pingUrls ?? []).join(" ")) return "링크의 ping 주소가 바뀜";
  return null;
}

// 승인 때 찾은 대상의 행 요소. 행은 같은 틀 형제(repeated)로도 정하는데, 입력하자 칸의 묶음에만 자동완성 목록이 붙으면
// 그 묶음의 틀(자식 태그 모양)이 형제와 달라져 행이 다른 요소로 잡힌다(네이버 지도 길찾기). 입력 도중 확인은 아래가 모두
// 구조로 확인될 때만 승인 때의 행 요소를 그대로 쓴다(pinnedRowOf). 아니면 지금처럼 행을 다시 찾아 엄격히 비교한다.
// - 대상에서 행까지의 조상 사슬이 승인 때와 같다(하위 행으로 옮겨지지 않음).
// - 승인 때 행 안에 있던 글자 노드가 모두 같은 행 안에 같은 글자로 남아 있다.
// 행 글자 비교(원문 context)는 여전히 승인 때와 같아야 한다. 다만 대상이 자동완성 입력 칸(combobox)이면, 승인 뒤 행 안에
// 새로 생긴 팝업 목록(role=listbox·grid·tree — 승인 때의 글자 노드를 담지 않은 것)의 글자는 빼고 비교한다.
// 기존 제목 곁에 글자를 덧붙이는 것('문서 A' + ' 사본')은 목록 밖이라 다른 대상이다.
const approvedRows = new WeakMap<
  HTMLElement,
  { row: WeakRef<Element>; path: WeakRef<Element>[]; texts: Array<{ node: WeakRef<Text>; value: string }>; combo: boolean }
>();

interface PinnedRow {
  row: Element;
  exclude: Element[];
}

// 자동완성 입력 칸: role=combobox, aria-autocomplete, 또는 datalist를 쓰는 input(구조로만 판정).
function comboboxField(el: HTMLElement): boolean {
  const role = (el.getAttribute("role") ?? "").trim().toLowerCase();
  return role === "combobox" || el.hasAttribute("aria-autocomplete") || (el.localName === "input" && el.hasAttribute("list"));
}

const POPUP_LIST_SELECTOR = "[role='listbox' i], [role='grid' i], [role='tree' i]";

// 행 안의 비어 있지 않은 글자 노드(최대 ROW_TEXT_NODES_MAX개). 넘으면 null — 행을 고정하지 않고 이전처럼 엄격히 비교한다.
const ROW_TEXT_NODES_MAX = 500;
function rowTextNodes(row: Element): Array<{ node: WeakRef<Text>; value: string }> | null {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const out: Array<{ node: WeakRef<Text>; value: string }> = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.nodeValue ?? "").trim()) continue;
    if (out.length >= ROW_TEXT_NODES_MAX) return null;
    out.push({ node: new WeakRef(node as Text), value: node.nodeValue ?? "" });
  }
  return out;
}

// 대상의 부모부터 행까지의 조상(행 포함, shadow root는 host로 넘어감). 행에 닿지 못하면 빈 배열.
function ancestorsUpTo(el: Element, row: Element): Element[] {
  const out: Element[] = [];
  for (let cur = parentAcross(el); cur; cur = parentAcross(cur)) {
    out.push(cur);
    if (cur === row) return out;
  }
  return [];
}

function pinnedRowOf(el: HTMLElement): PinnedRow | null {
  const pinned = approvedRows.get(el);
  const row = pinned?.row.deref();
  if (!pinned || !row || !row.isConnected) return null;
  const now = ancestorsUpTo(el, row);
  if (now.length === 0 || now.length !== pinned.path.length) return null;
  if (!now.every((a, i) => pinned.path[i].deref() === a)) return null;
  const kept: Text[] = [];
  for (const t of pinned.texts) {
    const node = t.node.deref();
    if (!node || !node.isConnected || !row.contains(node) || node.nodeValue !== t.value) return null;
    kept.push(node);
  }
  // 대상을 담지 않고 승인 때의 글자 노드도 담지 않은 팝업 목록만(새로 생긴 자동완성 목록) 뺀다. 가장 바깥 것만 둔다.
  const exclude = pinned.combo
    ? Array.from(row.querySelectorAll(POPUP_LIST_SELECTOR)).filter(
        (list) => !list.contains(el) && !kept.some((n) => list.contains(n)),
      )
    : [];
  return { row, exclude: exclude.filter((x) => !exclude.some((y) => y !== x && y.contains(x))) };
}

// 승인 확인 뒤 실제 실행까지 페이지 코드가 돌 틈이 있으면(스크롤·포커스 처리기 등) 실행 바로 앞에서 다시 본다.
// 같으면 null, 다르면 이유. inFlight: 입력 도중·직후의 확인이면 원문 행 글자가 그대로일 때 모델용 행 문맥만 바뀐 것은
// 허용한다(sameApprovedInFlight — 입력 처리기가 행 안의 숨은 안내 글을 보이게 하는 경우).
export function recheckApproved(
  kind: TargetKind,
  el: HTMLElement,
  info: TargetInfo,
  relation: Relation | null = null,
  inFlight = false,
): string | null {
  if (!el.isConnected || !getAccessibleDocs().includes(el.ownerDocument)) return "대상이 페이지에서 사라짐";
  const pinned = inFlight ? pinnedRowOf(el) : null;
  const now = fullInfo(kind, el, pinned);
  if (!(inFlight ? sameApprovedInFlight(now, info) : sameApproved(now, info))) return describeDifference(info, now);
  const added = riskAdded(kind, el, info) ?? triggerRiskAdded(kind, relation, info);
  if (added) return added;
  const relationMoved = relationChanged(kind, el, relation);
  if (relationMoved) return relationMoved;
  if (kind.requireVisible && !kind.visible(el)) return "대상이 화면에서 사라짐";
  return null;
}

// 승인된 대상이 아직 같은지 실행 없이 확인만 한다(여러 칸을 채우기 전에 모두 확인).
export function peekApproved(id: string, callId: string, prefix: string): void {
  const known = entryOf(id, prefix);
  const approved = known.approved;
  if (!approved || approved.callId !== callId) {
    throw new Error(`대상 '${id}'은(는) 이 호출에서 승인되지 않았습니다.`);
  }
  const { entry, el } = resolve(id);
  const now = fullInfo(entry.kind, el);
  if (!sameApproved(now, approved.info)) {
    throw new Error(`승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${describeDifference(approved.info, now)}). 다시 찾으세요.`);
  }
  const added = riskAdded(entry.kind, el, approved.info);
  if (added) throw new Error(`승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${added}). 다시 찾으세요.`);
}

// ---------------------------------------------------------------------------
// 클릭 결과 관찰: 클릭 전에 시작해 백그라운드가 물어볼 때까지 같은 문서 안의 변화를 센다.
// ---------------------------------------------------------------------------

interface EffectWatch {
  observers: MutationObserver[];
  mutations: number;
  dialogsBefore: number;
  // 클릭 직전 재확인에서 멈췄으면 그 이유(클릭하지 않음).
  aborted: string | null;
  // 대상이 같은 출처 iframe 안이면 그 프레임과 클릭 당시 문서. 프레임만 이동하면 탭 주소는 그대로라 따로 본다.
  frame: { el: Element; doc: Document } | null;
  timer: ReturnType<typeof setTimeout>;
}

const watches = new Map<string, EffectWatch>();
const DIALOG_SELECTOR = "dialog[open], [role='dialog'], [role='alertdialog'], [aria-modal='true']";
const WATCH_MAX_MS = 30_000;

function openDialogs(): number {
  let n = 0;
  for (const root of getAccessibleRoots()) {
    for (const el of root.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)) {
      if (el.getClientRects().length > 0) n++;
    }
  }
  return n;
}

export function startEffectWatch(token: string, target: HTMLElement, aborted: string | null = null): void {
  const doc = target.ownerDocument;
  const frameEl = doc !== document ? doc.defaultView?.frameElement : null;
  const watch: EffectWatch = {
    observers: [],
    mutations: 0,
    aborted,
    frame: frameEl ? { el: frameEl, doc } : null,
    dialogsBefore: openDialogs(),
    timer: setTimeout(() => stopEffectWatch(token), WATCH_MAX_MS),
  };
  // 문서의 subtree 관찰은 shadow root 안으로 이어지지 않아, 열린 shadow root마다 따로 관찰한다.
  for (const root of aborted ? [] : getAccessibleRoots()) {
    const target = isShadowRoot(root) ? root : root.documentElement;
    if (!target) continue;
    const obs = new MutationObserver((records) => {
      watch.mutations += records.length;
    });
    obs.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
    watch.observers.push(obs);
  }
  watches.set(token, watch);
}

function stopEffectWatch(token: string): EffectWatch | undefined {
  const watch = watches.get(token);
  if (!watch) return undefined;
  for (const o of watch.observers) {
    // 아직 콜백으로 넘어오지 않은 기록도 센다.
    watch.mutations += o.takeRecords().length;
    o.disconnect();
  }
  clearTimeout(watch.timer);
  watches.delete(token);
  return watch;
}

// 같은 문서면 변화를, 이 문서에서 시작한 관찰이 아니면(페이지가 바뀜) null을 돌려준다.
export function readEffect(
  token: string,
): { mutations: number; dialogOpened: boolean; aborted: string | null; frameNavigated: boolean } | null {
  const watch = stopEffectWatch(token);
  if (!watch) return null;
  let frameNavigated = false;
  if (watch.frame) {
    // 프레임이 다른 문서로 바뀌면 contentDocument가 달라진다(다른 출처면 null).
    const f = watch.frame.el as HTMLIFrameElement;
    frameNavigated = !f.isConnected || f.contentDocument !== watch.frame.doc;
  }
  return {
    mutations: watch.mutations,
    dialogOpened: openDialogs() > watch.dialogsBefore,
    aborted: watch.aborted,
    frameNavigated,
  };
}
