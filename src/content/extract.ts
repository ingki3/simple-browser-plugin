import type { PageContent } from "@/lib/messages";
import { getAccessibleDocs } from "./docs";

const BLOCK_TAGS = new Set([
  "P",
  "ARTICLE",
  "SECTION",
  "MAIN",
  "DIV",
  "LI",
  "BLOCKQUOTE",
  "TD",
  "PRE",
]);
const NEGATIVE_RE = /(comment|ad-|ads|advert|promo|banner|sidebar|footer|header|nav|menu|breadcrumb|share|related|subscribe|newsletter|cookie|popup|modal)/i;
const POSITIVE_RE = /(article|content|main|post|story|body|entry|text)/i;

function scoreElement(el: HTMLElement): number {
  const id = el.id ?? "";
  const cls = el.className && typeof el.className === "string" ? el.className : "";
  let score = 0;
  if (NEGATIVE_RE.test(id + " " + cls)) score -= 25;
  if (POSITIVE_RE.test(id + " " + cls)) score += 25;
  if (el.tagName === "ARTICLE" || el.tagName === "MAIN") score += 30;
  const text = (el.textContent ?? "").trim();
  if (text.length < 100) return score - 10;
  const linkLen = Array.from(el.querySelectorAll("a"))
    .reduce((acc, a) => acc + (a.textContent?.length ?? 0), 0);
  const linkDensity = linkLen / Math.max(1, text.length);
  score += Math.min(50, Math.floor(text.length / 100));
  score -= Math.floor(linkDensity * 40);
  return score;
}

function pickMainElement(doc: Document): HTMLElement {
  const candidates: HTMLElement[] = [];
  doc.querySelectorAll<HTMLElement>("article, main, [role='main'], div, section").forEach((el) => {
    if (BLOCK_TAGS.has(el.tagName) || el.tagName === "ARTICLE" || el.tagName === "MAIN") {
      candidates.push(el);
    }
  });
  let best: HTMLElement = doc.body;
  let bestScore = -Infinity;
  for (const el of candidates) {
    const s = scoreElement(el);
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  }
  return best;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

// 기존 수집기: root 아래의 블록 요소마다 글을 모은다. 채택한 블록도 함께 돌려줘서,
// 블록이 담지 못한 글(root 바로 아래의 <br> 본문 등)이 남았는지 따로 셀 수 있게 한다.
function collectText(root: HTMLElement): { text: string; accepted: Set<Element> } {
  const doc = root.ownerDocument;
  const parts: string[] = [];
  const accepted = new Set<Element>();
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const el = node as HTMLElement;
      if (!el.tagName) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(el.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!BLOCK_TAGS.has(el.tagName) && !["H1", "H2", "H3", "H4", "H5", "H6"].includes(el.tagName)) {
        return NodeFilter.FILTER_SKIP;
      }
      const t = (el.textContent ?? "").trim();
      if (t.length < 20) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const seen = new Set<string>();
  let current = walker.nextNode() as HTMLElement | null;
  while (current) {
    accepted.add(current);
    const txt = (current.textContent ?? "").replace(/\s+/g, " ").trim();
    if (txt && !seen.has(txt)) {
      seen.add(txt);
      parts.push(txt);
    }
    current = walker.nextNode() as HTMLElement | null;
  }
  return { text: parts.join("\n\n"), accepted };
}


// 블록이 담지 못한 글의 길이: 채택한 블록 바깥에 있는 텍스트 노드만 센다.
function uncoveredLength(root: HTMLElement, accepted: Set<Element>): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = node as Element;
      if (accepted.has(el) || SKIP_TAGS.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  let len = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    len += (n.nodeValue ?? "").replace(/\s+/g, " ").trim().length;
  }
  return len;
}

// 줄을 나누는 요소. 이 경계에서 글 조각을 끊는다(인라인 요소는 같은 조각으로 이어 붙임).
const FLOW_BREAK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR",
  "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL",
]);

// 중복 없는 수집기: 텍스트 노드를 문서 순서대로 한 번씩만 읽는다. <br>은 줄바꿈, 블록 경계는 조각 경계.
// 부모의 textContent를 통째로 넣지 않으므로 겹친 div가 글을 반복하지 않고, root 바로 아래의 글도 읽힌다.
// 같은 문장이 서로 다른 곳에 실제로 반복되면 그대로 둔다.
function collectFlowText(root: HTMLElement): string {
  const segments: string[] = [];
  let buf = "";
  const flush = () => {
    const seg = buf
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
    if (seg) segments.push(seg);
    buf = "";
  };
  const visit = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === Node.TEXT_NODE) {
        buf += child.nodeValue ?? "";
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = (child as Element).tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "BR") {
        buf += "\n";
      } else if (FLOW_BREAK_TAGS.has(tag)) {
        flush();
        visit(child);
        flush();
      } else {
        visit(child);
      }
    }
  };
  visit(root);
  flush();
  return segments.join("\n\n");
}

// 블록 바깥에 이만큼 글이 남으면 블록 수집이 본문을 놓친 것으로 본다(<br>로 줄을 나눈 본문, 블록과 섞인 본문).
const UNCOVERED_MIN_CHARS = 100;
// 기존 수집 결과가 중복 없이 읽은 글보다 이 배수 이상 길면, 겹친 블록이 글을 반복한 것으로 본다.
const DUPLICATE_RATIO = 1.5;
// 고른 본문 영역에서 이만큼도 안 나오면 영역을 잘못 골랐을 수 있으니 페이지 전체를 읽는다(기존 기준 유지).
const MAIN_MIN_CHARS = 200;

function extractFromDoc(doc: Document): string {
  if (!doc.body) return "";
  const main = pickMainElement(doc);
  if (main !== doc.body) {
    const { text, accepted } = collectText(main);
    const flow = collectFlowText(main);
    // 블록 수집이 글을 놓쳤거나 크게 반복했을 때만 중복 없이 읽은 글로 바꾼다. 아니면 기존 결과 그대로.
    const missed = !text || uncoveredLength(main, accepted) >= UNCOVERED_MIN_CHARS;
    const repeated = text.length > flow.length * DUPLICATE_RATIO;
    const picked = missed || repeated ? flow : text;
    if (picked.length >= MAIN_MIN_CHARS) return picked;
  }
  // 페이지 전체를 읽을 때는 겹친 블록이 글을 반복하지 않게 중복 없는 수집기를 쓴다.
  return collectFlowText(doc.body);
}

// 모델에 넘기는 본문 상한. 긴 기술 블로그 한 편(영문 약 6~7천 단어)이 대부분 들어가는 크기.
// 영문 기준 약 1만 토큰이라 128k 이상 컨텍스트 모델에서 여유가 있다.
const MAX_CONTENT_CHARS = 40_000;

export function extractMainContent(): PageContent {
  const docs = getAccessibleDocs();
  const chunks: string[] = [];
  for (const doc of docs) {
    const chunk = extractFromDoc(doc);
    if (chunk) chunks.push(chunk);
  }
  let mainText = chunks.join("\n\n").trim();
  if (mainText.length > MAX_CONTENT_CHARS) mainText = mainText.slice(0, MAX_CONTENT_CHARS) + "…";

  return {
    title: document.title?.trim() ?? "",
    url: location.href,
    mainText,
    wordCount: mainText.length,
  };
}
