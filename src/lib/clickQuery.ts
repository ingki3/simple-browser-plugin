// find_clickables의 query는 "|"로 여러 낱말을 줄 수 있다(주문|배송|마이페이지). 하나라도 맞으면 후보이고,
// 많이 맞을수록 앞에 둔다. 목표 페이지를 찾아갈 때 한 번의 호출로 그럴듯한 링크를 고르게 하려는 것.
export function queryTerms(query: string | undefined): string[] {
  return (query ?? "")
    .toLowerCase()
    .split("|")
    .map((t) => t.trim())
    .filter(Boolean);
}

// 글자는 주소보다 무겁게 본다(메뉴 글자 "주문/배송조회"가 주소 낱말보다 믿을 만하다). 0이면 후보가 아니다.
export function clickMatchScore(terms: string[], text: string, href: string): number {
  const count = (hay: string) => {
    const h = hay.toLowerCase();
    let n = 0;
    for (const t of terms) if (h.includes(t)) n += 1;
    return n;
  };
  return count(text) * 2 + count(href);
}
