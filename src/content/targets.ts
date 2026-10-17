// 조작 대상 등록·확인. find_clickables·find_form_fields가 돌려준 id를 그때의 대상 기술(TargetInfo)과 함께
// 이 content script 메모리에 둔다(페이지 스크립트는 볼 수 없다). 승인 카드를 띄울 때 지금 요소가 그때와 같은지
// 확인하고 승인할 기술을 남기며, 실행 직전에 다시 그 기술과 같을 때만 실행한다.
// 요소가 다시 그려져 사라졌으면 멈춘다. 비슷한 요소로 대신하지 않는다.

import type { PageRegion } from "@/lib/messages";
import { describeDifference, sameApproved, sameBase, type TargetInfo } from "@/lib/actionTarget";
import { getAccessibleDocs, getAccessibleRoots, isShadowRoot } from "./docs";

export interface TargetKind {
  // id 앞글자("c" 클릭, "f" 입력 칸)와 요소에 붙이는 속성.
  prefix: string;
  attr: string;
  visible(el: HTMLElement): boolean;
  // 클릭은 보이는 요소만. 입력 칸은 find_form_fields({onlyVisible:false})로 숨은 칸도 고를 수 있어
  // 막지 않고 승인 카드에 경고만 한다.
  requireVisible: boolean;
  name(el: HTMLElement): string;
  fieldType(el: HTMLElement): string;
  sensitive(el: HTMLElement): TargetInfo["sensitive"];
  // 자동 실행 예외 판정용 표시(대상 확인 때만 계산, 비교에는 쓰지 않음).
  risk?(el: HTMLElement): Pick<TargetInfo, "personal" | "submitsPersonal">;
}

interface Entry {
  kind: TargetKind;
  ref: WeakRef<HTMLElement>;
  base: TargetInfo;
  approved: { callId: string; info: TargetInfo } | null;
  // 이 항목을 마지막으로 돌려준 탐색 회차. 한도를 넘어 정리할 때 이번 탐색 결과는 지우지 않는다.
  gen: number;
}

// content script가 새로 뜰 때마다(페이지 이동) 바뀐다. 이전 페이지의 id가 새 페이지의 다른 요소를 가리키지 않게 한다.
const TOKEN = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
const MAX_ENTRIES = 3000;
const registry = new Map<string, Entry>();
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
  if (el.localName !== "a") return "";
  return (el as HTMLAnchorElement).href || "";
}

// 행 문맥: 대상이 든 목록 항목(li·tr·role=row 등, 또는 같은 틀 형제가 2개 이상인 반복 구조)의 글자.
// 가상 목록이나 순번으로 그리는 목록은 같은 버튼 노드를 다른 행에 다시 쓰므로, 이름·순번만으로는
// 행이 바뀐 것을 모른다. 행 글자가 달라지면 다른 대상으로 본다.
const ROW_SELECTOR =
  "li, tr, dt, dd, article, [role='listitem'], [role='row'], [role='option'], [role='article'], [role='treeitem']";

const CONTEXT_MAX = 2000;

function textOf(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, CONTEXT_MAX);
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
function rowContext(el: HTMLElement): string {
  const own = textOf(el);
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 10; depth++) {
    if (cur === cur.ownerDocument.body) break;
    if (cur.matches(ROW_SELECTOR) || repeated(cur)) {
      const text = textOf(cur);
      if (text !== own) return text;
    }
    cur = parentAcross(cur);
  }
  return "";
}

