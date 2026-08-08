import { describeRoot, getAccessibleRoots, type Root } from "./docs";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "TEMPLATE"]);
const MAX_NODES_PER_PAGE = 2000;
const BATCH_NODE_LIMIT = 60;
const BATCH_CHAR_LIMIT = 2000;
const INITIAL_CONCURRENCY = 6;
const OBSERVER_FLUSH_MS = 300;
const BISECT_MAX_DEPTH = 6;

interface PendingNode {
  node: Text;
  original: string;
}

// node → 마지막으로 우리가 적용한 텍스트.
// "이미 번역됨" 표시 + characterData 옵저버의 self-write 감지용.
const translatedNodes = new WeakMap<Text, string>();

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

function isInViewport(node: Text): boolean {
  const el = node.parentElement;
  if (!el) return false;
  const win = el.ownerDocument.defaultView ?? window;
  const rect = el.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom >= 0 &&
    rect.right >= 0 &&
    rect.top <= win.innerHeight &&
    rect.left <= win.innerWidth
  );
}

function ownerDocOf(root: Node): Document {
  if (root.nodeType === Node.DOCUMENT_NODE) return root as Document;
  if (root instanceof ShadowRoot) return root.ownerDocument;
  return (root as Element).ownerDocument;
}

function isAlreadyTranslated(node: Text): boolean {
  const applied = translatedNodes.get(node);
  return applied !== undefined && applied === node.data;
}

function collectTextNodes(root: Node): PendingNode[] {
  const results: PendingNode[] = [];
  const doc = ownerDocOf(root);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node as Text;
      if (isAlreadyTranslated(text)) return NodeFilter.FILTER_REJECT;
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

function applyTranslation(batch: PendingNode[], translated: string[]): number {
  let swapped = 0;
  batch.forEach((p, i) => {
    const t = translated[i];
    if (typeof t !== "string") return;
    // 빈 응답: 원문 유지하되 "처리 완료"로 마킹해야 재큐잉/무한 재시도를 막음.
    if (!t) {
      translatedNodes.set(p.node, p.node.data);
      return;
    }
    if (t === p.original) {
      translatedNodes.set(p.node, p.node.data);
      return;
    }
    // WeakMap을 write 이전에 갱신해야 observer가 self-write를 판별할 수 있음.
    translatedNodes.set(p.node, t);
    p.node.data = t;
    swapped += 1;
  });
  return swapped;
}

// 배치가 실패하면 반으로 쪼개서 재시도.
// 하나의 나쁜 응답(길이 불일치, 파싱 실패, 거대한 항목 하나)으로 큰 배치가
// 통째로 유실되는 걸 막는 게 목적.
async function translateBatchWithRetry(
  batch: PendingNode[],
  targetLang: string,
  depth = 0,
): Promise<number> {
  if (!batch.length) return 0;
  const texts = batch.map((p) => p.original);
  try {
    const translated = await requestTranslation(texts, targetLang);
    return applyTranslation(batch, translated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const responseShapeError = /JSON 파싱|응답 길이 불일치/.test(message);
    if (!responseShapeError) throw err;
    if (batch.length > 1 && depth < BISECT_MAX_DEPTH) {
      const mid = Math.floor(batch.length / 2);
      const a = await translateBatchWithRetry(batch.slice(0, mid), targetLang, depth + 1);
      const b = await translateBatchWithRetry(batch.slice(mid), targetLang, depth + 1);
      return a + b;
    }
    console.warn(
      "[translate batch fail]",
      err,
      batch.map((p) => p.original.slice(0, 40)),
    );
    return 0;
  }
}

let observers: MutationObserver[] = [];
let activeTargetLang: string | null = null;

function scheduleObserver(targetLang: string): void {
  for (const obs of observers) obs.disconnect();
  observers = [];
  activeTargetLang = targetLang;
  let queue: PendingNode[] = [];
  let queuedNodes = new WeakSet<Text>();
  let timer: number | null = null;

  const flush = async () => {
    timer = null;
    if (!queue.length || activeTargetLang !== targetLang) return;
    // flush 시점에 이미 번역된 노드는 제외 (중복 enqueue 방어).
    const pending = queue.filter((p) => !isAlreadyTranslated(p.node));
    queue = [];
    queuedNodes = new WeakSet<Text>();
    if (!pending.length) return;
    const batches = batchNodes(pending);
    try {
      await runConcurrent(batches, 2, (batch) => translateBatchWithRetry(batch, targetLang));
    } catch (err) {
      console.warn("[translate observer]", err);
    }
  };

  const schedule = () => {
    if (timer === null && queue.length) timer = window.setTimeout(flush, OBSERVER_FLUSH_MS);
  };

  const enqueueText = (node: Text) => {
    if (isAlreadyTranslated(node) || queuedNodes.has(node)) return;
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName)) return;
    if (parent.closest("[aria-hidden='true']")) return;
    if (!isMeaningfulText(node.data)) return;
    queuedNodes.add(node);
    queue.push({ node, original: node.data });
  };

  const handleMutations = (mutations: MutationRecord[]) => {
    for (const m of mutations) {
      if (m.type === "characterData") {
        const target = m.target as Text;
        const applied = translatedNodes.get(target);
        // 우리가 방금 쓴 값이면 무시 (무한 루프 방지).
        if (applied !== undefined && applied === target.data) continue;
        // 페이지 쪽에서 텍스트를 바꿨으면 번역 상태를 무효화하고 재큐잉.
        translatedNodes.delete(target);
        enqueueText(target);
        continue;
      }
      m.addedNodes.forEach((added) => {
        if (added.nodeType === Node.TEXT_NODE) {
          enqueueText(added as Text);
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          const fresh = collectTextNodes(added as Element);
          fresh.forEach((item) => enqueueText(item.node));
        }
      });
    }
    schedule();
  };

  // 초기 수집이 훑은 모든 루트(top doc + iframe docs + shadow roots)에 옵저버 부착.
  // 예전엔 document.body 하나만 감시해서 iframe/shadow 내부 변경을 놓쳤음.
  for (const root of getAccessibleRoots()) {
    const target = root instanceof ShadowRoot ? root : root.body;
    if (!target) continue;
    const obs = new MutationObserver(handleMutations);
    obs.observe(target, { childList: true, subtree: true, characterData: true });
    observers.push(obs);
  }
}

