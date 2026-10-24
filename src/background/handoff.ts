// 손 넘기기(직접 조작할 사이트, 0.2.2): click_element·fill_form_fields를 실행하지 않고, 승인 대상을 페이지에 표시해 사용자가
// 직접 하게 한다. 사용자가 표시한 대상을 누르거나(clicked), 문서가 바뀌거나(page_changed), 패널에서 "했어요"를 누르면
// (confirmed) 이어 간다. 페이지에 입력을 보내지 않고, 사용자가 입력한 값을 읽지 않는다(#43).
import type { HandoffOutcome } from "@/lib/manualSites";
import { debugLog } from "./debug";
import { isMissingReceiver, resolveTurnTab, topDocumentId, type TurnTab } from "./tools/handlers";
import { sendTo } from "./trustedInput";

const POLL_MS = 500;

export interface HandoffSession {
  tabId: number;
  documentId: string;
  token: string;
}

export async function showHandoff(
  turnTab: TurnTab,
  callId: string,
  prefix: "c" | "f",
  ids: string[],
): Promise<HandoffSession> {
  const tabId = await resolveTurnTab(turnTab);
  const documentId = await topDocumentId(tabId);
  if (!documentId) throw new Error("탭의 문서를 확인할 수 없습니다. 다시 관측하세요.");
  const token = crypto.randomUUID();
  try {
    await sendTo(tabId, documentId, { kind: "handoff_show", token, ids, callId, prefix }, 3_000, "대상 표시");
  } catch (err) {
    // 응답만 늦었으면 페이지에는 표시가 생길 수 있다. 이 토큰의 표시를 지금과 조금 뒤에 뗀다.
    const end = () => void sendTo(tabId, documentId, { kind: "handoff_end", token }, 1_000, "표시 해제").catch(() => {});
    end();
    setTimeout(end, 5_000);
    throw err;
  }
  return { tabId, documentId, token };
}

// 사용자가 표시한 대상을 눌렀는지, 문서가 바뀌었는지 살핀다. 끝나면 onDone을 한 번 부른다. 돌려준 함수로 멈춘다.
// expired: 사용자가 오래 조작하지 않아 표시가 만료됐거나 표시 기록을 잃음(완료로 보지 않는다).
export type WatchOutcome = Exclude<HandoffOutcome, "confirmed"> | "expired";

export function watchHandoff(session: HandoffSession, onDone: (outcome: WatchOutcome) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (outcome: WatchOutcome) => {
    if (stopped) return;
    stopped = true;
    onDone(outcome);
  };
  const tick = async () => {
    if (stopped) return;
    try {
      // 같은 탭에서 다른 문서로 바뀌었으면(이동·다시 불러옴) 사용자가 조작한 결과로 본다.
      const now = await topDocumentId(session.tabId);
      if (now !== session.documentId) return finish("page_changed");
      const status = await sendTo<{ clicked: boolean; expired: boolean; frameChanged: boolean } | null>(
        session.tabId,
        session.documentId,
        { kind: "handoff_status", token: session.token },
        2_000,
        "직접 조작 확인",
      );
      // 같은 문서인데 기록이 없으면(확장이 다시 주입됨 등) 사용자가 했는지 알 수 없어 완료로 보지 않는다.
      if (!status) return finish("expired");
      if (status.clicked) return finish("clicked");
      // 대상이 든 iframe만 이동했으면(그 안에서 제출 등) top 문서는 그대로다.
      if (status.frameChanged) return finish("page_changed");
      if (status.expired) return finish("expired");
    } catch (err) {
      if (isMissingReceiver(err)) return finish("page_changed");
      // 탭이 닫혔으면 문서를 읽지 못한다(topDocumentId가 null → 위에서 page_changed). 그 밖의 일시 오류는 다음에 다시 본다.
      debugLog("handoff:poll", err instanceof Error ? err.message : String(err), "warn");
    }
    if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
  };
  timer = setTimeout(() => void tick(), POLL_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export async function endHandoff(session: HandoffSession): Promise<void> {
  await sendTo(session.tabId, session.documentId, { kind: "handoff_end", token: session.token }, 1_000, "표시 해제").catch(
    () => {},
  );
}
