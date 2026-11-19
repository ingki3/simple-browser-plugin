// 대화용 참조(#307): 원격 대화가 이어질 수 있는 동안(받아들인 마지막 요청 뒤 ms) 서비스 워커를 붙잡는 참조 하나.
// 잡기·놓기(begin/end — keepalive 참조)와 타이머는 주입받는다(순수 모듈 — 단위 시험이 가짜 타이머로 직접 부른다).
// 상태는 타이머 하나다: 걸려 있으면 잡고 있는 것. renew는 처음에만 잡고 기한을 다시 걸며, release는 잡고 있을 때만 한 번 놓는다.
// (Node 타입 제거 실행이 불러올 수 있게 생성자 매개변수 프로퍼티를 쓰지 않는다.)
export type IdleHoldReason = "만료" | "drop" | "수신 중지";

export interface IdleHoldDeps {
  begin(): void;
  end(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  // 기한(밀리초). 함수면 renew할 때마다 읽는다(하네스가 짧게 바꿀 수 있게).
  ms: number | (() => number);
  log?(state: "on" | "off", reason?: IdleHoldReason): void;
}

export class IdleHold {
  private readonly deps: IdleHoldDeps;
  // 걸린 만료 타이머. null이 아니면 참조를 잡고 있다.
  private timer: { handle: unknown } | null = null;

  constructor(deps: IdleHoldDeps) {
    this.deps = deps;
  }

  get held(): boolean {
    return this.timer !== null;
  }

  // 잡지 않았으면 잡고, 기한을 처음부터 다시 건다.
  renew(): void {
    if (this.timer) this.deps.clearTimer(this.timer.handle);
    else {
      this.deps.begin();
      this.deps.log?.("on");
    }
    const ms = typeof this.deps.ms === "function" ? this.deps.ms() : this.deps.ms;
    const slot: { handle: unknown } = { handle: null };
    slot.handle = this.deps.setTimer(() => {
      // 그 사이 다시 걸었거나 놓았으면 이 타이머는 지난 것이다.
      if (this.timer === slot) this.release("만료");
    }, ms);
    this.timer = slot;
  }

  // 잡고 있을 때만 타이머를 풀고 한 번 놓는다(여러 번 불러도, 만료 뒤에 불러도 한 번).
  release(reason: IdleHoldReason): void {
    const t = this.timer;
    if (!t) return;
    this.timer = null;
    this.deps.clearTimer(t.handle);
    this.deps.end();
    this.deps.log?.("off", reason);
  }
}
