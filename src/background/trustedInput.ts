// 실제 입력 클릭(0.2.0): 설정이 켜져 있으면 click_element를 chrome.debugger(CDP Input.dispatchMouseEvent)로 누른다.
// 보안 모델·한계는 src/lib/trustedClick.ts 머리말. 승인 판정은 바꾸지 않고 실행 수단만 바꾼다.
// 사람처럼 보이게 하는 기능(궤적·무작위 지연)이나 자동화 흔적 숨기기는 넣지 않는다. 디버깅 막대도 숨기지 않는다.
import type { BgToContent, ContentResponse } from "@/lib/messages";
import {
  FRAME_ARM_TIMEOUT_MS,
  frameNeedsGuard,
  guardTimeLeft,
  unguardedFrame,
  GUARD_MIN_REMAINING_MS,
  GUARD_MS,
  type TrustedClickStatus,
  type TrustedPrepare,
} from "@/lib/trustedClick";
import { debugLog } from "./debug";
import { ClickAbortedError } from "./popups";
import { getSettings } from "./storage";
import { callContentTool, isMissingReceiver, recheckTabPopup, resolveTurnTab, topDocumentId, type TurnTab } from "./tools/handlers";

const PROTOCOL_VERSION = "1.3";
// 입력을 보낸 뒤 가드 결과를 읽는 간격(처리기가 아직 돌고 있으면 조금 기다린다).
const RESULT_POLL_MS = [0, 100, 300];

// 한 대화의 디버거 사용 상태. 대화 객체(ChatAgent)가 하나씩 갖고, 새 대화면 새로 만든다.
export class InputSession {
  // 사용자가 디버깅 막대의 취소를 눌렀으면 이 대화에서는 다시 붙이지 않는다(사용자 선택).
  canceledByUser = false;
  readonly tabs = new Set<number>();
  // detachSession마다 올린다. 붙이는 동안 떼기가 있었으면(중단·턴 끝) 붙인 직후 다시 뗀다.
  generation = 0;
}

// 탭마다 디버거를 붙인 대화.
const attached = new Map<number, InputSession>();
let detachListening = false;

function listenDetach(): void {
  if (detachListening) return;
  detachListening = true;
  chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (typeof tabId !== "number") return;
    const session = attached.get(tabId);
    attached.delete(tabId);
    if (!session) return;
    session.tabs.delete(tabId);
    if (reason === "canceled_by_user") {
      session.canceledByUser = true;
      debugLog("input:detach", `tab ${tabId} · 사용자가 디버깅을 취소함 — 이 대화는 스크립트 클릭`, "warn");
    } else {
      debugLog("input:detach", `tab ${tabId} · ${reason}`);
    }
  });
}

// 붙였으면 null, 못 붙였으면 이유.
async function ensureAttached(tabId: number, session: InputSession): Promise<string | null> {
  if (session.canceledByUser) return "사용자가 이 대화에서 디버깅을 취소함";
  if (!chrome.debugger) return "debugger 권한 없음";
  listenDetach();
  const owner = attached.get(tabId);
  if (owner === session) return null;
  if (owner) return "다른 대화가 이 탭에 붙어 있음";
  const generation = session.generation;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (session.generation !== generation) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return "붙이는 동안 중단됨";
  }
  attached.set(tabId, session);
  session.tabs.add(tabId);
  debugLog("input:attach", `tab ${tabId}`);
  return null;
}

// 턴이 끝나거나 대화가 중단·초기화되면 이 대화가 붙인 디버거를 모두 뗀다.
export async function detachSession(session: InputSession): Promise<void> {
  session.generation++;
  const tabs = [...session.tabs];
  session.tabs.clear();
  await Promise.all(
    tabs.map(async (tabId) => {
      if (attached.get(tabId) !== session) return;
      attached.delete(tabId);
      try {
        await chrome.debugger.detach({ tabId });
        debugLog("input:detach", `tab ${tabId}`);
      } catch {
        /* 이미 떨어짐(탭 닫힘 등) */
      }
    }),
  );
}

// 같은 탭의 실제 입력 클릭은 하나씩.
const tabLocks = new Map<number, Promise<unknown>>();
async function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  tabLocks.set(tabId, run);
  try {
    return await run;
  } finally {
    if (tabLocks.get(tabId) === run) tabLocks.delete(tabId);
  }
}

