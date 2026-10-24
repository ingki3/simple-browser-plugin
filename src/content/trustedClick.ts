// 실제 입력 클릭(0.2.0)의 content script 쪽: 누를 점 계산, 누르기 직전 확인, 들어온 실제 입력을 보고 막는 가드.
// 보안 모델과 한계는 src/lib/trustedClick.ts 머리말.
import {
  clickPoint,
  clickPoints,
  GUARDED_EVENTS,
  GUARD_MS,
  type Point,
  type TrustedClickReport,
  type TrustedClickStatus,
} from "@/lib/trustedClick";
import { isTag } from "./docs";

// 승인한 대상 안에 있어도 따로 활성화되는 요소(링크·버튼·입력·프레임 등). 실제 입력이 이것에 닿으면 승인한 대상이 아닌
// 그 요소가 동작하므로(기존 el.click()과 다름) 누르지 않는다. 구조(요소 종류·역할)로만 정한다.
// a는 href 유무·이름공간과 관계없이(SVG의 xlink:href 링크 포함) 링크로 본다.
const INDEPENDENT_SELECTOR = [
  "a",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "iframe",
  "frame",
  "embed",
  "object",
  "summary",
  "video[controls]",
  "audio[controls]",
  '[contenteditable]:not([contenteditable="false" i])',
  '[role="button"]',
  '[role="link"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="tab"]',
  '[role="combobox"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
].join(", ");

// 평평한 트리(slot 배치 포함)에서 부모. shadow root면 host로 올라간다.
// 닫힌 shadow root에 배치된 요소는 assignedSlot이 null이라(DOM 표준), 부모 host의 닫힌 root에서 그 노드를 받은 slot을
// 직접 찾는다(그 안의 제출 버튼 등을 건너뛰지 않게).
function flatParent(node: Node): Node | null {
  const slot = (node as Element).assignedSlot ?? closedSlotOf(node);
  if (slot) return slot;
  const parent = node.parentNode;
  if (parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (parent as ShadowRoot).host) return (parent as ShadowRoot).host;
  return parent;
}

function closedSlotOf(node: Node): HTMLSlotElement | null {
  const host = node.parentNode;
  if (!host || host.nodeType !== Node.ELEMENT_NODE || (host as Element).shadowRoot) return null;
  const root = shadowOf(host as Element);
  if (!root) return null;
  for (const slot of Array.from(root.querySelectorAll("slot"))) {
    if (slot.assignedNodes().includes(node as ChildNode)) return slot;
  }
  return null;
}

// node에서 el까지(el 제외) 올라가며 거친 요소. el 안이 아니면 null.
function chainTo(node: Node, el: Element): Element[] | null {
  const out: Element[] = [];
  for (let cur: Node | null = node; cur; cur = flatParent(cur)) {
    if (cur === el) return out;
    if (cur.nodeType === Node.ELEMENT_NODE) out.push(cur as Element);
  }
  return null;
}

// 승인한 대상이 아닌, 따로 활성화되거나 자기 동작을 선언한 요소가 사이에 있으면 그 요소. label을 승인했을 때 그 label의 컨트롤은
// 기존 el.click()도 활성화하므로 같은 동작으로 본다.
// 자기 동작을 속성으로 선언한 요소: 인라인 처리기(on*), htmx(hx-*·data-hx-*). 링크(a, SVG a 포함)·제출 컨트롤은
// INDEPENDENT_SELECTOR가 본다(SVG use의 href 같은 참조는 동작이 아니라 넣지 않는다).
// 승인 판정은 대상 요소의 선언만 보므로, 실제 입력이 이런 자식에 닿으면 승인하지 않은 동작이 될 수 있다.
// 속성 이름(구조)으로만 판단한다. addEventListener로 건 처리기는 볼 수 없다(한계).
function declaresAction(n: Element): boolean {
  for (const name of n.getAttributeNames()) {
    const a = name.toLowerCase();
    if (a.startsWith("on") || a.startsWith("hx-") || a.startsWith("data-hx-")) return true;
  }
  return false;
}

function independentIn(chain: readonly Element[], el: Element): Element | null {
  for (const n of chain) {
    if (!n.matches(INDEPENDENT_SELECTOR) && !declaresAction(n)) continue;
    if (isTag(el, "label") && (el as HTMLLabelElement).control === n) continue;
    return n;
  }
  return null;
}

// 요소의 shadow root(닫힌 것 포함 — content script만 chrome.dom으로 열어 볼 수 있다).
function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  try {
    return (chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) as ShadowRoot | null | undefined) ?? null;
  } catch {
    return null;
  }
}

