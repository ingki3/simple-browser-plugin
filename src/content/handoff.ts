// 손 넘기기(직접 조작할 사이트, 0.2.2): 승인 대상(클릭할 요소·채울 칸)을 화면에 표시하고, 클릭이면 사용자가 그 요소를 실제로
// 눌렀는지 본다. 페이지의 이벤트를 막거나 바꾸지 않고(수동 리스너), 페이지에 입력·클릭을 보내지 않는다.
// 표시는 닫힌 shadow root 안의 고정 위치 상자(pointer-events: none)라 사용자의 조작을 가리지 않는다.
import { approvedElement } from "./targets";
import { visibleProxy } from "./forms";

// 사용자가 오래 자리를 비워도 표시가 남지 않게 하는 상한.
const HANDOFF_MAX_MS = 15 * 60_000;

interface Handoff {
  clicked: boolean;
  // 사용자가 대상을 처음 누른 시각(Date.now). 그 클릭이 연 팝업 창을 고르는 데 쓴다(#81).
  clickedAt: number;
  // 사용자가 HANDOFF_MAX_MS 동안 조작하지 않아 표시를 뗐음(문서 바뀜과 구분해 알린다).
  expired: boolean;
  // 같은 출처 iframe 안의 대상이면 그 프레임과 표시할 때의 문서(프레임만 이동하면 top 문서는 그대로라 따로 본다).
  frames: Array<{ el: Element; doc: Document }>;
  stop: () => void;
}

const handoffs = new Map<string, Handoff>();

const BOX_CSS = `
:host { all: initial; }
.box {
  position: fixed;
  box-sizing: border-box;
  border: 3px solid #f59e0b;
  border-radius: 6px;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.35);
  pointer-events: none;
  animation: sbp-pulse 1.2s ease-in-out infinite;
}
.badge {
  position: absolute;
  top: -12px;
  left: -12px;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 11px;
  background: #f59e0b;
  color: #111;
  font: 600 12px/22px system-ui, sans-serif;
  text-align: center;
}
@keyframes sbp-pulse { 50% { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0.15); } }
@media (prefers-reduced-motion: reduce) { .box { animation: none; } }
`;

// 화면에서 숨긴 칸(크기 0·투명 등)은 찾기 결과와 같은 기준으로 대신 보이는 label을 표시한다.
function shownElement(el: HTMLElement): HTMLElement {
  return visibleProxy(el) ?? el;
}

// 대상을 담은 모달 대화상자·팝오버(최상위 레이어). shadow 경계를 넘어 올라간다.
function topLayerOf(el: Element): Element | null {
  let node: Element | null = el;
  while (node) {
    try {
      if (node.matches("dialog:modal, :popover-open")) return node;
    } catch {
      return null;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

// 대상마다 그 문서에 표시 상자를 붙인다(같은 출처 iframe 안의 대상은 그 문서에).
function drawBoxes(targets: HTMLElement[]): () => void {
  const hosts: HTMLElement[] = [];
  const items: Array<{ el: HTMLElement; box: HTMLElement; host: HTMLElement }> = [];
  targets.forEach((el, i) => {
    const doc = el.ownerDocument;
    const host = doc.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = BOX_CSS;
    const box = doc.createElement("div");
    box.className = "box";
    if (targets.length > 1) {
      const badge = doc.createElement("span");
      badge.className = "badge";
      badge.textContent = String(i + 1);
      box.append(badge);
    }
    root.append(style, box);
    // 모달 대화상자·팝오버 안의 대상은 그 최상위 레이어 요소 안에 붙여야 가려지지 않는다.
    (topLayerOf(el) ?? doc.body ?? doc.documentElement).append(host);
    hosts.push(host);
    items.push({ el: shownElement(el), box, host });
  });
  let frame = 0;
  const place = () => {
    for (const { el, box, host } of items) {
      const r = el.isConnected ? el.getBoundingClientRect() : null;
      if (!r || (r.width === 0 && r.height === 0)) {
        box.style.display = "none";
        continue;
      }
      // 표시를 붙인 요소(transform이 있는 모달 등)가 fixed의 기준이 될 수 있어, 호스트의 화면 위치를 빼서 맞춘다.
      const origin = host.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = `${r.left - origin.left - 4}px`;
      box.style.top = `${r.top - origin.top - 4}px`;
      box.style.width = `${r.width + 8}px`;
      box.style.height = `${r.height + 8}px`;
    }
    frame = requestAnimationFrame(place);
  };
  place();
  return () => {
    cancelAnimationFrame(frame);
    for (const h of hosts) h.remove();
  };
}

// 표시를 시작한다. ids는 이 호출(callId)에서 확인한 승인 대상이어야 한다(다른 요소를 표시하지 않게).
export function showHandoff(token: string, ids: string[], callId: string, prefix: "c" | "f"): void {
  endHandoff(token);
  const targets = ids.map((id) => approvedElement(id, callId, prefix));
  if (targets.length === 0) throw new Error("표시할 대상이 없습니다.");
  const frames: Handoff["frames"] = [];
  for (const el of targets) {
    const frameEl = el.ownerDocument.defaultView?.frameElement;
    if (frameEl && !frames.some((f) => f.el === frameEl)) frames.push({ el: frameEl, doc: el.ownerDocument });
  }
  const state: Handoff = { clicked: false, clickedAt: 0, expired: false, frames, stop: () => {} };
  const removeBoxes = drawBoxes(targets);
  const cleanups: Array<() => void> = [removeBoxes];
  if (prefix === "c") {
    const el = targets[0];
    const win = el.ownerDocument.defaultView ?? window;
    // 사용자의 실제 클릭이 표시한 대상(또는 그 안)에 닿았는지만 본다. 막거나 바꾸지 않는다.
    const onClick = (e: MouseEvent) => {
      if (e.isTrusted && e.composedPath().includes(el) && !state.clicked) {
        state.clicked = true;
        state.clickedAt = Date.now();
      }
    };
    win.addEventListener("click", onClick, { capture: true, passive: true });
    cleanups.push(() => win.removeEventListener("click", onClick, { capture: true }));
  }
  // 만료되면 표시만 떼고 기록은 남긴다(백그라운드가 만료를 읽고 끝낸다).
  const timer = setTimeout(() => {
    state.expired = true;
    state.stop();
  }, HANDOFF_MAX_MS);
  let stopped = false;
  state.stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const c of cleanups) c();
  };
  handoffs.set(token, state);
  shownElement(targets[0]).scrollIntoView({ block: "center", inline: "nearest" });
}

export function handoffStatus(
  token: string,
): { clicked: boolean; clickedAt: number; expired: boolean; frameChanged: boolean } | null {
  const state = handoffs.get(token);
  if (!state) return null;
  // 대상이 든 iframe이 다른 문서로 바뀌었거나(다른 출처로 가면 contentDocument가 null) 빠졌는지.
  const frameChanged = state.frames.some(
    ({ el, doc }) => !el.isConnected || (el as HTMLIFrameElement).contentDocument !== doc,
  );
  return { clicked: state.clicked, clickedAt: state.clickedAt, expired: state.expired, frameChanged };
}

export function endHandoff(token: string): void {
  const state = handoffs.get(token);
  if (!state) return;
  handoffs.delete(token);
  state.stop();
}