function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 응답 없음`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function sendTo<T>(tabId: number, documentId: string, msg: BgToContent, ms: number, label: string): Promise<T> {
  const res = (await bounded(
    chrome.tabs.sendMessage(tabId, msg, { documentId }) as Promise<ContentResponse<T>>,
    ms,
    label,
  )) as ContentResponse<T>;
  if (!res?.ok) throw new Error(res?.error ?? `${label} 실패`);
  return res.data as T;
}

interface FrameDoc {
  frameId: number;
  documentId: string;
  url: string;
}

async function subFrames(tabId: number): Promise<FrameDoc[]> {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  return frames
    .filter((f) => f.frameId !== 0 && typeof f.documentId === "string")
    .map((f) => ({ frameId: f.frameId, documentId: f.documentId as string, url: f.url }));
}

// top이 아닌 모든 프레임에 가드를 건다. http(s) 문서 중 하나라도 걸지 못하면 실제 입력을 쓰지 않는다.
async function armFrames(tabId: number, token: string): Promise<{ docs: FrameDoc[]; missing: FrameDoc | null }> {
  const frames = await subFrames(tabId);
  const msg: BgToContent = { kind: "input_guard_arm", token, ms: GUARD_MS };
  const results = await Promise.all(
    frames.map((f) =>
      sendTo(tabId, f.documentId, msg, FRAME_ARM_TIMEOUT_MS, "프레임 가드").then(
        () => ({ f, ok: true }),
        () => ({ f, ok: false }),
      ),
    ),
  );
  const docs = results.filter((r) => r.ok).map((r) => r.f);
  const missing = results.find((r) => !r.ok && frameNeedsGuard(r.f.url))?.f ?? null;
  return { docs, missing };
}

async function disarmFrames(tabId: number, token: string, docs: FrameDoc[]): Promise<number> {
  const msg: BgToContent = { kind: "input_guard_disarm", token };
  const counts = await Promise.all(
    docs.map((f) => sendTo<number>(tabId, f.documentId, msg, FRAME_ARM_TIMEOUT_MS, "프레임 가드 해제").catch(() => 0)),
  );
  return counts.reduce((a, b) => a + (b || 0), 0);
}

export interface ClickData {
  clicked: boolean;
  text: string;
  href: string;
  effectToken: string;
  trusted?: TrustedPrepare;
}

export type ClickInput = "trusted" | "script";

export interface InputClickResult extends ClickData {
  input: ClickInput;
  // 스크립트로 누른 이유(설정이 켜져 있는데 실제 입력을 쓰지 못했을 때).
  inputNote?: string;
}

function fail(reason: string): Error {
  return new Error(`실제 입력으로 누르지 않았습니다(${reason}). 다시 관측하세요.`);
}

// click_element 실행. 실제 입력을 쓸 수 없으면(설정 꺼짐·디버거를 붙일 수 없음·가드를 걸 수 없는 프레임) 승인을 쓰기 전에
// 지금의 스크립트 클릭으로 간다. 준비(승인 소비) 뒤에는 대체하지 않는다 — 막히면 실패로 알린다.
export async function clickWithInput(
  args: unknown,
  callId: string,
  turnTab: TurnTab,
  signal: AbortSignal | undefined,
  session: InputSession | undefined,
): Promise<InputClickResult> {
  const script = async (note?: string): Promise<InputClickResult> => {
    if (signal?.aborted) throw new ClickAbortedError();
    const data = await callContentTool<ClickData>("click_element", args, callId, turnTab);
    return { ...data, input: "script", ...(note ? { inputNote: note } : {}) };
  };
  if (!session || !(await getSettings()).trustedInput) return script();
  const tabId = await resolveTurnTab(turnTab);
  return withTabLock(tabId, async () => {
    if (signal?.aborted) throw new ClickAbortedError();
    const notAttached = await ensureAttached(tabId, session);
    if (notAttached) {
      debugLog("input:script", `tab ${tabId} · ${notAttached}`, "warn");
      return script(notAttached);
    }
    const token = crypto.randomUUID();
    let armed: { docs: FrameDoc[]; missing: FrameDoc | null } = { docs: [], missing: null };
    // 프레임 가드는 걸기 시작한 때부터 GUARD_MS 안에 풀리므로, 누르기 직전 남은 시간을 이 시각으로 잰다(보수적으로 보내기 전).
    const armedAt = Date.now();
    try {
      armed = await armFrames(tabId, token);
      if (armed.missing) {
        const note = "가드를 걸 수 없는 프레임이 있음";
        debugLog("input:script", `tab ${tabId} · ${note} (frame ${armed.missing.frameId})`, "warn");
        return await script(note);
      }
      if (signal?.aborted) throw new ClickAbortedError();
      const data = await callContentTool<ClickData>("click_element", args, callId, turnTab, token);
      const prep = data.trusted;
      // 승인 뒤 대상이 바뀌어 누르지 않았으면 결과(effect의 aborted)만 돌려준다(수단 표시 없음).
      if (!prep || prep.mode === "aborted") return { ...data, input: "script" };
      if (prep.mode === "script") {
        debugLog("input:script", `tab ${tabId} · ${prep.reason}`);
        return { ...data, input: "script", inputNote: prep.reason };
      }
      return await press(tabId, token, prep, data, armed.docs, armedAt, turnTab, signal);
    } finally {
      void disarmFrames(tabId, token, armed.docs);
    }
  });
}

async function press(
  tabId: number,
  token: string,
  point: { x: number; y: number },
  data: ClickData,
  armedDocs: FrameDoc[],
  armedAt: number,
  turnTab: TurnTab,
  signal: AbortSignal | undefined,
): Promise<InputClickResult> {
  // 준비한 문서에 고정한다. 문서가 바뀌었으면 그 문서에 가드 토큰이 없어 확인이 실패한다.
  const documentId = await topDocumentId(tabId);
  if (!documentId) throw fail("탭의 문서를 확인할 수 없음");
  try {
    return await pressIn(tabId, documentId, token, point, data, armedDocs, armedAt, turnTab, signal);
  } finally {
    // 입력을 다 보냈거나 보내지 않기로 했으니 top 가드를 뗀다(사용자의 다음 클릭을 막지 않게).
    void sendTo(tabId, documentId, { kind: "input_guard_disarm", token }, 1_000, "가드 해제").catch(() => {});
  }
}

async function pressIn(
  tabId: number,
  documentId: string,
  token: string,
  point: { x: number; y: number },
  data: ClickData,
  armedDocs: FrameDoc[],
  armedAt: number,
  turnTab: TurnTab,
  signal: AbortSignal | undefined,
): Promise<InputClickResult> {
  const cancel = (reason: string) =>
    sendTo(tabId, documentId, { kind: "trusted_click_cancel", token, reason }, 1_000, "클릭 취소").catch(() => {});
  try {
    if (signal?.aborted) throw new ClickAbortedError();
    // 탭으로 열린 팝업이면 아직 앞에 보이는지 다시 본다.
    await recheckTabPopup(turnTab, tabId);
    // 가드를 건 뒤 새로 생기거나 다시 읽힌 http(s) 프레임이 있으면 누르지 않는다.
    const armed = new Set(armedDocs.map((f) => f.documentId));
    const fresh = unguardedFrame(await subFrames(tabId), armed);
    if (fresh) throw fail("페이지의 프레임이 바뀜");
    let remaining: number;
    try {
      remaining = await sendTo<number>(tabId, documentId, { kind: "trusted_click_check", token }, 1_000, "누르기 전 확인");
    } catch (err) {
      throw fail(err instanceof Error ? err.message : String(err));
    }
    // top 가드와 다른 프레임 가드 모두 누르는 동안 살아 있어야 한다.
    if (remaining < GUARD_MIN_REMAINING_MS || !guardTimeLeft(armedAt, Date.now())) throw fail("확인 시간이 모자람");
    if (signal?.aborted) throw new ClickAbortedError();
  } catch (err) {
    await cancel(err instanceof Error ? err.message : String(err));
    throw err;
  }

  // 여기부터는 입력을 보낸다. 오류가 나도 스크립트 클릭으로 대체하지 않는다.
  const target = { tabId };
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...base });
  } catch (err) {
    await cancel("입력 전송 실패");
    throw new Error(`실제 입력을 보내지 못했습니다(${err instanceof Error ? err.message : String(err)}). 다시 관측하세요.`);
  }
  try {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...base });
  } catch (err) {
    await cancel("입력 전송 실패");
    throw new Error(
      `마우스를 누른 뒤 떼는 입력을 보내지 못했습니다(${err instanceof Error ? err.message : String(err)}). 누르기 단계의 처리는 이미 일어났을 수 있으니 다시 관측하세요.`,
    );
  }

  let status: TrustedClickStatus | null = null;
  for (const wait of RESULT_POLL_MS) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      status = await sendTo<TrustedClickStatus | null>(tabId, documentId, { kind: "trusted_click_result", token }, 1_500, "클릭 결과");
    } catch (err) {
      // 누른 뒤 문서가 바뀌었으면(누르기만으로 이동하는 사이트 포함) 결과는 observeClickEffect가 이동으로 판정한다.
      if (isMissingReceiver(err)) return { ...data, input: "trusted" };
      throw new Error("실제 입력 클릭의 결과를 확인하지 못했습니다. 다시 관측하세요.");
    }
    if (status?.status !== "none") break;
  }
  if (!status) throw new Error("실제 입력 클릭의 결과를 확인하지 못했습니다. 다시 관측하세요.");
  if (status.status === "clicked") return { ...data, input: "trusted" };
  if (status.status === "blocked") {
    throw new Error(
      `실제 입력 클릭을 도중에 막았습니다(${status.reason}). 누르기 단계의 처리는 페이지에서 이미 일어났을 수 있으니 다시 관측하세요.`,
    );
  }
  await cancel("입력이 도착하지 않음");
  throw new Error("실제 입력 클릭이 대상에 도착하지 않았습니다. 다시 관측하세요.");
}
