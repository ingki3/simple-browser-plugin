// 원격 채널(텔레그램 #139, MCP #140)이 함께 쓰는 실행부: 채널별 대화 객체, 한 번에 요청 하나(실행 슬롯), 작업 탭, 중단, 결과.
// 받기·보내기·연결 상태는 채널 모듈이 맡는다. 원격 대화의 정책(승인이 필요한 동작은 하지 않음)은 ChatAgent의 channel이 정한다.
import { SETTINGS_KEY, type Settings } from "@/lib/messages";
import { normalizeSettings } from "@/lib/settings";
import type { RemoteApprover } from "@/lib/remoteApproval";
import { ChatAgent, type AgentChannel, type AgentSink, type TurnOutcome } from "./openrouter";

// 이 시간 동안 요청이 없으면 다음 요청은 새 대화로 시작한다.
const IDLE_RESET_MS = 60 * 60_000;

// 원격 대화의 이벤트는 패널로 가지 않는다(최종 답은 sendUserTurn의 결과로만 쓴다).
const sink: AgentSink = { postMessage: () => {} };

interface Session {
  agent: ChatAgent;
  tab: { tabId: number; url: string } | null;
  lastAt: number;
}

export type RunEnd = { status: "done"; result: TurnOutcome } | { status: "stopped" } | { status: "failed"; error: unknown };

// run()이 돌려주는 것. 슬롯은 run()에서 바로 잡고, 실행은 start()로 시작한다(채널이 그 사이 준비·확인을 할 수 있게).
// signal: 이 요청을 멈추면(stop·drop) 끊긴다 — 채널은 결과 보내기에도 이 신호를 쓴다. end: 실행이 끝나면(또는 시작 전에 멈추면) 풀린다.
export interface RunHandle {
  signal: AbortSignal;
  start(): void;
  end: Promise<RunEnd>;
}

export class RemoteRunner {
  private session: Session | null = null;
  // 실행 슬롯. 멈춰도(stopping) 실행이 실제로 끝날 때까지 비우지 않는다(멈추는 중인 도구와 다음 요청이 겹치지 않게).
  private slot: { id: string; agent: ChatAgent; stopping: boolean; abort: AbortController } | null = null;

