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

// find_clickables(list 모드)가 query로 0개일 때의 진단 수(#242). 글자는 담지 않는다 — 모두 구조로 센 수다.
// candidates: 후보 수(찾기 조건만 빼면 돌려줄 수 있었던 수). nameNotScreen: 그중 이름(접근성 이름 우선)이 자기 화면 글자와 다른 수.
// outside: 후보 밖에서 query 낱말이 화면 글자(modelText 경로)로 보이는 요소 수와, 위로 6단계 안의 첫 구조 신호별 수.
// rejected: 선택자에는 걸렸지만 뺀 수(숨김·aria-hidden 안·이름과 주소 없음·비활성·관계를 정하지 못한 선택지).
// limited: 순회 상한에 걸려 끝까지 세지 못함.
export interface ZeroDiag {
  candidates: number;
  nameNotScreen: number;
  outside: { total: number; aNoHref: number; onclick: number; tabindex: number; cursor: number; none: number };
  rejected: { hidden: number; ariaHidden: number; emptyName: number; disabled: number; unrelated: number };
  limited: boolean;
}

export function emptyZeroDiag(): ZeroDiag {
  return {
    candidates: 0,
    nameNotScreen: 0,
    outside: { total: 0, aNoHref: 0, onclick: 0, tabindex: 0, cursor: 0, none: 0 },
    rejected: { hidden: 0, ariaHidden: 0, emptyName: 0, disabled: 0, unrelated: 0 },
    limited: false,
  };
}

// 디버그 로그 find_clickables:zero의 한 줄(수만).
export function zeroDiagText(d: ZeroDiag): string {
  const o = d.outside;
  const r = d.rejected;
  return [
    `후보 ${d.candidates}`,
    `이름≠화면글자 ${d.nameNotScreen}`,
    `후보 밖 화면글자 ${o.total}(a무주소 ${o.aNoHref}, onclick ${o.onclick}, tabindex ${o.tabindex}, cursor ${o.cursor}, 신호없음 ${o.none})`,
    `뺀 대상 숨김 ${r.hidden}·aria-hidden ${r.ariaHidden}·이름없음 ${r.emptyName}·비활성 ${r.disabled}·관계없음 ${r.unrelated}`,
    ...(d.limited ? ["상한 도달"] : []),
  ].join(" · ");
}

export const SCREEN_TEXT_NOTE =
  "이 요소들은 이름(text)에는 query가 없고 화면 글자에 query가 있습니다. 이름이 화면 글자와 다르니 context와 함께 확인하고 고르세요.";

// query로 0개일 때 모델에 줄 안내(#242). 분기는 구조 수로만 한다(코드의 낱말 목록 없음). 안내할 것이 없으면 null(빈 배열 그대로).
// unfiltered: 찾기 조건만 빼면 돌려줄 수 있었던 수. diag가 없으면(query 없음) 예전 안내만.
export function zeroMatchNote(unfiltered: number, diag?: ZeroDiag | null): string | null {
  const parts: string[] = [];
  if (unfiltered > 0) {
    parts.push(
      `찾기 조건(query·region·onlyViewport)에 맞는 요소가 없습니다. 조건 없이 찾으면 클릭 가능 요소가 ${unfiltered}개 있습니다.` +
        (diag
          ? " query는 각 요소의 이름(text — aria-label 같은 접근성 이름이 있으면 그것)과 주소에 맞춥니다. 화면 글자와 이름이 다를 수 있으니 조건 없이 찾은 결과의 text·context를 보고 고르거나 matchContext=true로 다시 찾으세요. 같은 query를 되풀이하지 마세요."
          : " 조건을 빼고 다시 찾으세요."),
    );
  }
  if (diag && diag.outside.total > 0) {
    parts.push(
      "화면 글자에는 query가 보이지만 클릭 후보(링크·버튼·선택 위젯)가 아닌 요소 안에 있어 지금 찾기 도구로는 누를 수 없을 수 있습니다. 같은 찾기를 되풀이하지 말고, 조건 없이 찾은 목록에 없으면 사용자에게 직접 골라 달라고 안내하세요.",
    );
  } else if (diag && unfiltered === 0) {
    const r = diag.rejected;
    if (r.hidden + r.ariaHidden + r.emptyName + r.disabled > 0) {
      parts.push(
        "클릭 후보로 보이는 요소가 있지만 화면에서 숨겨졌거나(aria-hidden 포함) 이름·주소가 없거나 비활성이라 뺐습니다. 찾는 목록이 열려 있는지 describe_page로 확인하세요.",
      );
    }
  }
  return parts.length ? parts.join(" ") : null;
}
