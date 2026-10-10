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

export function findElementByAttr(attr: string, value: string): HTMLElement | null {
  const selector = `[${attr}="${CSS.escape(value)}"]`;
  for (const root of getAccessibleRoots()) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}
