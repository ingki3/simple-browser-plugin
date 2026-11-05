// 대화별 기준 갱신(#233)의 제안 보관. content가 바뀐 행·항목 글자를 보여 준 결과(클릭 뒤 결과·row_drift 오류)마다 만든 nonce를
// 그 호출(내부 키 — 대화마다 다르다, #221)에 묶어 둔다. ChatAgent가 그 결과를 대화 기록에 넣을 때 꺼내 가고, 결과를 실은 모델
// 요청의 응답이 돌아온 뒤에만 그 대화의 대상 확인에 넘긴다. 기록에 넣지 못한 호출의 제안은 꺼내지 않아 쓰이지 않는다.

export interface RebaseOffer {
  id: string;
  nonce: string;
}

const MAX_CALLS = 100;
const offers = new Map<string, RebaseOffer[]>();

export function offerRebase(callKey: string, offer: RebaseOffer): void {
  const list = offers.get(callKey) ?? [];
  list.push(offer);
  offers.set(callKey, list);
  while (offers.size > MAX_CALLS) {
    const oldest = offers.keys().next().value;
    if (oldest === undefined) break;
    offers.delete(oldest);
  }
}

export function takeRebaseOffers(callKey: string): RebaseOffer[] {
  const list = offers.get(callKey) ?? [];
  offers.delete(callKey);
  return list;
}
