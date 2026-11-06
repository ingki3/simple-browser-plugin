// 패널 ↔ 백그라운드 연결(#243)의 순수 계산: 끊긴 대화의 짧은 보관, 연결 세대, 대화 유실 안내 중복 방지, 진단 줄.
// npm test(Node 타입 제거 실행)로 시험하므로 다른 모듈을 불러오지 않는다.

// 같은 서비스 워커 안에서 끊긴 뒤 다시 붙을 때까지 쉬는 대화를 보관하는 시간과 최대 개수.
export const PARK_TTL_MS = 60_000;
export const PARK_MAX = 4;

// 끊길 때 진행 중이 아니던 대화를 conversationId로 잠깐 보관한다. 한 번만 꺼내고, 만료·밀려남이면 onDrop으로 정리한다.
export class ParkedConversations<T> {
  private readonly items = new Map<string, { value: T; at: number }>();
  private readonly onDrop: (value: T) => void;
  private readonly ttlMs: number;
  private readonly max: number;

  // 매개변수 프로퍼티는 Node 타입 제거 실행이 받지 않아 필드로 둔다.
  constructor(onDrop: (value: T) => void = () => {}, ttlMs = PARK_TTL_MS, max = PARK_MAX) {
    this.onDrop = onDrop;
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get size(): number {
    return this.items.size;
  }

  put(id: string, value: T, now: number): void {
    const old = this.items.get(id);
    if (old && old.value !== value) this.onDrop(old.value);
    this.items.delete(id);
    this.items.set(id, { value, at: now });
    while (this.items.size > this.max) {
      const [oldestId, oldest] = this.items.entries().next().value as [string, { value: T; at: number }];
      this.items.delete(oldestId);
      this.onDrop(oldest.value);
    }
  }

  // 꺼내면 보관에서 지운다(한 번만). 만료됐으면 정리하고 expired.
  take(id: string, now: number): { value: T } | { missing: "expired" | "missing" } {
    const hit = this.items.get(id);
    if (!hit) return { missing: "missing" };
    this.items.delete(id);
    if (now - hit.at > this.ttlMs) {
      this.onDrop(hit.value);
      return { missing: "expired" };
    }
    return { value: hit.value };
  }

  // 만료된 것을 정리한다(타이머가 부른다).
  expire(now: number): void {
    for (const [id, hit] of [...this.items]) {
      if (now - hit.at > this.ttlMs) {
        this.items.delete(id);
        this.onDrop(hit.value);
      }
    }
  }

  clear(): void {
    const all = [...this.items.values()];
    this.items.clear();
    for (const hit of all) this.onDrop(hit.value);
  }
}

export type ResumeMissing = "missing" | "expired" | "busy" | "sender";

// 백그라운드의 다시 잇기 답. gen·conversationId는 패널이 보낸 값을 그대로 돌려준다.
export interface ResumeReply {
  conversationId: string;
  gen: number;
  resumed: boolean;
  reason?: ResumeMissing;
}

// 지금 연결 세대·지금 대화에 대한 답일 때만 받는다(그 사이 또 끊겼거나 새 대화로 바꿨으면 버림).
export function acceptResume(reply: ResumeReply, current: { gen: number; conversationId: string }): boolean {
  return reply.gen === current.gen && reply.conversationId === current.conversationId;
}

// "앞 대화를 이어 가지 못했습니다" 안내의 중복 방지: 같은 대화에서 안내한 뒤 사용자가 새 요청을 보내기 전에는 다시 띄우지 않는다.
// 새 요청을 보낸 뒤 다시 잃으면 다시 띄운다. 대화가 바뀌면(새 대화) 처음부터.
export class LostNotice {
  private shownFor: string | null = null;

  shouldShow(conversationId: string): boolean {
    if (this.shownFor === conversationId) return false;
    this.shownFor = conversationId;
    return true;
  }

  onUserMessage(): void {
    this.shownFor = null;
  }
}

const sec = (ms: number) => `${Math.round(ms / 1000)}초`;

// 패널이 본 끊김(디버그 로그 port:disconnect). 패널의 onDisconnect는 상대(백그라운드) 쪽 종료에서만 불린다.
export function disconnectDetail(d: {
  lastError?: string;
  connectedMs: number;
  beatAgoMs: number | null;
  visibility: string;
  visibilityForMs: number;
  busy: boolean;
}): string {
  return [
    `사유 ${d.lastError || "없음"}`,
    `연결 유지 ${sec(d.connectedMs)}`,
    d.beatAgoMs === null ? "heartbeat 보낸 적 없음" : `마지막 heartbeat 보냄 ${sec(d.beatAgoMs)} 전`,
    `visibility ${d.visibility}(그 상태 ${sec(d.visibilityForMs)})`,
    `대화 ${d.busy ? "진행 중" : "쉬는 중"}`,
    "끊김 쪽: 백그라운드(또는 워커 종료)",
  ].join(" · ");
}

// 백그라운드가 본 앞 끊김(다음 연결 때 port:prev_disconnect로 남긴다 — 끊긴 순간의 로그는 그 패널에 닿지 않는다).
export interface PanelClose {
  at: number;
  connectedMs: number;
  heartbeatAt: number | null;
  conversationId: string | null;
  busy: boolean;
  parked: boolean;
}

export function prevDisconnectDetail(c: PanelClose | null, now: number): string {
  if (!c) return "이 워커에는 이전 끊김 기록 없음(새 워커이거나 첫 연결)";
  return [
    `백그라운드가 끊김을 봄 ${sec(now - c.at)} 전`,
    `연결 유지 ${sec(c.connectedMs)}`,
    c.heartbeatAt === null ? "heartbeat 받은 적 없음" : `마지막 heartbeat 받음 끊기기 ${sec(c.at - c.heartbeatAt)} 전`,
    `대화 ${c.conversationId === null ? "없음" : c.busy ? "진행 중" : "쉬는 중"}`,
    `기록 ${c.parked ? "보관" : "보관 안 함"}`,
  ].join(" · ");
}

// heartbeat 간격이 예정의 두 배를 넘었는지(숨은 문서의 타이머 제한 확인용). 처음(prevAt null)은 아님.
export function heartbeatLate(prevAt: number | null, now: number, intervalMs: number): boolean {
  return prevAt !== null && now - prevAt > intervalMs * 2;
}