// 점에서 맨 위 요소. 열린·닫힌 shadow root 안으로 따라 내려간다(실제 입력은 닫힌 root 안의 요소도 활성화하므로).
function hitAt(doc: Document, p: Point): Element | null {
  let hit = doc.elementFromPoint(p.x, p.y);
  for (let root = hit ? shadowOf(hit) : null; hit && root; root = shadowOf(hit)) {
    const inner = root.elementFromPoint(p.x, p.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

export type PointCheck = { ok: true } | { ok: false; reason: string; inside: boolean };

// 점을 누르면 el이 받는지. inside: el 안의 다른 활성 요소가 받는 경우(덮개가 아님).
export function checkPoint(el: HTMLElement, p: Point): PointCheck {
  const hit = hitAt(el.ownerDocument, p);
  if (!hit) return { ok: false, reason: "누를 자리에 요소가 없음", inside: false };
  const chain = chainTo(hit, el);
  if (!chain) {
    // 덮은 요소의 태그·역할만 알린다(글자는 담지 않는다).
    const role = hit.getAttribute("role");
    return { ok: false, reason: `다른 요소(${hit.localName}${role ? ` role=${role.slice(0, 20)}` : ""})가 대상을 덮고 있음`, inside: false };
  }
  const other = independentIn(chain, el);
  if (other) return { ok: false, reason: `대상 안의 다른 ${other.tagName.toLowerCase()} 요소가 받음`, inside: true };
  return { ok: true };
}

function rectsOf(el: HTMLElement) {
  return Array.from(el.getClientRects()).map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
}

// 대상의 누를 점(top 문서 viewport 기준 CSS px). top 문서의 대상만 다룬다.
export function pointOf(el: HTMLElement): Point | null {
  if (el.ownerDocument !== document) return null;
  return clickPoint(rectsOf(el), { width: window.innerWidth, height: window.innerHeight });
}

export type PointChoice =
  | { ok: true; point: Point }
  | { ok: false; reason: string; inside: boolean };

// 대상에 닿는 첫 후보 점(#89). 가운데가 덮였으면 다른 점을 본다. 모두 실패하면 대상 안의 다른 활성 요소가 받는 이유를
// 덮개보다 먼저 돌려준다(inside — 스크립트 클릭으로 대체할 이유).
export function choosePoint(el: HTMLElement): PointChoice | null {
  if (el.ownerDocument !== document) return null;
  const points = clickPoints(rectsOf(el), { width: window.innerWidth, height: window.innerHeight });
  if (!points.length) return null;
  let inside: string | null = null;
  let covered: string | null = null;
  for (const p of points) {
    const hit = checkPoint(el, p);
    if (hit.ok) return { ok: true, point: p };
    if (hit.inside) inside ??= hit.reason;
    else covered ??= hit.reason;
  }
  return inside ? { ok: false, reason: inside, inside: true } : { ok: false, reason: covered ?? "다른 요소가 대상을 덮고 있음", inside: false };
}

// 대상의 첫 사각형(위치가 바뀌었는지 보려고). 누를 점이 가운데가 아닐 수 있어 점 대신 상자를 비교한다.
export function boxOf(el: HTMLElement): { left: number; top: number; width: number; height: number } | null {
  const r = el.getClientRects()[0];
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

// ---------------------------------------------------------------------------
// 가드
// ---------------------------------------------------------------------------

// 재확인 단계. down: 첫 pointerdown(아직 페이지 처리기가 돌지 않음 — 엄격). up: mousedown·떼기(앞 단계 처리기가 펼침·눌림
// 같은 화면 상태를 바꿨을 수 있음). click: 브라우저가 checkbox·radio 상태를 먼저 바꾼 뒤.
export type RecheckPhase = "down" | "up" | "click";

interface TopGuard {
  el: HTMLElement;
  point: Point;
  // 준비 때 대상의 첫 사각형(누르기 직전 위치가 그대로인지 본다 — 누를 점이 가운데가 아닐 수 있어 상자로 비교).
  box: { left: number; top: number; width: number; height: number } | null;
  // 승인한 대상이 아직 같은지(clickables의 recheckApproved). 바뀌었으면 이유.
  recheck: (phase: RecheckPhase) => string | null;
  deadline: number;
  status: TrustedClickStatus;
  // 받은 실제 입력 종류(진단용, 앞의 몇 개만).
  seen: string[];
  remove: () => void;
  probe: () => boolean;
  probed: boolean;
}

const topGuards = new Map<string, TopGuard>();
const frameGuards = new Map<string, { remove: () => void; blocked: number }>();

function block(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

// extra: 같은 handler로 함께 붙이고 떼는 이벤트 이름(가드 생존 표지). 지울 때는 늘 함께 지워진다.
function listen(win: Window, handler: (e: Event) => void, ms: number, onExpire: () => void, extra: readonly string[] = []): () => void {
  const types = [...GUARDED_EVENTS, ...extra];
  for (const type of types) win.addEventListener(type, handler, true);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    for (const type of types) win.removeEventListener(type, handler, true);
  };
  // 만료 뒤에도 잠깐 더 막다가 푼다(만료 시점과 누르기가 겹쳐도 확인 없이 통과하지 않게).
  const timer = setTimeout(() => {
    onExpire();
    setTimeout(remove, 2_000);
  }, ms);
  return remove;
}

// top 문서 가드: 실제 입력이 승인한 대상(그 안의 장식 요소 포함)에만 가게 한다. 누르기 전 단계에서는 대상도 다시 확인한다.
// asApproved: click 단계의 확인(hit test·재확인)을 승인 때 체크 상태로 잠깐 되돌린 채 부른다(대상이 checkbox·radio이거나
// 그것을 작동시키는 label일 때 — 브라우저가 click 처리기보다 먼저 체크 상태와 그에 따른 배치를 바꾸므로).
export function armTopGuard(
  token: string,
  el: HTMLElement,
  point: Point,
  recheck: (phase: RecheckPhase) => string | null,
  asApproved: (check: () => string | null) => string | null = (check) => check(),
): void {
  disarm(token);
  const guard: TopGuard = {
    el,
    point,
    box: boxOf(el),
    recheck,
    deadline: Date.now() + GUARD_MS,
    status: { status: "none" },
    seen: [],
    remove: () => {},
    probe: () => false,
    probed: false,
  };
  // 가드 리스너가 아직 붙어 있는지 확인하는 표지(document.open·만료 정리는 리스너를 지운다). 입력을 막는 같은 handler에
  // 붙여, 입력 리스너가 지워지면 표지도 함께 사라진다. 이름은 토큰이라 페이지가 미리 알 수 없다.
  const probeType = `sbp-guard-${token}`;
  const handler = (e: Event) => {
    if (e.type === probeType) {
      guard.probed = true;
      return;
    }
    if (!e.isTrusted) return;
    if (guard.seen.length < 12) guard.seen.push(e.type);
    if (guard.status.status === "blocked") return block(e);
    if (guard.status.status === "clicked") return;
    // 확인 도중 예외(페이지가 양식 속성을 가리는 이름의 칸을 넣는 등)도 막는다 — 리스너의 예외는 이벤트를 취소하지 않는다.
    try {
      inspect(e);
    } catch {
      guard.status = { status: "blocked", reason: "확인 중 오류" };
      block(e);
    }
  };
  const inspect = (e: Event) => {
    const stop = (reason: string) => {
      guard.status = { status: "blocked", reason };
      block(e);
    };
    if (Date.now() > guard.deadline) return stop("확인 시간이 지남");
    // 누르기 한 번(mousePressed·mouseReleased)이 만드는 이벤트만 받는다.
    if (e.type === "auxclick" || e.type === "dblclick" || e.type === "contextmenu") return stop("예상하지 않은 입력");
    const path = e.composedPath();
    const at = path.indexOf(el);
    if (at < 0) return stop("다른 요소에 닿음");
    const chain = path.slice(0, at).filter((n): n is Element => n instanceof Element);
    const other = independentIn(chain, el);
    if (other) return stop(`대상 안의 다른 ${other.tagName.toLowerCase()} 요소에 닿음`);
    const phase: RecheckPhase = e.type === "click" ? "click" : e.type === "pointerdown" ? "down" : "up";
    const verify = (): string | null => {
      // composedPath는 닫힌 shadow root 안을 감추므로, 입력 좌표에서 닫힌 root까지 따라 내려가 다시 본다.
      if (e instanceof MouseEvent) {
        const hit = checkPoint(el, { x: e.clientX, y: e.clientY });
        if (!hit.ok) return hit.reason;
      }
      // 단계마다 대상 기술 전체(주소·양식 관계·위험 신호 포함)를 다시 본다 — 앞 단계 처리기가 href·formaction 등을 바꿨으면
      // 막는다. pointerdown 뒤에는 화면 상태(펼침·눌림 등, 체크 제외)의 변화만 허용한다(clickables의 phaseInfo).
      return recheck(phase);
    };
    // click 단계는 브라우저가 먼저 바꾼 체크 상태(와 그에 따른 배치)를 승인 때로 되돌린 채 본다.
    const changed = phase === "click" ? asApproved(verify) : verify();
    if (changed) return stop(changed);
    if (e.type === "click") {
      guard.status = { status: "clicked" };
      // 결과(status)는 백그라운드가 읽을 때까지 남기고 리스너만 뗀다.
      setTimeout(() => guard.remove(), 0);
    }
  };
  guard.probe = () => {
    guard.probed = false;
    window.dispatchEvent(new Event(probeType));
    return guard.probed && Date.now() <= guard.deadline;
  };
  guard.remove = listen(
    window,
    handler,
    GUARD_MS,
    () => {
      if (guard.status.status === "none") guard.status = { status: "blocked", reason: "확인 시간이 지남" };
    },
    [probeType],
  );
  topGuards.set(token, guard);
  // 결과를 읽지 않고 끝난 가드의 기록 정리.
  setTimeout(() => {
    if (topGuards.get(token) === guard) topGuards.delete(token);
  }, GUARD_MS + 60_000);
}

// 누르기 직전 확인: 가드가 이 문서에 살아 있고, 대상이 그대로이고, 점이 아직 대상을 가리키는지. 남은 시간(ms)을 돌려준다.
// 통과하지 못하면 가드를 막힘으로 바꾸고 오류를 던진다(이후 들어오는 실제 입력도 막는다).
export function checkBeforePress(token: string): number {
  const guard = topGuards.get(token);
  if (!guard) throw new Error("누르기 전 확인 정보를 찾을 수 없음(문서가 바뀜)");
  const fail = (reason: string): never => {
    guard.status = { status: "blocked", reason };
    throw new Error(reason);
  };
  if (guard.status.status !== "none") fail("이미 처리된 클릭");
  // 준비 뒤 페이지가 리스너를 지웠으면(document.open 등) 가드 없이 누르게 되므로 누르지 않는다.
  if (!guard.probe()) fail("확인 장치가 페이지에서 지워짐");
  const remaining = guard.deadline - Date.now();
  const changed = guard.recheck("down");
  if (changed) fail(changed);
  const now = boxOf(guard.el);
  const was = guard.box;
  const moved =
    !now ||
    !was ||
    Math.abs(now.left - was.left) > 1 ||
    Math.abs(now.top - was.top) > 1 ||
    Math.abs(now.width - was.width) > 1 ||
    Math.abs(now.height - was.height) > 1;
  if (moved) fail("대상의 위치가 바뀜");
  const hit = checkPoint(guard.el, guard.point);
  if (!hit.ok) fail(hit.reason);
  return remaining;
}

// 떼기 전 확인: 이 문서의 가드 리스너가 살아 있으면 true(떼기의 click을 가드가 판정할 수 있음).
export function guardAlive(token: string): boolean {
  const guard = topGuards.get(token);
  if (!guard) return false;
  try {
    return guard.probe();
  } catch {
    return false;
  }
}

export function guardResult(token: string): TrustedClickReport | null {
  const guard = topGuards.get(token);
  if (!guard) return null;
  return { ...guard.status, seen: [...guard.seen], viewport: { width: window.innerWidth, height: window.innerHeight } };
}

// 누르지 않기로 했으면 막힘으로 바꾼다(늦게 도착한 입력도 막도록 가드는 만료까지 둔다).
export function cancelGuard(token: string, reason: string): void {
  const guard = topGuards.get(token);
  if (guard && guard.status.status === "none") guard.status = { status: "blocked", reason };
}

// 다른 프레임 가드: 이 프레임으로 오는 실제 마우스 입력을 모두 막는다(대상은 top 문서에 있으므로).
export function armFrameGuard(token: string, ms: number): void {
  disarm(token);
  const state = { remove: () => {}, blocked: 0 };
  const handler = (e: Event) => {
    if (!e.isTrusted) return;
    state.blocked++;
    block(e);
  };
  state.remove = listen(window, handler, Math.min(ms, GUARD_MS), () => {});
  frameGuards.set(token, state);
}

export function disarm(token: string): void {
  const top = topGuards.get(token);
  if (top) {
    top.remove();
    topGuards.delete(token);
  }
  const frame = frameGuards.get(token);
  if (frame) {
    frame.remove();
    frameGuards.delete(token);
  }
}

// 프레임 가드가 막은 실제 입력 수(백그라운드가 결과를 정리할 때).
export function frameBlocked(token: string): number {
  return frameGuards.get(token)?.blocked ?? 0;
}
