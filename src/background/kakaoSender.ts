// send_to_kakao(#310)의 연결 지점. 도구 쪽(dispatcher·ChatAgent)은 여기만 부르고, kakao.ts가 준비·보내기 함수를 등록한다
// (telegramSender.ts와 같은 등록식 — 도구 쪽이 네트워크·저장 모듈을 직접 불러오지 않게).
// 준비 정보(원문·가린 글·연결 세대·연결 신호)는 호출(callId)마다 이 모듈 메모리에만 둔다. 실행 인자·패널·기록·모델 결과에는 싣지 않는다.
import { kakaoSendErrorText, type KakaoSendOutcome, type KakaoSendWhy, type PreparedKakaoSend } from "@/lib/kakao";

export interface KakaoSender {
  prepare(text: string): Promise<{ ok: true; prepared: PreparedKakaoSend; parts: number } | { ok: false; why: KakaoSendWhy }>;
  send(p: PreparedKakaoSend, signal: AbortSignal): Promise<KakaoSendOutcome>;
}

let sender: KakaoSender | null = null;

export function setKakaoSender(s: KakaoSender): void {
  sender = s;
}

// 카드가 떠 있는 호출의 준비 정보. 실행·취소에서 지운다. 끝나지 않고 버려진 턴(중단·새 대화)의 것은 오래된 것부터 밀어낸다.
const prepared = new Map<string, PreparedKakaoSend>();
const MAX_PREPARED = 16;

// 미리보기: 연결을 확인하고 글을 가린다. 실패하면 고정 문구로 던진다(카드를 띄우지 않고 이 호출의 실패로 끝난다).
export async function prepareKakaoSendCall(callId: string, text: string): Promise<{ safeText: string; parts: number }> {
  if (!sender) throw new Error(kakaoSendErrorText("not_connected", 0));
  const r = await sender.prepare(text);
  if (!r.ok) throw new Error(kakaoSendErrorText(r.why, 0));
  prepared.delete(callId);
  prepared.set(callId, r.prepared);
  while (prepared.size > MAX_PREPARED) prepared.delete(prepared.keys().next().value as string);
  return { safeText: r.prepared.safeText, parts: r.parts };
}

// 실행: 미리보기가 준비한 글만 보낸다(실행 인자의 글은 쓰지 않는다). 준비 정보가 없으면 다시 준비하지 않고 거절한다.
export async function sendPreparedKakao(callId: string, signal: AbortSignal | undefined): Promise<{ parts: number }> {
  const p = prepared.get(callId);
  prepared.delete(callId);
  if (!p || !sender) throw new Error(kakaoSendErrorText("connection_changed", 0));
  const r = await sender.send(p, signal ?? new AbortController().signal);
  if (!r.ok) throw new Error(kakaoSendErrorText(r.why, r.sent));
  return { parts: r.parts };
}

// 취소한 호출의 준비 정보를 버린다.
export function discardKakaoSend(callId: string): void {
  prepared.delete(callId);
}
