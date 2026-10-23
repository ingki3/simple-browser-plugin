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

export const ABORTED: unique symbol = Symbol("aborted");

// p를 기다리되 ms가 지나면 fallback, signal이 중단되면 ABORTED로 끝낸다. p의 거부도 fallback으로 받는다 — 이미 중단돼
// 기다리지 않고 끝낼 때도 p에 거부 처리기를 달아(닫힌 탭에 대한 executeScript 실패 등) 처리되지 않은 거부가 남지 않게 한다.
export function bounded<T>(p: Promise<T>, ms: number, fallback: T, signal?: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal?.aborted) {
    p.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve) => {
    const done = (v: T | typeof ABORTED) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(v);
    };
    const onAbort = () => done(ABORTED);
    const timer = setTimeout(() => done(fallback), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(done, () => done(fallback));
  });
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

// 이미 열린 이름 있는 창을 다시 쓴 window.open(window.open(url, "calendar", …)이 같은 이름의 창을 찾아 그 창을
// 이동시킨다 — 새 탭이 만들어지지 않는다). 클릭 동안 다른 탭에서 시작된 이동 중, 창을 돌려준(성공한) 호출과 주소가
// 같은 것만 고른다(호출 하나에 이동 하나). navigations는 이동이 시작된 순서.
export function reusedTargets<T extends { url: string }>(opens: readonly OpenCallRecord[], navigations: readonly T[]): T[] {
  const wanted = opens.filter((c) => !c.blocked).map((c) => openTargetKey(c.url));
  const out: T[] = [];
  for (const n of navigations) {
    const i = wanted.indexOf(openTargetKey(n.url));
    if (i < 0) continue;
    wanted.splice(i, 1);
    out.push(n);
  }
  return out;
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
