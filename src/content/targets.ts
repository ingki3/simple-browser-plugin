// 조작 대상 등록·확인. find_clickables·find_form_fields가 돌려준 id를 그때의 대상 기술(TargetInfo)과 함께
// 이 content script 메모리에 둔다(페이지 스크립트는 볼 수 없다). 승인 카드를 띄울 때 지금 요소가 그때와 같은지
// 확인하고 승인할 기술을 남기며, 실행 직전에 다시 그 기술과 같을 때만 실행한다.
// 요소가 다시 그려져 사라졌으면 같은 기술의 요소가 정확히 하나일 때만 그 요소로 바꾼다. 비슷한 요소로 대신하지 않는다.

import type { PageRegion } from "@/lib/messages";
import { describeDifference, sameApproved, sameBase, type TargetInfo } from "@/lib/actionTarget";
import { getAccessibleRoots, isShadowRoot } from "./docs";

export interface TargetKind {
  // id 앞글자("c" 클릭, "f" 입력 칸)와 요소에 붙이는 속성.
  prefix: string;
  attr: string;
  // 다시 찾을 때 훑는 요소.
  selector: string;
  visible(el: HTMLElement): boolean;
  name(el: HTMLElement): string;
  fieldType(el: HTMLElement): string;
  sensitive(el: HTMLElement): TargetInfo["sensitive"];
}

interface Entry {
  kind: TargetKind;
  ref: WeakRef<HTMLElement>;
  base: TargetInfo;
  approved: { callId: string; info: TargetInfo } | null;
}

// content script가 새로 뜰 때마다(페이지 이동) 바뀐다. 이전 페이지의 id가 새 페이지의 다른 요소를 가리키지 않게 한다.
const TOKEN = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
const MAX_ENTRIES = 3000;
const registry = new Map<string, Entry>();
let counter = 0;

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
  };
}

