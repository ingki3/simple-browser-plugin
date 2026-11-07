// 시간 제한(과 중단 신호)을 거는 기다림. 페이지·디버거가 응답하지 않아도 도구가 무기한 붙잡히지 않게 한다(#91).
// 시간이 지나면 timeoutMessage로, signal이 중단되면 abortMessage로 거부한다. 끝나면 타이머와 리스너를 정리한다.
// (시간이 지나면 거부 대신 대체값으로 끝내는 기다림은 lib/popupMatch.ts의 bounded — 계약이 달라 따로 둔다.)
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  timeoutMessage: string,
  opts: { signal?: AbortSignal; abortMessage?: string } = {},
): Promise<T> {
  const { signal, abortMessage = "중단되었습니다." } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
    if (signal) {
      onAbort = () => reject(new Error(abortMessage));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([p, stop]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

// 작업을 한 줄로 세우는 큐를 만든다(만들 때마다 독립된 큐). 앞 작업이 실패해도 다음 작업은 실행되고,
// 실패는 그 작업을 부른 쪽에만 전해진다. MCP·텔레그램·반복 작업 저장이 각자 하나씩 쓴다(#257).
export function createSerial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
}
