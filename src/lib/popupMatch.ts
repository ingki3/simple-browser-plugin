// 클릭 동안 페이지가 부른 window.open과 실제로 만들어진 탭·창을 맞춰, 브라우저가 막은 호출만 고른다(DOM 없이 계산).
// window.open은 막혔을 때뿐 아니라 noopener 창이 열렸을 때도 null을 돌려준다. 그래서 null만으로 막혔다고 보지 않고,
// 같은 주소로 만들어진 탭·창이 없을 때만 막힌 것으로 본다. 주소가 다른 새 탭(링크로 연 탭 등)이나 성공한(창을 돌려준)
// 호출이 연 탭은 막힌 호출을 가리지 않는다.

export interface OpenCallRecord {
  // 페이지가 넘긴 주소를 문서 기준으로 푼 것. 주소 없이 부르면 "about:blank".
  url: string;
  // window.open이 null을 돌려줬는지.
  blocked: boolean;
}

// 비교용 주소: 절대 주소로 정규화하고 해시는 뺀다. 빈 주소는 about:blank.
export function openTargetKey(url: string): string {
  if (!url) return "about:blank";
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

// 막힌 호출들(null을 돌려줬고 같은 주소로 만들어진 탭·창이 없는 것). createdUrls는 그 클릭 동안 만들어진 탭·창이
// 처음 가려던 주소(탐색 대상 주소·pendingUrl).
export function blockedOpens(opens: readonly OpenCallRecord[], createdUrls: readonly string[]): OpenCallRecord[] {
  const pool = createdUrls.map(openTargetKey);
  const take = (url: string): boolean => {
    const i = pool.indexOf(openTargetKey(url));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };
  // 창을 돌려준(성공한) 호출이 연 탭을 먼저 짝지어, 그 탭이 같은 주소의 막힌 호출을 가리지 않게 한다.
  for (const c of opens) if (!c.blocked) take(c.url);
  return opens.filter((c) => c.blocked && !take(c.url));
}
