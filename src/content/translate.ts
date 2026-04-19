import { describeRoot, getAccessibleRoots, type Root } from "./docs";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "TEMPLATE"]);
const MAX_NODES_PER_PAGE = 2000;
const BATCH_NODE_LIMIT = 40;
const BATCH_CHAR_LIMIT = 1800;

interface PendingNode {
  node: Text;
  original: string;
}

const translatedNodes = new WeakSet<Text>();

function isMeaningfulText(s: string): boolean {
  const t = s.trim();
  if (t.length < 2) return false;
  if (/^[\s\d\p{P}\p{S}]+$/u.test(t)) return false;
  return true;
}

function isVisible(el: Element | null): boolean {
  if (!el) return false;
  const win = el.ownerDocument.defaultView ?? window;
  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (el instanceof HTMLElement && el.hidden) return false;
  return true;
}

function ownerDocOf(root: Node): Document {
  if (root.nodeType === Node.DOCUMENT_NODE) return root as Document;
  if (root instanceof ShadowRoot) return root.ownerDocument;
  return (root as Element).ownerDocument;
}

function collectTextNodes(root: Node): PendingNode[] {
  const results: PendingNode[] = [];
  const doc = ownerDocOf(root);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node as Text;
      if (translatedNodes.has(text)) return NodeFilter.FILTER_REJECT;
      const parent = text.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      if (!isMeaningfulText(text.data)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let n = walker.nextNode() as Text | null;
  while (n && results.length < MAX_NODES_PER_PAGE) {
    results.push({ node: n, original: n.data });
    n = walker.nextNode() as Text | null;
  }
  return results;
}

function batchNodes(nodes: PendingNode[]): PendingNode[][] {
  const batches: PendingNode[][] = [];
  let current: PendingNode[] = [];
  let chars = 0;
  for (const p of nodes) {
    const len = p.original.length;
    if (current.length >= BATCH_NODE_LIMIT || chars + len > BATCH_CHAR_LIMIT) {
      if (current.length) batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function requestTranslation(texts: string[], targetLang: string): Promise<string[]> {
  const res = (await chrome.runtime.sendMessage({
    kind: "translate_text_batch",
    texts,
    targetLang,
  })) as { ok: boolean; data?: string[]; error?: string };
  if (!res?.ok || !Array.isArray(res.data)) {
    throw new Error(res?.error ?? "번역 요청 실패");
  }
  return res.data;
}

async function runConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      results[my] = await fn(items[my]);
    }
  });
  await Promise.all(workers);
  return results;
}

let observer: MutationObserver | null = null;
let activeTargetLang: string | null = null;

function applyTranslation(batch: PendingNode[], translated: string[]): number {
  let swapped = 0;
  batch.forEach((p, i) => {
    const t = translated[i];
    if (typeof t !== "string" || !t) return;
    translatedNodes.add(p.node);
    if (t === p.original) return;
    p.node.data = t;
    swapped += 1;
  });
  return swapped;
}

function scheduleObserver(targetLang: string): void {
  if (observer) observer.disconnect();
  activeTargetLang = targetLang;
  let queue: PendingNode[] = [];
  let timer: number | null = null;

  const flush = async () => {
    timer = null;
    if (!queue.length || activeTargetLang !== targetLang) return;
    const pending = queue;
    queue = [];
    const batches = batchNodes(pending);
    try {
      await runConcurrent(batches, 2, async (batch) => {
        const texts = batch.map((p) => p.original);
        const translated = await requestTranslation(texts, targetLang);
        applyTranslation(batch, translated);
      });
    } catch (err) {
      console.warn("[translate observer]", err);
    }
  };

  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((added) => {
        if (added.nodeType === Node.TEXT_NODE) {
          const parent = added.parentElement;
          if (parent && !SKIP_TAGS.has(parent.tagName)) {
            const text = (added as Text).data;
            if (isMeaningfulText(text)) {
              queue.push({ node: added as Text, original: text });
            }
          }
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          const fresh = collectTextNodes(added as Element);
          queue.push(...fresh);
        }
      });
    }
    if (queue.length && timer === null) {
      timer = window.setTimeout(flush, 300);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: false });
}

function rootScanTarget(root: Root): Node | null {
  if (root instanceof ShadowRoot) return root;
  return root.body ?? null;
}

export async function translatePage(args: { targetLang: string; scope?: "visible" | "article" }): Promise<{ translatedNodes: number; perRoot: Array<{ name: string; collected: number }>; totalCollected: number }> {
  const allNodes: PendingNode[] = [];
  const perRoot: Array<{ name: string; collected: number }> = [];
  for (const root of getAccessibleRoots()) {
    const target = rootScanTarget(root);
    if (!target) {
      perRoot.push({ name: describeRoot(root), collected: 0 });
      continue;
    }
    const before = allNodes.length;
    allNodes.push(...collectTextNodes(target));
    const added = allNodes.length - before;
    perRoot.push({ name: describeRoot(root), collected: added });
    if (allNodes.length >= MAX_NODES_PER_PAGE) break;
  }
  const nodes = allNodes.slice(0, MAX_NODES_PER_PAGE);
  const batches = batchNodes(nodes);
  let total = 0;

  await runConcurrent(batches, 4, async (batch) => {
    const texts = batch.map((p) => p.original);
    try {
      const translated = await requestTranslation(texts, args.targetLang);
      total += applyTranslation(batch, translated);
    } catch (err) {
      console.warn("[translate batch]", err);
    }
  });

  scheduleObserver(args.targetLang);
  return { translatedNodes: total, perRoot, totalCollected: nodes.length };
}
