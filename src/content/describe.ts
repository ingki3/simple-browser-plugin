import type { LandmarkSnapshot, PageDescription, PageRegion } from "@/lib/messages";
import { getAccessibleDocs } from "./docs";

const REGION_SELECTORS: Record<Exclude<PageRegion, "other">, string> = {
  main: "main, [role='main']",
  article: "article, [role='article']",
  nav: "nav, [role='navigation']",
  aside: "aside, [role='complementary']",
  header: "header, [role='banner']",
  footer: "footer, [role='contentinfo']",
};

function clean(raw: string, max = 800): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

function visibleElement(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  return true;
}

function snapshotRegion(region: PageRegion, el: Element): LandmarkSnapshot {
  const clickables = Array.from(
    el.querySelectorAll<HTMLElement>(
      'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]',
    ),
  ).filter(visibleElement);

  const sampleClickables = clickables.slice(0, 8).map((c) => ({
    text: clean(c.innerText || c.textContent || c.getAttribute("aria-label") || "", 120),
    href: c instanceof HTMLAnchorElement ? c.href : "",
  }));

  const text =
    el instanceof HTMLElement ? el.innerText || el.textContent || "" : el.textContent || "";

  return {
    region,
    elementCount: el.querySelectorAll("*").length,
    clickableCount: clickables.length,
    textPreview: clean(text, 800),
    sampleClickables,
  };
}

function snapshotDocLandmarks(doc: Document): LandmarkSnapshot[] {
  const landmarks: LandmarkSnapshot[] = [];
  const seen = new WeakSet<Element>();
  for (const [region, selector] of Object.entries(REGION_SELECTORS) as Array<
    [Exclude<PageRegion, "other">, string]
  >) {
    const els = Array.from(doc.querySelectorAll(selector)).filter(
      (el) => visibleElement(el) && !seen.has(el),
    );
    els.sort((a, b) => b.querySelectorAll("*").length - a.querySelectorAll("*").length);
    const picked = els[0];
    if (!picked) continue;
    seen.add(picked);
    landmarks.push(snapshotRegion(region, picked));
  }
  return landmarks;
}

function fallbackExcerptFromDoc(doc: Document): string {
  const body = doc.body;
  if (!body) return "";
  return clean(body.innerText || body.textContent || "", 1500);
}

export function describePage(): PageDescription {
  const docs = getAccessibleDocs();
  const landmarks: LandmarkSnapshot[] = [];

  // Top-frame landmarks first
  landmarks.push(...snapshotDocLandmarks(docs[0]));

  // Iframe landmarks — if iframe has none but has body, add the body as a synthetic "main"
  for (let i = 1; i < docs.length; i += 1) {
    const doc = docs[i];
    const framed = snapshotDocLandmarks(doc);
    if (framed.length > 0) {
      landmarks.push(...framed);
    } else if (doc.body) {
      landmarks.push({
        region: "main",
        elementCount: doc.body.querySelectorAll("*").length,
        clickableCount: doc.body.querySelectorAll(
          'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]',
        ).length,
        textPreview: clean(doc.body.innerText || doc.body.textContent || "", 800),
        sampleClickables: Array.from(
          doc.body.querySelectorAll<HTMLElement>(
            'a[href], button, [role="button"], [role="link"]',
          ),
        )
          .filter(visibleElement)
          .slice(0, 8)
          .map((c) => ({
            text: clean(c.innerText || c.textContent || "", 120),
            href: c instanceof HTMLAnchorElement ? c.href : "",
          })),
      });
    }
  }

  const headings: string[] = [];
  for (const doc of docs) {
    for (const h of Array.from(doc.querySelectorAll<HTMLElement>("h1, h2, h3")).filter(
      visibleElement,
    )) {
      if (headings.length >= 20) break;
      const txt = clean(h.innerText || h.textContent || "", 120);
      if (txt) headings.push(`${h.tagName}: ${txt}`);
    }
  }

  const fallbackExcerpt =
    landmarks.length === 0
      ? docs
          .map(fallbackExcerptFromDoc)
          .filter((s) => s.length > 0)
          .join("\n\n")
          .slice(0, 2000)
      : "";

  return {
    url: location.href,
    title: document.title ?? "",
    viewport: { width: window.innerWidth, height: window.innerHeight },
    landmarks,
    headings,
    fallbackExcerpt,
  };
}