  // perRequest: 요청마다 새 대화로 시작하고, 끝나면 그 대화를 닫는다(MCP — 호출이 서로 독립이고, 앞 요청의 외부 본문 보호·
  // 남은 페이지 번역이 다음 요청이나 다리가 끝난 뒤까지 이어지지 않게).
  constructor(
    private readonly channel: AgentChannel,
    private readonly opts: { perRequest?: boolean } = {},
  ) {
    // 설정에서 제공자·키·모델·실행 방식을 바꾸면 원격 대화에도 알린다(그 대화가 연 페이지 번역을 멈추는 등, 패널 대화와 같게).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[SETTINGS_KEY] && this.session) {
        this.session.agent.onSettingsChanged(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined));
      }
    });
  }

  get busy(): boolean {
    return this.slot !== null;
  }

  // 진행 중인 요청을 멈춘다(실행이 끝나면 슬롯이 빈다). 멈출 것이 있었으면 true.
  stop(): boolean {
    const slot = this.slot;
    if (!slot || slot.stopping) return false;
    slot.stopping = true;
    slot.agent.abort();
    // 시작 전이면 이 신호의 리스너가 바로 슬롯을 비운다(그래서 지역 변수로 다룬다).
    slot.abort.abort();
    return true;
  }

  // 대화를 버린다(요청이 끝난 대화라도 그 대화가 시작한 페이지 번역 등을 멈춘다). 진행 중인 요청도 멈춘다.
  drop(): void {
    this.stop();
    this.session?.agent.abort();
    this.session = null;
  }

  // 요청 하나의 슬롯을 잡는다. 이미 실행 중이면 null(부르는 쪽이 바쁘다고 답한다).
  // onRunning(mine): 실행하는 동안 채널이 할 일(텔레그램은 /stop을 빨리 받으려고 이어서 받는다). mine()이 false가 되면 그만둔다.
  // approver: 이 요청에서 승인이 필요한 동작을 원격으로 물을 곳(#185). 요청마다 넘긴다.
  run(text: string, onRunning?: (mine: () => boolean) => void, approver?: RemoteApprover): RunHandle | null {
    if (this.slot) return null;
    if (!this.session || this.opts.perRequest || Date.now() - this.session.lastAt > IDLE_RESET_MS) {
      this.session?.agent.abort();
      // 요청마다 새 대화여도 작업 탭은 이어서 쓴다(그 탭이 지난 요청이 끝난 주소 그대로일 때만 — workTab).
      const tab = this.opts.perRequest ? (this.session?.tab ?? null) : null;
      this.session = { agent: new ChatAgent(sink, { channel: this.channel }), tab, lastAt: Date.now() };
    }
    const cur = this.session;
    cur.lastAt = Date.now();
    const id = crypto.randomUUID();
    const abort = new AbortController();
    this.slot = { id, agent: cur.agent, stopping: false, abort };
    const mine = () => this.slot?.id === id && !this.slot.stopping;
    const release = () => {
      if (this.slot?.id === id) this.slot = null;
      // 요청마다 새 대화면 끝난 대화를 닫는다(그 대화가 시작한 페이지 번역 등을 멈춘다).
      if (this.opts.perRequest) cur.agent.abort();
    };
    let resolveEnd!: (e: RunEnd) => void;
    const end = new Promise<RunEnd>((r) => (resolveEnd = r));
    let started = false;
    // 시작하기 전에 멈췄으면 바로 끝낸다.
    abort.signal.addEventListener(
      "abort",
      () => {
        if (!started) {
          started = true;
          release();
          resolveEnd({ status: "stopped" });
        }
      },
      { once: true },
    );
    const start = () => {
      if (started) return;
      started = true;
      void (async (): Promise<RunEnd> => {
        const hold = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20_000);
        try {
          const tabId = await workTab(cur);
          if (!mine()) return { status: "stopped" };
          onRunning?.(mine);
          const result = await cur.agent.sendUserTurn(text, { tabId, approver });
          // 이 요청이 끝난 주소를 기억한다(다음 요청은 이 탭이 이 주소 그대로일 때만 새 탭 화면으로 되돌려 다시 쓴다).
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          cur.tab = tab?.url ? { tabId, url: tab.url } : null;
          if (!mine() || result.outcome === "aborted") return { status: "stopped" };
          return { status: "done", result };
        } catch (error) {
          return mine() ? { status: "failed", error } : { status: "stopped" };
        } finally {
          clearInterval(hold);
          release();
        }
      })().then(resolveEnd);
    };
    return { signal: abort.signal, start, end };
  }
}

// 이 대화의 작업 탭. 요청마다 새 탭 화면(내부 페이지)에서 시작한다 — 지난 요청이 남긴 페이지(그 사이 사용자가 옮겼을 수도
// 있는)를 이번 요청의 신뢰 사이트로 삼지 않게. 지난 요청이 끝난 주소에 그대로 있는 탭이면 새 탭 화면으로 되돌려 다시 쓰고
// (바뀌지 않으면 쓰지 않는다), 아니면(닫았거나 사용자가 옮겼으면) 그 탭은 두고 새 탭을 연다. 활성 탭으로 대신하지 않는다.
async function workTab(sess: Session): Promise<number> {
  if (sess.tab) {
    const cur = await chrome.tabs.get(sess.tab.tabId).catch(() => null);
    if (cur?.id !== undefined && cur.url === sess.tab.url) {
      await chrome.tabs.update(cur.id, { url: "chrome://newtab/" });
      sess.tab = null;
      if (await waitInternal(cur.id)) return cur.id;
    }
  }
  const created = await chrome.tabs.create({ url: "chrome://newtab/", active: false });
  if (created.id === undefined) throw new Error("작업 탭을 열지 못했습니다.");
  sess.tab = null;
  return created.id;
}

// 새 탭 화면으로 바뀌었으면 true(최대 3초 기다림). 바뀌지 않았으면 그 탭을 쓰지 않는다(이전 사이트를 믿지 않게).
async function waitInternal(tabId: number): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.url === "chrome://newtab/" && !t.pendingUrl && t.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