// 목록 판별용 틀: 태그 + 숫자 없는 class + 자식 태그 모양. 같은 틀 형제가 3개 이상이면 목록으로 본다.
function shapeOf(el: Element): string {
  const raw = el.getAttribute("class") ?? "";
  const cls = raw
    .trim()
    .split(/\s+/)
    .filter((c) => c && !/\d{2,}/.test(c))
    .sort()
    .join(".");
  const kids = new Set<string>();
  for (const k of el.children) kids.add(k.localName);
  return `${el.localName}.${cls}(${[...kids].sort().join(",")})`;
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
  for (let depth = 0; cur && depth < 6; depth++) {
    const parent: Element | null = cur.parentElement;
    if (!parent || parent === cur.ownerDocument.body) break;
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

export function registerTarget(kind: TargetKind, el: HTMLElement): string {
  const existing = el.getAttribute(kind.attr);
  const entry = existing ? registry.get(existing) : undefined;
  const base = baseInfo(kind, el);
  if (existing && entry && entry.ref.deref() === el) {
    // 다시 찾을 때 글자 등이 바뀌었으면 새 기술로 갱신한다(모델은 지금 결과를 보고 고른다).
    entry.base = base;
    entry.approved = null;
    return existing;
  }
  counter += 1;
  const id = `${kind.prefix}${counter}-${TOKEN}`;
  el.setAttribute(kind.attr, id);
  registry.set(id, { kind, ref: new WeakRef(el), base, approved: null });
  if (registry.size > MAX_ENTRIES) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  return id;
}

function staleError(id: string): Error {
  return new Error(
    `id '${id}'는 지금 페이지에서 찾은 대상이 아닙니다(페이지가 바뀌었거나 다시 불러옴). find_clickables·find_form_fields로 다시 찾으세요.`,
  );
}

// 사라진 요소를 같은 기술로 다시 찾는다. 정확히 하나일 때만.
// 목록 안 요소는 바꾸지 않는다. 행마다 같은 '삭제' 버튼이 있으면 이름·순번이 같아도 다른 행일 수 있다
// (승인한 행이 지워지고 다음 행이 그 순번으로 올라온 경우). 목록 밖의 고정 컨트롤만 다시 찾는다.
function relocate(entry: Entry, want: TargetInfo, match: (a: TargetInfo, b: TargetInfo) => boolean): HTMLElement {
  if (want.list) {
    throw new Error(`목록 안의 대상 '${want.name}'이(가) 다시 그려져 같은 항목인지 확인할 수 없습니다. 다시 찾으세요.`);
  }
  const hits: HTMLElement[] = [];
  for (const root of getAccessibleRoots()) {
    for (const el of root.querySelectorAll<HTMLElement>(entry.kind.selector)) {
      if (el.localName !== want.tag || !entry.kind.visible(el)) continue;
      if (entry.kind.name(el) !== want.name) continue;
      const info = fullInfo(entry.kind, el);
      if (info.list) {
        throw new Error(`대상 '${want.name}'이(가) 다시 그려졌는데 같은 이름의 요소가 목록 안에 있어 어느 것인지 확정할 수 없습니다. 다시 찾으세요.`);
      }
      if (match(info, want)) hits.push(el);
      if (hits.length > 1) break;
    }
    if (hits.length > 1) break;
  }
  if (hits.length === 0) throw new Error(`대상 '${want.name}'이(가) 페이지에서 사라졌습니다. 다시 찾으세요.`);
  if (hits.length > 1) {
    throw new Error(`대상 '${want.name}'이(가) 다시 그려졌는데 같은 모양의 요소가 여러 개라 어느 것인지 확정할 수 없습니다. 다시 찾으세요.`);
  }
  return hits[0];
}

function resolve(id: string, want: TargetInfo, match: (a: TargetInfo, b: TargetInfo) => boolean): {
  entry: Entry;
  el: HTMLElement;
} {
  const entry = registry.get(id);
  if (!entry) throw staleError(id);
  let el = entry.ref.deref();
  if (el && el.isConnected && el.getAttribute(entry.kind.attr) !== id) {
    // 페이지가 속성만 지우거나 바꿨다. 등록한 요소는 그대로 있으니 표시만 되돌린다(기술 확인은 호출한 쪽이 한다).
    el.setAttribute(entry.kind.attr, id);
  }
  if (!el || !el.isConnected) {
    el = relocate(entry, want, match);
    // 페이지가 같은 속성을 다른 요소에 붙여 놓았을 수 있으니 이전 표시는 지운다.
    for (const root of getAccessibleRoots()) {
      for (const other of root.querySelectorAll<HTMLElement>(`[${entry.kind.attr}="${CSS.escape(id)}"]`)) {
        if (other !== el) other.removeAttribute(entry.kind.attr);
      }
    }
    el.setAttribute(entry.kind.attr, id);
    entry.ref = new WeakRef(el);
  }
  return { entry, el };
}

// 승인 카드용: 지금 요소가 find_* 때와 같은지 확인하고, 목록 위치까지 담은 기술을 이 호출(callId)의 승인 대상으로 남긴다.
export function inspectTarget(id: string, callId: string): TargetInfo {
  const known = registry.get(id);
  if (!known) throw staleError(id);
  const { entry, el } = resolve(id, known.base, sameBase);
  const now = baseInfo(entry.kind, el);
  if (!sameBase(now, entry.base)) {
    throw new Error(`대상 '${id}'의 ${describeDifference(entry.base, now)}. 다시 찾으세요.`);
  }
  if (!entry.kind.visible(el)) throw new Error(`대상 '${entry.base.name}'이(가) 지금 화면에 보이지 않습니다.`);
  const info = fullInfo(entry.kind, el);
  entry.approved = { callId, info };
  return info;
}

// 실행 직전: 이 호출에서 승인한 기술과 지금 요소가 같을 때만 요소를 돌려준다. 승인은 한 번만 쓴다.
export function takeApproved(id: string, callId: string): HTMLElement {
  const known = registry.get(id);
  if (!known) throw staleError(id);
  const approved = known.approved;
  if (!approved || approved.callId !== callId) {
    throw new Error(`대상 '${id}'은(는) 이 호출에서 승인되지 않았습니다.`);
  }
  const { entry, el } = resolve(id, approved.info, sameApproved);
  entry.approved = null;
  const now = fullInfo(entry.kind, el);
  if (!sameApproved(now, approved.info)) {
    throw new Error(`승인한 뒤 대상이 바뀌어 실행하지 않았습니다(${describeDifference(approved.info, now)}). 다시 찾으세요.`);
  }
  if (!entry.kind.visible(el)) throw new Error(`대상 '${approved.info.name}'이(가) 지금 화면에 보이지 않아 실행하지 않았습니다.`);
  return el;
}

// 승인된 대상이 아직 같은지 실행 없이 확인만 한다(여러 칸을 채우기 전에 모두 확인).
export function peekApproved(id: string, callId: string): void {
  const known = registry.get(id);
  if (!known) throw staleError(id);
  const approved = known.approved;
  if (!approved || approved.callId !== callId) {
    throw new Error(`대상 '${id}'은(는) 이 호출에서 승인되지 않았습니다.`);
  }
  const { entry, el } = resolve(id, approved.info, sameApproved);
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

export function startEffectWatch(token: string): void {
  const watch: EffectWatch = {
    observers: [],
    mutations: 0,
    dialogsBefore: openDialogs(),
    timer: setTimeout(() => stopEffectWatch(token), WATCH_MAX_MS),
  };
  // 문서의 subtree 관찰은 shadow root 안으로 이어지지 않아, 열린 shadow root마다 따로 관찰한다.
  for (const root of getAccessibleRoots()) {
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
export function readEffect(token: string): { mutations: number; dialogOpened: boolean } | null {
  const watch = stopEffectWatch(token);
  if (!watch) return null;
  return { mutations: watch.mutations, dialogOpened: openDialogs() > watch.dialogsBefore };
}
