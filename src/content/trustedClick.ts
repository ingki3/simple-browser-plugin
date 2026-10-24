// 실제 입력 클릭(0.2.0)의 content script 쪽: 누를 점 계산, 누르기 직전 확인, 들어온 실제 입력을 보고 막는 가드.
// 보안 모델과 한계는 src/lib/trustedClick.ts 머리말.
import { clickPoint, GUARDED_EVENTS, GUARD_MS, type Point, type TrustedClickStatus } from "@/lib/trustedClick";
import { isTag } from "./docs";

// 승인한 대상 안에 있어도 따로 활성화되는 요소(링크·버튼·입력·프레임 등). 실제 입력이 이것에 닿으면 승인한 대상이 아닌
// 그 요소가 동작하므로(기존 el.click()과 다름) 누르지 않는다. 구조(요소 종류·역할)로만 정한다.
const INDEPENDENT_SELECTOR = [
  "a[href]",
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
function flatParent(node: Node): Node | null {
  const slot = (node as Element).assignedSlot;
  if (slot) return slot;
  const parent = node.parentNode;
  if (parent && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE && (parent as ShadowRoot).host) return (parent as ShadowRoot).host;
  return parent;
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

// 승인한 대상이 아닌, 따로 활성화되는 요소가 사이에 있으면 그 요소. label을 승인했을 때 그 label의 컨트롤은
// 기존 el.click()도 활성화하므로 같은 동작으로 본다.
function independentIn(chain: readonly Element[], el: Element): Element | null {
  for (const n of chain) {
    if (!n.matches(INDEPENDENT_SELECTOR)) continue;
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
  if (!chain) return { ok: false, reason: "다른 요소가 대상을 덮고 있음", inside: false };
  const other = independentIn(chain, el);
  if (other) return { ok: false, reason: `대상 안의 다른 ${other.tagName.toLowerCase()} 요소가 받음`, inside: true };
  return { ok: true };
}

// 대상의 누를 점(top 문서 viewport 기준 CSS px). top 문서의 대상만 다룬다.
export function pointOf(el: HTMLElement): Point | null {
  if (el.ownerDocument !== document) return null;
  const rects = Array.from(el.getClientRects()).map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
  return clickPoint(rects, { width: window.innerWidth, height: window.innerHeight });
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
  // 승인한 대상이 아직 같은지(clickables의 recheckApproved). 바뀌었으면 이유.
  recheck: (phase: RecheckPhase) => string | null;
  deadline: number;
  status: TrustedClickStatus;
  remove: () => void;
}

const topGuards = new Map<string, TopGuard>();
const frameGuards = new Map<string, { remove: () => void; blocked: number }>();

function block(e: Event): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}

function listen(win: Window, handler: (e: Event) => void, ms: number, onExpire: () => void): () => void {
  for (const type of GUARDED_EVENTS) win.addEventListener(type, handler, true);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    clearTimeout(timer);
    for (const type of GUARDED_EVENTS) win.removeEventListener(type, handler, true);
  };
  // 만료 뒤에도 잠깐 더 막다가 푼다(만료 시점과 누르기가 겹쳐도 확인 없이 통과하지 않게).
  const timer = setTimeout(() => {
    onExpire();
    setTimeout(remove, 2_000);
  }, ms);
  return remove;
}

// top 문서 가드: 실제 입력이 승인한 대상(그 안의 장식 요소 포함)에만 가게 한다. 누르기 전 단계에서는 대상도 다시 확인한다.
export function armTopGuard(token: string, el: HTMLElement, point: Point, recheck: (phase: RecheckPhase) => string | null): void {
  disarm(token);
  const guard: TopGuard = {
    el,
    point,
    recheck,
    deadline: Date.now() + GUARD_MS,
    status: { status: "none" },
    remove: () => {},
  };
  const handler = (e: Event) => {
    if (!e.isTrusted) return;
    if (guard.status.status === "blocked") return block(e);
    if (guard.status.status === "clicked") return;
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
    // composedPath는 닫힌 shadow root 안을 감추므로, 입력 좌표에서 닫힌 root까지 따라 내려가 다시 본다.
    if (e instanceof MouseEvent) {
      const hit = checkPoint(el, { x: e.clientX, y: e.clientY });
      if (!hit.ok) return stop(hit.reason);
    }
    // 단계마다 대상 기술 전체(주소·양식 관계·위험 신호 포함)를 다시 본다 — 앞 단계 처리기가 href·formaction 등을 바꿨으면
    // 막는다. pointerdown 뒤에는 화면 상태(펼침·눌림 등, 체크 제외)의 변화만, click 단계는 브라우저가 바꾼 checkbox·radio
    // 상태의 예상 변화만 허용한다(clickables의 phaseInfo).
    const changed = recheck(e.type === "click" ? "click" : e.type === "pointerdown" ? "down" : "up");
    if (changed) return stop(changed);
    if (e.type === "click") {
      guard.status = { status: "clicked" };
      // 결과(status)는 백그라운드가 읽을 때까지 남기고 리스너만 뗀다.
      setTimeout(() => guard.remove(), 0);
    }
  };
  guard.remove = listen(window, handler, GUARD_MS, () => {
    if (guard.status.status === "none") guard.status = { status: "blocked", reason: "확인 시간이 지남" };
  });
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
  const remaining = guard.deadline - Date.now();
  const changed = guard.recheck("down");
  if (changed) fail(changed);
  const now = pointOf(guard.el);
  if (!now || Math.abs(now.x - guard.point.x) > 1 || Math.abs(now.y - guard.point.y) > 1) fail("대상의 위치가 바뀜");
  const hit = checkPoint(guard.el, guard.point);
  if (!hit.ok) fail(hit.reason);
  return remaining;
}

export function guardResult(token: string): TrustedClickStatus | null {
  return topGuards.get(token)?.status ?? null;
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
