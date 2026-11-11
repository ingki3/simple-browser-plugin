import { getAccessibleRoots } from "./docs";

// read_linked_pages: 요청한 주소가 지금 문서(최상위 + 접근 가능한 같은 출처 프레임 + 열린 shadow root, find_clickables와
// 같은 범위)의 a[href]에 있는지와 그 링크 글자.
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

const linkText = (a: HTMLAnchorElement) => (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);

// exact(read_links_in_tabs, #293): 해시까지 포함한 a.href 전체와 글자 그대로 같은 것만 있다고 보고, 받은 주소를 그대로 돌려준다
// (탭으로 열 주소를 페이지의 href로 고정 — SPA의 #/화면 링크가 다른 화면으로 열리지 않게, 모델이 해시를 바꾼 주소는 없음).
// 입력 주소와 기억한 원래 링크를 함께 보므로 16개까지 본다.
function lookupExact(urls: string[]): Array<{ url: string; present: boolean; text: string }> {
  const found = new Map<string, string>();
  for (const root of getAccessibleRoots()) {
    for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = a.href;
      if (!href || found.has(href)) continue;
      found.set(href, linkText(a));
    }
  }
  return urls.slice(0, 16).map((url) => {
    const text = found.get(url);
    return { url, present: text !== undefined, text: text ?? "" };
  });
}

export function lookupLinks(urls: string[], exact = false): Array<{ url: string; present: boolean; text: string }> {
  if (exact) return lookupExact(urls);
  const found = new Map<string, string>();
  for (const root of getAccessibleRoots()) {
    for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const key = withoutHash(a.href);
      if (!key || found.has(key)) continue;
      found.set(key, linkText(a));
    }
  }
  return urls.slice(0, 8).map((url) => {
    const key = withoutHash(url);
    const text = key ? found.get(key) : undefined;
    return { url: key ?? url, present: text !== undefined, text: text ?? "" };
  });
}
