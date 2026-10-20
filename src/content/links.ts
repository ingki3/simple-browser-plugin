import { getAccessibleDocs } from "./docs";

// read_linked_pages: 요청한 주소가 지금 문서(최상위 + 접근 가능한 같은 출처 프레임)의 a[href]에 있는지와 그 링크 글자.
// 해시만 다른 주소는 같은 링크로 본다. 모델이 만든 주소로 받아 오지 않게 하는 구조적 확인이다.
function withoutHash(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

export function lookupLinks(urls: string[]): Array<{ url: string; present: boolean; text: string }> {
  const found = new Map<string, string>();
  for (const doc of getAccessibleDocs()) {
    for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const key = withoutHash(a.href);
      if (!key || found.has(key)) continue;
      found.set(key, (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120));
    }
  }
  return urls.slice(0, 8).map((url) => {
    const key = withoutHash(url);
    const text = key ? found.get(key) : undefined;
    return { url: key ?? url, present: text !== undefined, text: text ?? "" };
  });
}