function rootScanTarget(root: Root): Node | null {
  if (root instanceof ShadowRoot) return root;
  return root.body ?? null;
}

export async function translatePage(args: {
  targetLang: string;
  scope?: "visible" | "article";
}): Promise<{
  translatedNodes: number;
  scheduledNodes: number;
  inProgress: boolean;
  perRoot: Array<{ name: string; collected: number }>;
  totalCollected: number;
}> {
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
  const nodes = allNodes
    .slice(0, MAX_NODES_PER_PAGE)
    .map((node, index) => ({ node, index, inViewport: isInViewport(node.node) }))
    .sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.index - b.index)
    .map(({ node }) => node);
  const batches = batchNodes(nodes);
  const [firstBatch, ...remainingBatches] = batches;
  const firstCount = firstBatch
    ? await translateBatchWithRetry(firstBatch, args.targetLang)
    : 0;
  scheduleObserver(args.targetLang);
  const scheduledNodes = remainingBatches.reduce((sum, batch) => sum + batch.length, 0);
  if (remainingBatches.length > 0) {
    void runConcurrent(remainingBatches, INITIAL_CONCURRENCY, (batch) =>
      translateBatchWithRetry(batch, args.targetLang),
    )
      .then((counts) => {
        const translated = counts.reduce((sum, count) => sum + count, 0);
        console.info(
          `[translate background] ${translated}/${scheduledNodes}개 노드 번역 완료`,
        );
      })
      .catch((err: unknown) => {
        console.warn(
          "[translate background]",
          err instanceof Error ? err.message : String(err),
        );
      });
  }
  return {
    translatedNodes: firstCount,
    scheduledNodes,
    inProgress: scheduledNodes > 0,
    perRoot,
    totalCollected: nodes.length,
  };
}
