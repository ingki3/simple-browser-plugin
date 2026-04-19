const MAX_DEPTH = 4;

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
  if (root instanceof ShadowRoot) {
    const host = root.host;
    const name = host instanceof Element ? host.tagName.toLowerCase() : "?";
    return `shadow:${name}`;
  }
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
