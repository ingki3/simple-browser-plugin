// 찾기·실행 도구가 모델에 돌려주는 글자(#43). 화면 글자는 보내고, 사용자가 입력한 값은 보내지 않는다.
// - modelText: 요소 아래의 글자를 모은다. 값 컨트롤(input·textarea·select)·편집 영역·숨은 요소의 하위 트리는 뺀다.
// - modelName: 모델에 보여 줄 대상 이름(라벨·접근성 이름·버튼 글자).
// 둘 다 시작하기 전에 시작 요소와 그 조상이 보호 영역인지 먼저 본다(편집 영역 안의 버튼, aria-labelledby가
// 편집 영역 안을 가리키는 경우 등). 내부 대상 비교·위험 판정은 이 글자가 아니라 원문을 쓴다(targets.ts).

import { NAME_ATTRS, VALUE_CONTROL_TAGS, cleanModelText, protectedReason, type ProtectFacts } from "@/lib/modelText";
import { isShadowRoot, isTag } from "./docs";

function factsOf(el: Element): ProtectFacts {
  let display: string | null = null;
  let visibility: string | null = null;
  try {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    display = style?.display ?? null;
    visibility = style?.visibility ?? null;
  } catch {
    /* 계산 스타일을 못 읽으면 속성만 본다 */
  }
  return {
    tag: el.localName,
    contentEditable: el.getAttribute("contenteditable"),
    hidden: el.hasAttribute("hidden"),
    ariaHidden: (el.getAttribute("aria-hidden") ?? "").trim().toLowerCase() === "true",
    display,
    visibility,
  };
}

const MAX_ANCESTORS = 400;

// select의 선택지가 숨겨졌는지: 선택지에서 select까지의 모든 요소(optgroup, 커스텀 select의 감싼 요소 포함) 중
// hidden·aria-hidden·display:none·편집 영역이 있으면 숨긴 것. select 자신은 값 컨트롤이라 inProtectedArea로 볼 수
// 없어 따로 본다(선택지의 계산 스타일에는 조상의 display:none이 드러나지 않는다).
export function optionHidden(o: Element): boolean {
  for (let cur: Element | null = o; cur && cur.localName !== "select"; cur = cur.parentElement) {
    const reason = protectedReason(factsOf(cur));
    if (reason === "hidden" || reason === "editable") return true;
  }
  return false;
}

// el이 보호 영역 안인지. 위로 올라가며 DOM 부모, shadow root의 host, 슬롯에 배치된 노드의 슬롯 쪽 조상,
// 같은 출처 iframe의 frame 요소까지 본다. selfIsControl이면 시작 요소 자신(값 컨트롤)의 '컨트롤' 사유는 빼고 본다
// (컨트롤의 공개 이름은 계산하고 값만 읽지 않는다). 그때도 컨트롤 자신의 숨김·편집 속성은 본다.
export function inProtectedArea(el: Element, selfIsControl = false): boolean {
  const seen = new Set<Element>();
  const queue: Element[] = [el];
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    // 끝까지 보지 못하면 보호 영역으로 본다(덜 보내는 쪽).
    if (++visited > MAX_ANCESTORS) return true;
    const facts = factsOf(cur);
    // 시작 요소가 값 컨트롤이면 '컨트롤'이라는 사유만 빼고(이름은 계산한다) 자신의 숨김·편집 여부는 그대로 본다.
    const selfControl = cur === el && selfIsControl && VALUE_CONTROL_TAGS.has(cur.localName);
    const reason = protectedReason(selfControl ? { ...facts, tag: "" } : facts);
    // 글자 아닌 요소(script 등)는 조상으로서는 문제가 아니다.
    if (reason && reason !== "non_text") return true;
    if (cur.ownerDocument.designMode === "on") return true;
    if (cur.assignedSlot) queue.push(cur.assignedSlot);
    if (cur.parentElement) queue.push(cur.parentElement);
    else {
      const root = cur.getRootNode();
      if (isShadowRoot(root)) queue.push(root.host);
      else {
        let frame: Element | null = null;
        try {
          frame = cur.ownerDocument.defaultView?.frameElement ?? null;
        } catch {
          frame = null;
        }
        if (frame) queue.push(frame);
      }
    }
  }
  return false;
}

