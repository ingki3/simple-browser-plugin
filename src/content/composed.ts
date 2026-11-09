// 합성 트리(화면에 그려지는 트리) 순회 — 한 곳에 둔다(#284 리뷰 3차). 규칙:
// - shadow host의 자식은 shadow root의 자식이다(호스트의 light 자식은 slot에 배치될 때만 그 slot 자리에 든다).
// - slot의 자식은 배치된 노드(assignedNodes — 한 단계씩 따라가면 flatten과 같다)이고, 배치된 것이 없으면 slot의 기본 내용이다.
// - 같은 출처 iframe 문서의 노드는 다른 realm이라 instanceof를 쓰지 않고 nodeType으로 본다. iframe 경계는 넘지 않는다
//   (프레임 문서는 별도 문서다 — 반복 작업 작전은 프레임을 감싼 영역을 받지 않는다).
// 화면 글자(modelText)·영역 버튼(findClickables within)·영역 모양(skeletonOf)·프레임 검사가 모두 이 규칙을 쓴다 —
// 영역의 모든 관측이 같은 노드 집합을 보게.

const ELEMENT = 1;
const FRAGMENT = 11;

const isElement = (n: Node): n is Element => n.nodeType === ELEMENT;

// 합성 트리의 자식 노드(글자 노드 포함).
export function composedChildNodes(node: Node): Node[] {
  if (isElement(node)) {
    if (node.localName === "slot") {
      const assigned = (node as HTMLSlotElement).assignedNodes();
      if (assigned.length) return assigned;
    }
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
  }
  return Array.from(node.childNodes);
}

export function composedChildren(el: Element): Element[] {
  return composedChildNodes(el).filter(isElement);
}

// 합성 트리의 부모. null: 맨 위(문서·프레임 문서의 뿌리). undefined: 합성 트리에 들지 않는 노드(배치되지 않은 호스트의
// light 자식, 배치된 노드가 있는 slot의 기본 내용) — 화면에 그려지지 않는다.
export function composedParentNode(n: Node): Node | null | undefined {
  const slot = (n as Element | Text).assignedSlot;
  if (slot) return slot;
  const p = n.parentNode;
  if (!p) return null;
  if (p.nodeType === FRAGMENT) return (p as ShadowRoot).host ?? null;
  if (!isElement(p)) return null;
  if (p.shadowRoot) return undefined;
  if (p.localName === "slot" && (p as HTMLSlotElement).assignedNodes().length) return undefined;
  return p;
}

// node가 root의 합성 트리 안(root 자신 포함)인지. composedChildNodes로 root에서 내려가 닿는 노드와 같은 집합이다.
export function composedContains(root: Node, node: Node): boolean {
  let cur: Node | null | undefined = node;
  for (let i = 0; cur && i < 10_000; i++) {
    if (cur === root) return true;
    cur = composedParentNode(cur);
  }
  return false;
}

// root 아래(root 자신 제외) 요소를 합성 트리 문서 순서로 돈다. visit가 true를 돌려주면 멈춘다. 한도를 넘으면 "cut".
export function walkComposed(root: Element, visit: (el: Element) => boolean | void, max = 20_000): "done" | "stopped" | "cut" {
  const stack: Element[] = composedChildren(root).reverse();
  let n = 0;
  while (stack.length) {
    const el = stack.pop()!;
    if (++n > max) return "cut";
    if (visit(el)) return "stopped";
    const kids = composedChildren(el);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return "done";
}
