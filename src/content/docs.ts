const MAX_DEPTH = 4;
const XHTML_NS = "http://www.w3.org/1999/xhtml";

// 같은 출처 iframe의 요소는 그 iframe 창의 HTMLInputElement 등으로 만들어져서
// 이 스크립트 전역의 클래스로 instanceof 하면 항상 false다. 태그 이름으로 판별한다.
export function isTag<K extends keyof HTMLElementTagNameMap>(
  el: Element,
  tag: K,
): el is HTMLElementTagNameMap[K] {
  return el.localName === tag && el.namespaceURI === XHTML_NS;
}

export function isHtmlElement(node: Node | null): node is HTMLElement {
  return node?.nodeType === Node.ELEMENT_NODE && (node as Element).namespaceURI === XHTML_NS;
}

export function isShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in node;
}

export function getAccessibleDocs(root: Document = document, depth = 0): Document[] {
  const docs: Document[] = [root];
  if (depth >= MAX_DEPTH) return docs;
  const iframes = root.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>("iframe, frame");
  for (const frame of iframes) {
    let childDoc: Document | null = null;
    try {
      childDoc = frame.contentDocument;
    } catch {
      // cross-origin — skip
      childDoc = null;
    }
    if (!childDoc) continue;
    docs.push(...getAccessibleDocs(childDoc, depth + 1));
  }
  return docs;
}

// 내용을 읽을 수 없는 다른 출처 iframe(#235). 문서·열린 shadow root를 오가며(shadow root 안의 같은 출처 iframe 안까지) 찾는다.
// contentDocument를 못 읽는 frame만 돌려준다(보이는지·크기는 부르는 쪽이 본다).
export function crossOriginFrameElements(): Array<HTMLIFrameElement | HTMLFrameElement> {
  const out: Array<HTMLIFrameElement | HTMLFrameElement> = [];
  const seen = new Set<Node>();
  const walk = (root: Document | ShadowRoot, depth: number) => {
    if (seen.has(root) || depth > MAX_DEPTH) return;
    seen.add(root);
    for (const frame of root.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>("iframe, frame")) {
      let childDoc: Document | null = null;
      try {
        childDoc = frame.contentDocument;
      } catch {
        childDoc = null;
      }
      if (childDoc) walk(childDoc, depth + 1);
      else out.push(frame);
    }
    const shadows: ShadowRoot[] = [];
    collectShadowRoots(root, 0, shadows);
    for (const sr of shadows) walk(sr, depth);
  };
  walk(document, 0);
  return out;
}

export type Root = Document | ShadowRoot;

function collectShadowRoots(root: ParentNode, depth: number, out: ShadowRoot[]): void {
  if (depth >= MAX_DEPTH) return;
  const elements = root.querySelectorAll<Element>("*");
  for (const el of elements) {
    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr && sr.mode === "open") {
      out.push(sr);
      collectShadowRoots(sr, depth + 1, out);
    }
  }
}

/**
 * Returns every accessible traversable root:
 * - Top document
 * - Same-origin iframe documents (up to MAX_DEPTH)
 * - Open shadow roots within each of those documents (up to MAX_DEPTH)
 */
export function getAccessibleRoots(): Root[] {
  const roots: Root[] = [];
  for (const doc of getAccessibleDocs()) {
    roots.push(doc);
    const shadows: ShadowRoot[] = [];
    collectShadowRoots(doc, 0, shadows);
    roots.push(...shadows);
  }
  return roots;
}

export function describeRoot(root: Root): string {
  if (isShadowRoot(root)) return `shadow:${root.host.localName}`;
  try {
    return root.location?.href ?? "doc";
  } catch {
    return "doc";
  }
}

