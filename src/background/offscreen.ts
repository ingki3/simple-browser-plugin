import { OFFSCREEN_PATH } from "@/lib/documentJob";
import { debugLog, timeSpan } from "./debug";

// 공용 offscreen 문서 관리. 일반 프로필에서는 offscreen 문서를 하나만 열 수 있어, 문서 변환(read_document,
// Worker)과 HTML 본문 추출(read_linked_pages, DOMParser)이 같은 문서를 쓴다. 생성·작업 수·유휴 종료·강제 종료를
// 여기서만 다룬다. 강제로 닫을 때는(작업 감시 시간 초과) 진행 중인 모든 작업을 즉시 실패로 끝낸다.

// 마지막 작업 뒤 이 시간 동안 새 작업이 없으면 offscreen 문서를 닫아 메모리를 돌려준다.
const OFFSCREEN_IDLE_MS = 60_000;

interface OffscreenClient {
  url: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

// 서비스 워커 전역의 clients(타입 정의는 DOM lib 기준이라 필요한 부분만 적는다).
const swClients = (globalThis as unknown as {
  clients: { matchAll(options: { includeUncontrolled: boolean; type: "window" }): Promise<readonly OffscreenClient[]> };
}).clients;

let idleTimer: ReturnType<typeof setTimeout> | null = null;
let creating: Promise<void> | null = null;
let closing: Promise<void> | null = null;
// 진행 중인 작업마다 "문서가 닫혀 실패로 끝내기" 함수. 작업 수도 이것으로 센다.
const active = new Set<() => void>();

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (closing) await closing;
  if (await hasOffscreen()) return;
  if (!creating) {
    const end = timeSpan("offscreen:create");
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
        justification:
          "링크된 문서(Office·PDF·한글·CSV)를 강제 종료할 수 있는 Worker에서 변환하고, 받아 온 기사 HTML을 DOMParser로 파싱해 본문을 뽑는다.",
      })
      .then(
        () => end("ok"),
        (err: unknown) => {
          end("fail");
          throw err;
        },
      )
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function offscreenClient(): Promise<OffscreenClient> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const all = await swClients.matchAll({ includeUncontrolled: true, type: "window" });
  const client = all.find((c) => c.url === url);
  if (!client) throw new Error("offscreen 문서를 찾지 못했습니다.");
  return client;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active.size > 0 || closing) return;
    closing = chrome.offscreen
      .closeDocument()
      .catch(() => {})
      .finally(() => {
        closing = null;
      });
  }, OFFSCREEN_IDLE_MS);
}

// 멈춘 작업 때문에 문서를 닫는다. 같은 문서의 다른 작업도 함께 끝나므로 모두 즉시 실패로 정리한다.
function forceClose(): void {
  debugLog("offscreen:force_close", `${active.size} jobs`, "warn");
  for (const fail of [...active]) fail();
  chrome.offscreen.closeDocument().catch(() => {});
}

// 닫는 타이머는 서비스 워커 종료와 함께 사라지므로, 다시 뜰 때 이전 실행에서 남은 offscreen 문서를 닫는다.
closing = hasOffscreen()
  .then((open) => (open ? chrome.offscreen.closeDocument() : undefined))
  .catch(() => {})
  .finally(() => {
    closing = null;
  });

export interface JobOutcomes<R> {
  signal?: AbortSignal;
  guardMs: number;
  // 사용자가 중단했을 때·감시 시간을 넘겼을 때·다른 작업 때문에 문서가 닫혔을 때 돌려줄 결과.
  cancelled: R;
  timedOut: R;
  closed: R;
}

// 작업 하나를 offscreen 문서에 보내고 MessageChannel로 결과를 받는다.
export async function runOffscreenJob<R>(job: unknown, transfer: Transferable[], o: JobOutcomes<R>): Promise<R> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  let failClosed: (() => void) | null = null;
  // 문서를 여는 동안 다른 작업의 강제 종료가 일어나도 이 작업이 정리되도록 먼저 등록한다.
  let closedEarly = false;
  const early = () => {
    closedEarly = true;
  };
  active.add(early);
  try {
    await ensureOffscreen();
    if (o.signal?.aborted) return o.cancelled;
    if (closedEarly) return o.closed;
    const client = await offscreenClient();
    if (closedEarly) return o.closed;
    const channel = new MessageChannel();
    return await new Promise<R>((resolve) => {
      let settled = false;
      const settle = (r: R) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        o.signal?.removeEventListener("abort", onAbort);
        if (failClosed) active.delete(failClosed);
        channel.port1.close();
        resolve(r);
      };
      const onAbort = () => {
        channel.port1.postMessage({ kind: "cancel" });
        settle(o.cancelled);
      };
      failClosed = () => settle(o.closed);
      active.delete(early);
      active.add(failClosed);
      const guard = setTimeout(() => {
        // 문서가 멈췄으면 닫아서 Worker까지 함께 끝낸다(다른 작업도 실패로 정리됨).
        channel.port1.postMessage({ kind: "cancel" });
        settle(o.timedOut);
        forceClose();
      }, o.guardMs);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      if (o.signal?.aborted) return onAbort();
      channel.port1.onmessage = (ev: MessageEvent<R>) => settle(ev.data);
      client.postMessage(job, [channel.port2, ...transfer]);
    });
  } finally {
    active.delete(early);
    if (failClosed) active.delete(failClosed);
    if (active.size === 0) scheduleIdleClose();
  }
}
