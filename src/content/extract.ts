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

function collectText(root: HTMLElement): string {
  const doc = root.ownerDocument;
  const parts: string[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const el = node as HTMLElement;
      if (!el.tagName) return NodeFilter.FILTER_REJECT;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName)) {
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
    const txt = (current.textContent ?? "").replace(/\s+/g, " ").trim();
    if (txt && !seen.has(txt)) {
      seen.add(txt);
      parts.push(txt);
    }
    current = walker.nextNode() as HTMLElement | null;
  }
  return parts.join("\n\n");
}

function extractFromDoc(doc: Document): string {
  if (!doc.body) return "";
  const main = pickMainElement(doc);
  let text = collectText(main);
  if (text.length < 200) text = collectText(doc.body);
  return text;
}

export function extractMainContent(): PageContent {
  const docs = getAccessibleDocs();
  const chunks: string[] = [];
  for (const doc of docs) {
    const chunk = extractFromDoc(doc);
    if (chunk) chunks.push(chunk);
  }
  let mainText = chunks.join("\n\n").trim();
  if (mainText.length > 12000) mainText = mainText.slice(0, 12000) + "…";

  return {
    title: document.title?.trim() ?? "",
    url: location.href,
    mainText,
    wordCount: mainText.length,
  };
}
