// 무효화 세대를 보는 읽기 캐시(#127). 무효화마다 세대를 올리고, 조회는 시작할 때의 세대가 끝날 때도 같을 때만 캐시에 넣는다 —
// 읽는 사이 저장이 끝나 무효화되면 옛 조회 결과가 캐시에 다시 들어가던 경합을 막는다(그러면 다시 읽는다).
// 같은 세대 안의 동시 호출은 진행 중인 조회 하나를 함께 쓴다.
export function makeGenCache<T>(read: () => Promise<T>): { get(): Promise<T>; invalidate(): void } {
  let value: { v: T } | null = null;
  let gen = 0;
  let pending: { gen: number; read: Promise<T> } | null = null;
  return {
    async get() {
      for (;;) {
        if (value) return value.v;
        const g = gen;
        if (!pending || pending.gen !== g) pending = { gen: g, read: read() };
        const mine = pending;
        let v: T;
        try {
          v = await mine.read;
        } finally {
          if (pending === mine) pending = null;
        }
        if (g === gen) {
          value = { v };
          return v;
        }
      }
    },
    invalidate() {
      value = null;
      gen += 1;
    },
  };
}
