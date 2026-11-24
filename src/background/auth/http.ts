// 공용 인증 층(#319): 시간 제한이 있는 fetch.
// 요청·응답 내용(키·코드·토큰·본문)은 이 모듈이 오류나 로그에 남기지 않는다.

// 서비스 워커는 fetch 응답을 30초 넘게 기다리면 내려갈 수 있다.
export const AUTH_FETCH_LIMIT_MS = 25_000;

export interface FetchLimitOptions {
  timeoutMs: number;
  // 바깥 신호(연결 신호 등). 끊기면 요청도 끊는다.
  signal?: AbortSignal;
}

// 취소 신호는 opts.signal로만 받는다. init.signal은 내부 신호로 덮어쓰이므로 넘기지 못하게 타입으로 막는다.
export type FetchLimitedInit = Omit<RequestInit, "signal"> & { signal?: never };

// 제한 시간이 되거나 바깥 신호가 끊기면 fetch에 준 신호를 abort한다 — 하는 일은 그것뿐이다. 타이머는 read가 끝날 때까지 살아 있어
// 본문 읽기도 제한 안에 든다. 끝나면(성공·실패 모두) 타이머와 바깥 신호의 리스너를 정리한다.
// - fetch가 거부하면(연결 실패·헤더 전 시간 초과·중단) 그대로 던진다.
// - 헤더를 받은 뒤에는 read가 돌려준 값을 그대로 돌려주고, read가 던지면 그대로 던진다.
// 시간 초과를 여기서 따로 거부하지 않는 이유: 헤더를 받은 뒤 본문 읽기가 끊겼을 때 "이미 받은 상태 코드는 살리고 본문만 없는 것으로"
// 볼지(카카오 — 401이면 본문이 끊겨도 갱신·재전송 판정을 한다), 실패로 볼지는 부르는 쪽이 read에서 정한다.
export async function fetchLimited<T>(url: string, init: FetchLimitedInit, opts: FetchLimitOptions, read: (res: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const outer = opts.signal;
  const onAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await read(res);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}