// 줄 안에 흐르는 요소(이 경계에서는 글자를 띄우지 않는다: <b>계</b>정 → "계정"). inline-block·inline-flex 같은
// 줄 안 박스도 포함한다(사이에 공백 글자가 있으면 그 글자로 띄워진다).
function inlineDisplay(display: string | null): boolean {
  const d = display ?? "inline";
  return d.startsWith("inline") || d === "contents" || d.startsWith("ruby");
}

// root 아래의 글자(합성 트리 순서: 열린 shadow root와 슬롯에 배치된 노드 포함). 보호 요소의 하위 트리는 뺀다.
// 슬롯은 평탄화하지 않고 한 단계씩 따라간다(안쪽 슬롯 자신의 보호 속성도 검사하게).
export function modelText(root: Element, max: number): string {
  if (inProtectedArea(root)) return "";
  return subtreeText(root, max);
}

// root 아래 글자만 모은다(root 자신과 조상의 보호 판정은 부르는 쪽이 한다 — select 안의 선택지처럼 조상이 값 컨트롤인 경우).
export function subtreeText(root: Element, max: number): string {
  const limit = max * 4;
  let out = "";
  const childrenOf = (node: Node): Node[] => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.localName === "slot") {
        const assigned = (el as HTMLSlotElement).assignedNodes();
        if (assigned.length) return assigned;
      }
      if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    }
    return Array.from(node.childNodes);
  };
  // 문자열 항목은 블록 요소가 끝날 때 넣을 공백.
  const stack: Array<Node | string> = childrenOf(root).reverse();
  while (stack.length && out.length < limit) {
    const node = stack.pop()!;
    if (typeof node === "string") {
      out += node;
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node as Text).data;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const facts = factsOf(node as Element);
    if (protectedReason(facts) !== null) continue;
    // 블록 경계의 글자만 띄운다(줄 안 요소 경계는 붙인다).
    const block = !inlineDisplay(facts.display) || facts.tag === "br";
    if (block) {
      out += " ";
      stack.push(" ");
    }
    const kids = childrenOf(node);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return cleanModelText(out, max);
}

function refText(el: Element, attr: string, max: number): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) {
    // 같은 Document/ShadowRoot 안에서만 찾는다(다른 루트의 같은 id로 대신하지 않는다).
    const ref = root.getElementById?.(id) ?? null;
    if (ref) parts.push(modelText(ref, max));
  }
  return cleanModelText(parts.join(" "), max);
}

const BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset"]);

// 모델에 보여 줄 대상 이름. 순서: aria-labelledby → aria-label → 연결된 label → 자신의 글자 → title → placeholder → alt.
// 첫 번째로 비지 않은 것을 쓴다. 값 컨트롤의 값은 읽지 않는다(버튼형 input의 value·alt는 페이지가 만든 버튼 이름).
export function modelName(el: HTMLElement, max = 200): string {
  const control = VALUE_CONTROL_TAGS.has(el.localName);
  if (inProtectedArea(el, control)) return "";
  const attr = (name: string) => cleanModelText(el.getAttribute(name) ?? "", max);
  const candidates: Array<() => string> = [
    () => refText(el, "aria-labelledby", max),
    () => attr("aria-label"),
    () => {
      const labels = control ? Array.from((el as HTMLInputElement).labels ?? []) : [];
      return cleanModelText(labels.map((l) => modelText(l, max)).join(" "), max);
    },
    () => {
      if (isTag(el, "input")) {
        const type = (el.type || "text").toLowerCase();
        if (BUTTON_INPUT_TYPES.has(type)) return cleanModelText(el.value ?? "", max);
        if (type === "image") return attr("alt");
        return "";
      }
      return control ? "" : modelText(el, max);
    },
    () => attr("title"),
    () => (isTag(el, "input") || isTag(el, "textarea") ? attr("placeholder") : ""),
    () => attr("alt"),
  ];
  for (const get of candidates) {
    const v = get();
    if (v) return v;
  }
  return "";
}

// query_dom 한 항목: 보호 영역 안이면 글자를 비우고 이름 성격의 속성도 돌려주지 않는다.
export function modelAttr(el: Element, name: string, protectedArea: boolean): string | null {
  if (protectedArea && NAME_ATTRS.has(name)) return null;
  const v = el.getAttribute(name);
  return v === null ? null : v.slice(0, 500);
}
