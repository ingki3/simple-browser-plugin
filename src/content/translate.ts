import {
  decodeSegments,
  encodeSegments,
  isUsableTranslation,
  stripSegmentTags,
} from "@/lib/translationSegments";
import { describeRoot, getAccessibleRoots, type Root } from "./docs";

// 조상 전체를 본다. 코드 블록은 <pre><span>…</span></pre>처럼 하이라이트 span 안에
// 텍스트가 있어 부모 태그만 보면 걸러지지 않고, 블록 단위로 묶이면 수천 자짜리
// 번역 요청(모델이 원문을 돌려줘 재요청까지)이 된다.
const SKIP_SELECTOR = "script, style, noscript, textarea, template, pre, code, kbd, samp";
const MAX_NODES_PER_PAGE = 2000;
const BATCH_UNIT_LIMIT = 30;
const BATCH_CHAR_LIMIT = 2000;
// 한 번역 단위의 최대 길이. 넘으면 노드 경계에서 나눠 여러 단위로 보낸다.
const UNIT_CHAR_LIMIT = 1500;
const INITIAL_CONCURRENCY = 6;
const OBSERVER_FLUSH_MS = 300;
const BISECT_MAX_DEPTH = 6;

// 번역 단위: 같은 블록(문단·제목·목록 항목 등)에 속한 텍스트 노드 묶음.
// <strong>/<a>/드롭캡 span으로 쪼개진 문장을 노드별로 따로 번역하면 문맥이 끊겨
// "A솔직히 말해서…" 같은 조각 번역이 생기므로 블록 단위로 한 번에 보낸다.
interface Unit {
  nodes: Text[];
  originals: string[];
  source: string;
  retried?: boolean;
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

// 개별 노드는 한 글자(드롭캡)나 기호일 수 있으므로 의미 판정은 블록 단위에서 한다.
function collectTextNodes(root: Node, seen = new Set<Text>()): Text[] {
  const results: Text[] = [];
  const doc = ownerDocOf(root);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const text = node as Text;
      if (seen.has(text)) return NodeFilter.FILTER_REJECT;
      if (isAlreadyTranslated(text)) return NodeFilter.FILTER_REJECT;
      if (!text.data.trim()) return NodeFilter.FILTER_REJECT;
      const parent = text.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let n = walker.nextNode() as Text | null;
  while (n && seen.size < MAX_NODES_PER_PAGE) {
    seen.add(n);
    results.push(n);
    n = walker.nextNode() as Text | null;
  }
  return results;
}

// 텍스트 노드가 속한 가장 가까운 비-inline 조상. 같은 블록의 노드끼리 한 단위로 묶는다.
function blockOf(node: Text, cache: Map<Element, Element>): Element | null {
  const start = node.parentElement;
  if (!start) return null;
  const visited: Element[] = [];
  let el: Element | null = start;
  let block: Element | null = null;
  while (el) {
    const cached = cache.get(el);
    if (cached) {
      block = cached;
      break;
    }
    visited.push(el);
    const win = el.ownerDocument.defaultView ?? window;
    const style = win.getComputedStyle(el);
    // float된 요소(드롭캡 등)는 computed display가 block이지만 문장의 일부다.
    const inlineLike =
      style.display === "inline" || style.display === "contents" || style.float !== "none";
    if (!inlineLike) {
      block = el;
      break;
    }
    if (!el.parentElement) {
      block = el;
      break;
    }
    el = el.parentElement;
  }
  for (const v of visited) if (block) cache.set(v, block);
  return block;
}

function buildUnits(nodes: Text[]): Unit[] {
  const cache = new Map<Element, Element>();
  const groups = new Map<Element, Text[]>();
  for (const node of nodes) {
    const block = blockOf(node, cache);
    if (!block) continue;
    const list = groups.get(block);
    if (list) list.push(node);
    else groups.set(block, [node]);
  }
  const units: Unit[] = [];
  for (const group of groups.values()) {
    for (const chunk of splitByLength(group)) {
      const originals = chunk.map((n) => n.data);
      const cores = originals.map((t) => t.trim());
      if (!isMeaningfulText(cores.join(" "))) continue;
      units.push({ nodes: chunk, originals, source: encodeSegments(cores) });
    }
  }
  return units;
}

function splitByLength(nodes: Text[]): Text[][] {
  const chunks: Text[][] = [];
  let current: Text[] = [];
  let chars = 0;
  for (const node of nodes) {
    const len = node.data.length;
    if (current.length && chars + len > UNIT_CHAR_LIMIT) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(node);
    chars += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function collectUnits(roots: Node[]): Unit[] {
  const seen = new Set<Text>();
  const nodes: Text[] = [];
  for (const root of roots) nodes.push(...collectTextNodes(root, seen));
  return buildUnits(nodes);
}

function batchUnits(units: Unit[]): Unit[][] {
  const batches: Unit[][] = [];
  let current: Unit[] = [];
  let chars = 0;
  for (const u of units) {
    const len = u.source.length;
    if (current.length >= BATCH_UNIT_LIMIT || chars + len > BATCH_CHAR_LIMIT) {
      if (current.length) batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(u);
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

function markDone(unit: Unit): void {
  unit.nodes.forEach((node) => translatedNodes.set(node, node.data));
}

function applyUnit(unit: Unit, raw: string): boolean {
  // 수집 이후 페이지가 텍스트를 바꿨으면 건너뜀. 옵저버가 새 텍스트로 다시 큐잉한다.
  if (unit.nodes.some((node, i) => node.data !== unit.originals[i])) return false;
  if (!raw.trim()) {
    // 빈 응답: 원문 유지하되 "처리 완료"로 마킹해야 재큐잉/무한 재시도를 막음.
    markDone(unit);
    return false;
  }
  const count = unit.nodes.length;
  // 세그먼트 태그가 깨졌으면 번역문 전체를 첫 노드에 넣고 나머지를 비운다.
  const parts = decodeSegments(raw, count) ?? [
    stripSegmentTags(raw),
    ...new Array<string>(count - 1).fill(""),
  ];
  let changed = false;
  unit.nodes.forEach((node, i) => {
    const original = unit.originals[i];
    const core = parts[i].trim();
    const next = core
      ? original.match(/^\s*/)![0] + core + original.match(/\s*$/)![0]
      : "";
    // WeakMap을 write 이전에 갱신해야 observer가 self-write를 판별할 수 있음.
    translatedNodes.set(node, next);
    if (next !== node.data) {
      node.data = next;
      changed = true;
    }
  });
  return changed;
}

// 배치가 실패하면 반으로 쪼개서 재시도.
// 하나의 나쁜 응답(길이 불일치, 파싱 실패, 거대한 항목 하나)으로 큰 배치가
// 통째로 유실되는 걸 막는 게 목적.
// 모델이 원문을 그대로 돌려주거나 세그먼트를 깨뜨린 단위는 한 번만 따로 다시 요청.
async function translateBatchWithRetry(
  batch: Unit[],
  targetLang: string,
  gen: number,
  depth = 0,
): Promise<number> {
  if (!batch.length || gen !== generation) return 0;
  let translated: string[];
  try {
    translated = await requestTranslation(batch.map((u) => u.source), targetLang);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const responseShapeError = /JSON 파싱|응답 길이 불일치/.test(message);
    if (!responseShapeError) throw err;
    if (batch.length > 1 && depth < BISECT_MAX_DEPTH) {
      const mid = Math.floor(batch.length / 2);
      const a = await translateBatchWithRetry(batch.slice(0, mid), targetLang, gen, depth + 1);
      const b = await translateBatchWithRetry(batch.slice(mid), targetLang, gen, depth + 1);
      return a + b;
    }
    console.warn(
      "[translate batch fail]",
      err,
      batch.map((u) => u.source.slice(0, 40)),
    );
    return 0;
  }
  // 응답을 기다리는 사이 번역이 중지됐으면 페이지에 반영하지 않는다.
  if (gen !== generation) return 0;
  let swapped = 0;
  const retry: Unit[] = [];
  batch.forEach((unit, i) => {
    const out = translated[i];
    if (typeof out !== "string") return;
    if (!unit.retried && !isUsableTranslation(unit.source, out, targetLang)) {
      unit.retried = true;
      retry.push(unit);
      return;
    }
    if (applyUnit(unit, out)) swapped += 1;
  });
  if (retry.length) swapped += await translateBatchWithRetry(retry, targetLang, gen, depth);
  return swapped;
}

let observers: MutationObserver[] = [];
let activeTargetLang: string | null = null;
// stopTranslation()마다 증가. 진행 중인 배치는 시작 시점의 값과 비교해 멈춘다.
let generation = 0;

export function stopTranslation(): void {
  generation += 1;
  for (const obs of observers) obs.disconnect();
  observers = [];
  activeTargetLang = null;
}

function scheduleObserver(targetLang: string): void {
  for (const obs of observers) obs.disconnect();
  observers = [];
  activeTargetLang = targetLang;
  const gen = generation;
  let queue: Text[] = [];
  let queuedNodes = new WeakSet<Text>();
  let timer: number | null = null;

  const flush = async () => {
    timer = null;
    if (!queue.length || activeTargetLang !== targetLang) return;
    // flush 시점에 이미 번역된 노드는 제외 (중복 enqueue 방어).
    const pending = queue.filter((node) => node.isConnected && !isAlreadyTranslated(node));
    queue = [];
    queuedNodes = new WeakSet<Text>();
    if (!pending.length) return;
    // 바뀐 노드만이 아니라 그 노드가 속한 블록 전체를 다시 묶어야 문맥이 유지된다.
    const cache = new Map<Element, Element>();
    const blocks = new Set<Element>();
    for (const node of pending) {
      const block = blockOf(node, cache);
      if (block) blocks.add(block);
    }
    const batches = batchUnits(collectUnits([...blocks]));
    try {
      await runConcurrent(batches, 2, (batch) => translateBatchWithRetry(batch, targetLang, gen));
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
    if (!parent || parent.closest(SKIP_SELECTOR)) return;
    if (parent.closest("[aria-hidden='true']")) return;
    if (!node.data.trim()) return;
    queuedNodes.add(node);
    queue.push(node);
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
          fresh.forEach((node) => enqueueText(node));
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
  const gen = generation;
  const allUnits: Unit[] = [];
  const perRoot: Array<{ name: string; collected: number }> = [];
  const seen = new Set<Text>();
  for (const root of getAccessibleRoots()) {
    const target = rootScanTarget(root);
    if (!target) {
      perRoot.push({ name: describeRoot(root), collected: 0 });
      continue;
    }
    const units = buildUnits(collectTextNodes(target, seen));
    allUnits.push(...units);
    perRoot.push({ name: describeRoot(root), collected: units.length });
    if (seen.size >= MAX_NODES_PER_PAGE) break;
  }
  const units = allUnits
    .map((unit, index) => ({ unit, index, inViewport: isInViewport(unit.nodes[0]) }))
    .sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.index - b.index)
    .map(({ unit }) => unit);
  const batches = batchUnits(units);
  const [firstBatch, ...remainingBatches] = batches;
  const firstCount = firstBatch
    ? await translateBatchWithRetry(firstBatch, args.targetLang, gen)
    : 0;
  // 첫 배치를 기다리는 사이 중지됐으면 옵저버를 다시 붙이지 않는다.
  if (gen === generation) scheduleObserver(args.targetLang);
  const scheduledNodes = remainingBatches.reduce((sum, batch) => sum + batch.length, 0);
  if (remainingBatches.length > 0) {
    void runConcurrent(remainingBatches, INITIAL_CONCURRENCY, (batch) =>
      translateBatchWithRetry(batch, args.targetLang, gen),
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
    totalCollected: units.length,
  };
}
