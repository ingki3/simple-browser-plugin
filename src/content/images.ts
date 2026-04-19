import type { PageImage } from "@/lib/messages";
import { getAccessibleDocs } from "./docs";

const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url"];

function resolveSrc(img: HTMLImageElement): string {
  if (img.currentSrc) return img.currentSrc;
  if (img.src) return img.src;
  for (const attr of LAZY_ATTRS) {
    const v = img.getAttribute(attr);
    if (v) {
      try {
        return new URL(v, img.ownerDocument.location?.href ?? location.href).href;
      } catch {
        // ignore
      }
    }
  }
  return "";
}

export function listPageImages(args: { minWidth?: number }): PageImage[] {
  const minWidth = args.minWidth ?? 0;
  const out: PageImage[] = [];
  const seen = new Set<string>();

  for (const doc of getAccessibleDocs()) {
    doc.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const url = resolveSrc(img);
      if (!url || seen.has(url)) return;
      if (!/^https?:/i.test(url)) return;
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      if (width && width < minWidth) return;
      seen.add(url);
      out.push({ url, alt: img.alt ?? "", width, height });
    });

    doc.querySelectorAll<HTMLSourceElement>("picture source").forEach((src) => {
      const srcset = src.srcset;
      if (!srcset) return;
      const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
      if (!first) return;
      try {
        const url = new URL(first, doc.location?.href ?? location.href).href;
        if (/^https?:/i.test(url) && !seen.has(url)) {
          seen.add(url);
          out.push({ url, alt: "", width: 0, height: 0 });
        }
      } catch {
        // ignore
      }
    });
  }

  return out;
}