function baseInfo(kind: TargetKind, el: HTMLElement): TargetInfo {
  return {
    tag: el.localName,
    role: implicitRole(el),
    name: kind.name(el),
    href: hrefOf(el),
    region: detectRegion(el),
    inFrame: el.ownerDocument !== document,
    fieldType: kind.fieldType(el),
    sensitive: kind.sensitive(el),
    context: rowContext(el),
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

function fullInfo(kind: TargetKind, el: HTMLElement): TargetInfo {
  return { ...baseInfo(kind, el), list: listPosition(el) };
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

export function registerTarget(kind: TargetKind, el: HTMLElement): string {
  const existing = el.getAttribute(kind.attr);
  const entry = existing ? registry.get(existing) : undefined;
  const base = baseInfo(kind, el);
  if (existing && entry && entry.ref.deref() === el) {
    // 다시 찾을 때 글자 등이 바뀌었으면 새 기술로 갱신한다(모델은 지금 결과를 보고 고른다).
    entry.base = base;
    entry.approved = null;
    entry.gen = generation;
    return existing;
  }
  counter += 1;
  const id = `${kind.prefix}${counter}-${TOKEN}`;
  el.setAttribute(kind.attr, id);
  registry.set(id, { kind, ref: new WeakRef(el), base, approved: null, gen: generation });
  return id;
}

function staleError(id: string): Error {
  return new Error(
    `id '${id}'는 지금 페이지에서 찾은 대상이 아닙니다(페이지가 바뀌었거나 다시 불러옴). find_clickables·find_form_fields로 다시 찾으세요.`,
  );
}

// 등록한 그 요소만 쓴다. 다시 그려져 사라졌으면 비슷한 요소로 바꾸지 않고 멈춘다 — 같은 이름·순번의 요소가
// 다른 행일 수 있다(승인한 행이 지워지고 다음 행이 올라온 경우). 모델이 다시 찾아 새 승인을 받는다.
function resolve(id: string): { entry: Entry; el: HTMLElement } {
  const entry = registry.get(id);
  if (!entry) throw staleError(id);
  const el = entry.ref.deref();
  // iframe이 다른 문서로 이동하면 이전 문서의 요소도 그 문서 안에서는 isConnected다. 지금 보이는 문서인지도 본다.
  if (!el || !el.isConnected || !getAccessibleDocs().includes(el.ownerDocument)) {
    throw new Error(`대상 '${entry.base.name || id}'이(가) 페이지에서 다시 그려지거나 사라졌습니다. 다시 찾으세요.`);
  }
  // 페이지가 속성만 지우거나 바꿨으면 표시만 되돌린다(기술 확인은 호출한 쪽이 한다).
  if (el.getAttribute(entry.kind.attr) !== id) el.setAttribute(entry.kind.attr, id);
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
    throw new Error(`대상 '${id}'의 ${describeDifference(entry.base, now)}. 다시 찾으세요.`);
  }
  checkVisible(entry, el, entry.base.name, false);
  const info: TargetInfo = { ...fullInfo(entry.kind, el), hidden: !entry.kind.visible(el), ...entry.kind.risk?.(el) };
  entry.approved = { callId, info };
  return info;
}

// 실행 직전: 이 호출에서 승인한 기술과 지금 요소가 같을 때만 요소를 돌려준다. 승인은 한 번만 쓴다.
export function takeApproved(id: string, callId: string, prefix: string): { el: HTMLElement; info: TargetInfo } {
  const known = entryOf(id, prefix);
  const approved = known.approved;
  if (!approved || approved.callId !== callId) {
    throw new Error(`대상 '${id}'은(는) 이 호출에서 승인되지 않았습니다.`);
  }
  const { entry, el } = resolve(id);
  entry.approved = null;
  const now = fullInfo(entry.kind, el);
  if (!sameApproved(now, approved.info)) {
    throw new Error(`승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${describeDifference(approved.info, now)}). 다시 찾으세요.`);
  }
  checkVisible(entry, el, approved.info.name, true);
  return { el, info: approved.info };
}

// 승인 확인 뒤 실제 실행까지 페이지 코드가 돌 틈이 있으면(스크롤·포커스 처리기 등) 실행 바로 앞에서 다시 본다.
// 같으면 null, 다르면 이유.
export function recheckApproved(kind: TargetKind, el: HTMLElement, info: TargetInfo): string | null {
  if (!el.isConnected || !getAccessibleDocs().includes(el.ownerDocument)) return "대상이 페이지에서 사라짐";
  const now = fullInfo(kind, el);
  if (!sameApproved(now, info)) return describeDifference(info, now);
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
      for (const r of records) {
        // 우리가 붙이는 id 속성은 세지 않는다.
        if (r.type === "attributes" && r.attributeName?.startsWith("data-sbp-")) continue;
        watch.mutations++;
      }
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
    for (const r of o.takeRecords()) {
      if (r.type === "attributes" && r.attributeName?.startsWith("data-sbp-")) continue;
      watch.mutations++;
    }
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
