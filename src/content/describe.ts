import type { LandmarkSnapshot, PageDescription, PageRegion } from "@/lib/messages";
import { resultHref } from "@/lib/clickResult";
import { crossOriginFrameElements, getAccessibleDocs, isHtmlElement, isShadowRoot, isTag } from "./docs";

// 다른 출처 iframe 알림(#235)의 크기 하한(광고·추적 프레임 제외)과 개수.
const FRAME_MIN_W = 200;
const FRAME_MIN_H = 150;
const FRAME_MAX = 5;

// 프레임 자신과 조상(shadow host·같은 출처 iframe 경계를 넘어)이 숨겨지거나 투명하지 않은지. 투명한 큰 프레임이 실제 본문 프레임을
// 개수 한도 밖으로 밀어내지 않게 한다(#235 리뷰).
function shownThroughAncestors(el: Element): boolean {
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 80; depth += 1) {
    const style = cur.ownerDocument.defaultView?.getComputedStyle(cur);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
    if (cur.parentElement) {
      cur = cur.parentElement;
      continue;
    }
    const root = cur.getRootNode();
    if (isShadowRoot(root)) {
      cur = root.host;
      continue;
    }
    // 문서 끝: 같은 출처 iframe 안이면 바깥 문서의 그 iframe 요소로 넘어간다.
    try {
      cur = cur.ownerDocument.defaultView?.frameElement ?? null;
    } catch {
      cur = null;
    }
  }
  return true;
}

function crossOriginFrames(): NonNullable<PageDescription["crossOriginFrames"]> {
  const found: Array<{ declaredSrc: string; srcTooLong?: { length: number }; width: number; height: number }> = [];
  for (const frame of crossOriginFrameElements()) {
    if (!visibleElement(frame) || !shownThroughAncestors(frame)) continue;
    const rect = frame.getBoundingClientRect();
    if (rect.width < FRAME_MIN_W || rect.height < FRAME_MIN_H) continue;
    let src = "";
    try {
      const u = new URL(frame.src);
      if (u.protocol === "http:" || u.protocol === "https:") src = frame.src;
    } catch {
      src = "";
    }
    if (!src) continue;
    const shaped = resultHref(src);
    found.push({
      declaredSrc: shaped.href,
      ...(shaped.hrefTooLong ? { srcTooLong: { length: shaped.hrefTooLong.length } } : {}),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }
  return found.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, FRAME_MAX);
}

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
  if (!isHtmlElement(el)) return true;
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
    href: isTag(c, "a") ? c.href : "",
  }));

  const text =
    isHtmlElement(el) ? el.innerText || el.textContent || "" : el.textContent || "";

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

  // 같은 출처 iframe의 랜드마크. 랜드마크가 없으면 본문을 "other"로 싣는다(#234 — 찾기 도구의 detectRegion도 그 안 요소를
  // other로 본다. main으로 적으면 region=main으로 찾아도 하나도 걸리지 않는다). 보이지 않는 iframe, 보이는 클릭 대상도 글자도
  // 없는 iframe(빈 광고·추적 프레임)은 싣지 않는다.
  for (let i = 1; i < docs.length; i += 1) {
    const doc = docs[i];
    const frameEl = doc.defaultView?.frameElement;
    if (frameEl && !visibleElement(frameEl)) continue;
    const framed = snapshotDocLandmarks(doc);
    if (framed.length > 0) {
      landmarks.push(...framed);
    } else if (doc.body) {
      const clickableCount = Array.from(
        doc.body.querySelectorAll('a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]'),
      ).filter(visibleElement).length;
      const textPreview = clean(doc.body.innerText || doc.body.textContent || "", 800);
      if (clickableCount === 0 && !textPreview) continue;
      landmarks.push({
        region: "other",
        elementCount: doc.body.querySelectorAll("*").length,
        clickableCount,
        textPreview,
        sampleClickables: Array.from(
          doc.body.querySelectorAll<HTMLElement>(
            'a[href], button, [role="button"], [role="link"]',
          ),
        )
          .filter(visibleElement)
          .slice(0, 8)
          .map((c) => ({
            text: clean(c.innerText || c.textContent || "", 120),
            href: isTag(c, "a") ? c.href : "",
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

  const frames = crossOriginFrames();
  return {
    url: location.href,
    title: document.title ?? "",
    viewport: { width: window.innerWidth, height: window.innerHeight },
    landmarks,
    headings,
    fallbackExcerpt,
    ...(frames.length ? { crossOriginFrames: frames } : {}),
  };
}
