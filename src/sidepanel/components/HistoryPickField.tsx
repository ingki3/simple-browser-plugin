import { useEffect, useRef, useState } from "react";
import type { PageOfferData } from "@/lib/messages";
import type { LinkDraft } from "@/lib/savedPages";
import { useChatStore } from "../state/chatStore";

interface SnapshotItem {
  i: number;
  title: string;
  base: string;
  params: Array<{ p: number; key: string }>;
  warning?: string;
}

interface Pick {
  i: number;
  name: string;
  purpose: string;
  reason: string;
}

type View =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "confirm"; items: SnapshotItem[]; provider: string; model: string }
  | { step: "sending"; items: SnapshotItem[] }
  | { step: "results"; items: SnapshotItem[]; picks: Pick[] };

interface Props {
  // 시작 전에 설정의 저장하지 않은 변경을 저장한다(실패면 false — 시작하지 않는다).
  beforeStart: () => Promise<boolean>;
  // 저장 카드를 채팅에 띄운 뒤(설정 서랍을 닫는다).
  onOpened: () => void;
}

// 방문 기록에서 기억할 페이지 찾기(#175). 누를 때만: 선택 권한(history)을 묻고, 보낼 내용(제목·출처+경로·쿼리 이름 — 쿼리 값과
// 방문 횟수는 보내지 않음)을 먼저 보여 준 뒤 사용자가 고른 항목만 보낸다. 추천마다 "저장 카드 열기"로 채팅에 카드를 띄우고,
// 저장은 카드에서 누를 때만 한다. 이 화면을 닫으면(포트가 끊기면) 진행 중인 작업을 버린다.
export function HistoryPickField({ beforeStart, onOpened }: Props) {
  const [view, setView] = useState<View>({ step: "idle" });
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // 저장 카드를 채팅에 띄운 추천(번호).
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const addPageOffer = useChatStore((s) => s.addPageOffer);
  const port = useRef<chrome.runtime.Port | null>(null);
  const stepRef = useRef<View["step"]>("idle");
  stepRef.current = view.step;
  const jobId = useRef("");

  const disconnect = () => {
    port.current?.disconnect();
    port.current = null;
    jobId.current = "";
  };
  // 화면이 닫힌 뒤에는 진행 중이던 시작을 이어 가지 않는다(새 포트를 만들지 않음).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      disconnect();
    };
  }, []);

  const onMessage = (raw: unknown) => {
    const m = raw as {
      kind: string;
      jobId: string;
      message?: string;
      items?: SnapshotItem[];
      provider?: string;
      model?: string;
      picks?: Pick[];
      offer?: PageOfferData;
      draft?: LinkDraft;
    };
    if (!m || m.jobId !== jobId.current) return;
    if (m.kind === "error") {
      setError(m.message ?? "실패했습니다.");
      // 추천을 받은 뒤의 실패(카드 만들기)는 목록을 그대로 두고, 그 전의 실패는 처음으로 돌아간다.
      if (stepRef.current !== "results") {
        disconnect();
        setView({ step: "idle" });
      }
      return;
    }
    if (m.kind === "prepared" && m.items) {
      // 결제·개인정보 단서가 보이는 항목은 기본으로 체크하지 않는다(사용자가 골라야 보낸다).
      setChecked(new Set(m.items.filter((x) => !x.warning).map((x) => x.i)));
      setView({ step: "confirm", items: m.items, provider: m.provider ?? "", model: m.model ?? "" });
      return;
    }
    if (m.kind === "picks" && m.picks) {
      setView((v) => (v.step === "sending" ? { step: "results", items: v.items, picks: m.picks ?? [] } : v));
      return;
    }
    if (m.kind === "offer" && m.offer) {
      // 카드를 채팅에 띄우고 서랍은 그대로 둔다(다른 추천도 이어서 열 수 있게). "카드 보기"로 닫는다.
      addPageOffer(m.offer, { open: true, autoDraft: false, ...(m.draft ? { initialDraft: m.draft } : {}) });
      const idx = (raw as { index?: unknown }).index;
      if (typeof idx === "number") setOpened((cur) => new Set(cur).add(idx));
    }
  };

  const start = async () => {
    setError(null);
    // 권한 요청은 누른 직후에(사용자 동작 안에서) 한다.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ permissions: ["history"] });
    } catch (err) {
      setError(`방문 기록 권한을 요청하지 못했습니다(${err instanceof Error ? err.message : String(err)}).`);
      return;
    }
    if (!granted) {
      setError("방문 기록 권한을 허락하지 않아 찾지 않았습니다.");
      return;
    }
    if (!alive.current) return;
    if (!(await beforeStart())) {
      if (alive.current) setError("설정을 저장하지 못해 시작하지 않았습니다.");
      return;
    }
    let windowId: number | undefined;
    try {
      windowId = (await chrome.windows.getCurrent()).id;
    } catch {
      windowId = undefined;
    }
    if (!alive.current) return;
    if (windowId === undefined) {
      setError("창을 확인하지 못했습니다.");
      return;
    }
    disconnect();
    const p = chrome.runtime.connect({ name: "history_pick" });
    port.current = p;
    jobId.current = crypto.randomUUID();
    p.onMessage.addListener(onMessage);
    // 백그라운드 연결이 끊기면(서비스 워커 재시작 등) 작업이 사라졌으니 처음으로 돌아가 알린다.
    p.onDisconnect.addListener(() => {
      if (port.current !== p) return;
      port.current = null;
      jobId.current = "";
      if (!alive.current) return;
      setError("연결이 끊겨 작업을 멈췄습니다. 다시 찾아 주세요.");
      setView({ step: "idle" });
    });
    setOpened(new Set());
    setView({ step: "preparing" });
    p.postMessage({ kind: "prepare", jobId: jobId.current, windowId });
  };

  const cancel = () => {
    if (port.current && jobId.current) port.current.postMessage({ kind: "cancel", jobId: jobId.current });
    disconnect();
    setView({ step: "idle" });
  };

  const send = () => {
    if (view.step !== "confirm" || !port.current) return;
    setView({ step: "sending", items: view.items });
    port.current.postMessage({ kind: "send", jobId: jobId.current, indices: [...checked] });
  };

  const openCard = (i: number) => {
    setError(null);
    port.current?.postMessage({ kind: "offer", jobId: jobId.current, index: i });
  };

  return (
    <div className="field history-pick">
      <span className="field-label">방문 기록에서 찾기</span>
      <span className="field-help">
        최근 방문 기록에서 다시 쓸 만한 페이지를 모델이 골라 저장 카드로 보여 줍니다. 누를 때만 동작하고, 보내기 전에 보낼 내용을 보여 줍니다.
      </span>
      {error && <span className="field-help error-text">{error}</span>}
      {view.step === "idle" && (
        <button type="button" className="ghost-btn history-pick-start" onClick={() => void start()}>
          방문 기록에서 찾기
        </button>
      )}
      {view.step === "preparing" && (
        <div className="history-pick-row">
          <span className="field-help">방문 기록을 살피는 중…</span>
          <button type="button" className="btn-cancel" onClick={cancel}>
            취소
          </button>
        </div>
      )}
      {view.step === "confirm" && (
        <div className="history-pick-confirm">
          {view.items.length === 0 ? (
            <span className="field-help">보낼 만한 방문 기록이 없습니다.</span>
          ) : (
            <>
              <span className="field-help">
                체크한 항목의 제목·주소(출처와 경로)·쿼리 이름을 {view.provider} · {view.model}에 보냅니다. 쿼리 값과 방문 횟수는 보내지
                않습니다. 보낸 내용은 되돌릴 수 없습니다.
              </span>
              <ul className="history-pick-list">
                {view.items.map((it) => (
                  <li key={it.i}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={checked.has(it.i)}
                        onChange={(e) =>
                          setChecked((cur) => {
                            const next = new Set(cur);
                            if (e.target.checked) next.add(it.i);
                            else next.delete(it.i);
                            return next;
                          })
                        }
                      />
                      <span>
                        <span className="history-pick-title">{it.title || "(제목 없음)"}</span>
                        {it.warning && <span className="field-help history-pick-warn">⚠ 주소에 {it.warning} 단서가 있어 보입니다. 보내려면 직접 체크하세요.</span>}
                        <span className="history-pick-url">
                          {it.base}
                          {it.params.length ? `?${it.params.map((p) => p.key).join("&")}` : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="page-offer-actions">
            <button type="button" className="btn-cancel" onClick={cancel}>
              취소
            </button>
            <button type="button" className="btn-approve history-pick-send" disabled={!checked.size || !view.items.length} onClick={send}>
              보내기({checked.size})
            </button>
          </div>
        </div>
      )}
      {view.step === "sending" && (
        <div className="history-pick-row">
          <span className="field-help">모델이 고르는 중…</span>
          <button type="button" className="btn-cancel" onClick={cancel}>
            취소
          </button>
        </div>
      )}
      {view.step === "results" && (
        <div className="history-pick-results">
          {view.picks.length === 0 && <span className="field-help">다시 쓸 만한 페이지를 찾지 못했습니다.</span>}
          <ul className="history-pick-list">
            {view.picks.map((p) => {
              const it = view.items.find((x) => x.i === p.i);
              return (
                <li key={p.i}>
                  <span className="history-pick-title">{p.name}</span>
                  <span className="field-help">
                    {p.purpose}
                    {p.reason ? ` — ${p.reason}` : ""}
                  </span>
                  {it && <span className="history-pick-url">{it.base}</span>}
                  <button type="button" className="ghost-btn history-pick-open" disabled={opened.has(p.i)} onClick={() => openCard(p.i)}>
                    {opened.has(p.i) ? "✓ 채팅에 띄움" : "저장 카드 열기"}
                  </button>
                </li>
              );
            })}
          </ul>
          {opened.size > 0 && <span className="field-help">저장 카드는 채팅에 있습니다. 카드에서 확인하고 저장을 누르세요.</span>}
          <div className="page-offer-actions">
            <button type="button" className="btn-cancel" onClick={cancel}>
              닫기
            </button>
            {opened.size > 0 && (
              <button type="button" className="btn-approve history-pick-show" onClick={onOpened}>
                카드 보기
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
