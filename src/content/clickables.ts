import type { ClickableElement, PageRegion } from "@/lib/messages";
import { findElementByAttr, getAccessibleDocs } from "./docs";

const CLICK_ATTR = "data-sbp-cid";
let counter = 0;

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  if (el.closest("[aria-hidden='true']")) return false;
  return true;
}

function ensureId(el: HTMLElement): string {
  let id = el.getAttribute(CLICK_ATTR);
  if (id) return id;
  counter += 1;
  id = `c${counter}`;
  el.setAttribute(CLICK_ATTR, id);
  return id;
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

function detectRegion(el: Element): PageRegion {
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur !== cur.ownerDocument.body && depth < 40) {
    const tag = cur.tagName.toLowerCase();
    const role = (cur.getAttribute("role") ?? "").toLowerCase();
    if (tag === "article" || role === "article") return "article";
    if (tag === "main" || role === "main") return "main";
    if (tag === "nav" || role === "navigation") return "nav";
    if (tag === "aside" || role === "complementary") return "aside";
    if (tag === "header" || role === "banner") return "header";
    if (tag === "footer" || role === "contentinfo") return "footer";
    cur = cur.parentElement;
    depth += 1;
  }
  return "other";
}

function rectInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView ?? window;
  const vw = win.innerWidth || win.document.documentElement.clientWidth;
  const vh = win.innerHeight || win.document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
}

export function findClickables(args: {
  query?: string;
  region?: PageRegion;
  onlyViewport?: boolean;
  limit?: number;
}): ClickableElement[] {
  const limit = Math.min(args.limit ?? 50, 200);
  const q = args.query?.toLowerCase().trim() ?? "";
  const out: ClickableElement[] = [];
  const seenKeys = new Set<string>();
  const docs = getAccessibleDocs();

  for (const doc of docs) {
    if (out.length >= limit) break;
    const nodes = doc.querySelectorAll<HTMLElement>(
      'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]',
    );
    for (const el of nodes) {
      if (out.length >= limit) break;
      if (!isVisible(el)) continue;

      const inViewport = rectInViewport(el);
      if (args.onlyViewport && !inViewport) continue;

      const region = detectRegion(el);
      if (args.region && region !== args.region) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? "";
      const href = el instanceof HTMLAnchorElement ? el.href : "";
      const text = cleanText(
        el.innerText ||
          el.textContent ||
          el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          (el as HTMLInputElement).value ||
          "",
      );
      if (!text && !href) continue;

      if (q) {
        const hay = `${text} ${href}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const key = `${tag}|${text}|${href}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const id = ensureId(el);
      out.push({ id, text, href, tag, role, region, inViewport });
    }
  }

  return out;
}

export function clickElement(args: { id: string }): { clicked: boolean; text: string; href: string } {
  const el = findElementByAttr(CLICK_ATTR, args.id);
  if (!el) throw new Error(`id '${args.id}'에 해당하는 요소를 찾지 못했습니다.`);

  const text = cleanText(el.innerText || el.textContent || "");
  const href = el instanceof HTMLAnchorElement ? el.href : "";

  // Defer actual click so the content-script response can fly back to the
  // background before a potential navigation tears down this context.
  setTimeout(() => {
    try {
      el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* ignore */
      }
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    try {
      el.click();
    } catch (err) {
      console.warn("[click_element] click threw", err);
    }
  }, 0);

  return { clicked: true, text, href };
}
