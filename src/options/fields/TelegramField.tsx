import { useCallback, useEffect, useState } from "react";
import { useLatestGate } from "../../sidepanel/hooks/syncHelpers";

interface Status {
  hasToken: boolean;
  botName: string;
  connected: boolean;
  chatLabel: string;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  status: "idle" | "stopped_auth" | "stopped_conflict";
  notifyRepeat: boolean;
  notifyRepeatSummary: boolean;
  askApproval: boolean;
  recent: Array<{ at: number; preview: string; status: string }>;
}

type Req =
  | { kind: "telegram_status" }
  | { kind: "telegram_save_token"; token: string }
  | { kind: "telegram_pair" }
  | { kind: "telegram_disconnect" }
  | { kind: "telegram_clear" }
  | { kind: "telegram_set_notify"; on: boolean }
  | { kind: "telegram_set_notify_summary"; on: boolean }
  | { kind: "telegram_set_ask"; on: boolean };

const RECENT_STATUS: Record<string, string> = {
  running: "처리 중",
  done: "답함",
  stopped: "멈춤",
  failed: "실패",
  interrupted: "중단됨",
};

const when = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 텔레그램 연동(#139): 봇 토큰 저장(돌려받지 않음), 확인 코드로 개인 대화 하나 연결, 끊기·지우기, 반복 작업 알림, 최근 요청.
export function TelegramField() {
  const [st, setSt] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 마지막 요청의 응답만 화면에 쓴다(#127). 상태 다시 읽기는 버튼을 막지 않는다.
  const gate = useLatestGate();
  const request = useCallback(
    async (msg: Req) => {
      const latest = gate();
      const quiet = msg.kind === "telegram_status";
      if (!quiet) {
        setBusy(true);
        setError(null);
      }
      try {
        const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: Status; error?: string } | undefined;
        if (!res?.ok || !res.data) throw new Error(res?.error ?? "응답이 없습니다.");
        if (latest()) setSt(res.data);
        return true;
      } catch (err) {
        if (latest() || !quiet) setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [gate],
  );

  useEffect(() => {
    void request({ kind: "telegram_status" });
  }, [request]);
  // 다른 화면에서 연결·끊기·설정을 바꾸거나 요청을 처리하면(최근 요청 recent, #145) 설정 탭을 오래 열어 두어도 다시 읽는다.
  // 받기 기록(offset·failures)만 바뀐 것은 보지 않는다 — 상태 조회가 받기를 다시 시도해 실패 기록이 또 바뀌는 순환을 만들지 않게
  // (recent는 요청 실행만 바꾸고 상태 조회는 바꾸지 않는다).
  useEffect(() => {
    const fields = ["token", "botName", "chatId", "chatLabel", "connectedAt", "epoch", "notifyRepeat", "notifyRepeatSummary", "askApproval", "status", "pairing", "recent"];
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !("telegram" in changes)) return;
      const o = (changes.telegram.oldValue ?? {}) as Record<string, unknown>;
      const n = (changes.telegram.newValue ?? {}) as Record<string, unknown>;
      if (fields.some((f) => JSON.stringify(o[f]) !== JSON.stringify(n[f]))) void request({ kind: "telegram_status" });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [request]);

  // 확인 코드를 기다리는 동안에는 연결됐는지 몇 초마다 다시 본다.
  useEffect(() => {
    if (!st?.pairingCode || st.connected) return;
    const t = setInterval(() => void request({ kind: "telegram_status" }), 3000);
    return () => clearInterval(t);
  }, [st?.pairingCode, st?.connected, request]);

  return (
    <div className="field">
      <span className="field-label">텔레그램 봇</span>
      <span className="field-help">
        텔레그램으로 할 일을 보내면 브라우저의 새 탭에서 처리하고 최종 답만 텔레그램으로 보냅니다. 승인이 필요한 일은 아래 "텔레그램 버튼으로 묻기"가 켜져 있을 때만 요청마다 한 번 묻고 진행하며, 끄면 원격에서는 하지 않습니다. 브라우저가 켜져 있어야 하며 받는 데 최대 1분쯤 걸립니다. 답은 텔레그램(제3자 서비스)을 거칩니다.
      </span>
      {error && <span className="field-help error-text">{error}</span>}
      {st?.status === "stopped_auth" && <span className="field-help error-text">텔레그램이 토큰을 받지 않아 멈췄습니다. 토큰을 다시 저장하세요.</span>}
      {st?.status === "stopped_conflict" && (
        <span className="field-help error-text">다른 곳(다른 프로그램이나 웹훅)이 같은 봇을 쓰고 있어 멈췄습니다. 그쪽을 끈 뒤 다시 연결하세요.</span>
      )}

      {!st?.hasToken ? (
        <>
          <span className="field-hint">1. 텔레그램에서 @BotFather에게 /newbot을 보내 봇을 만들고, 받은 토큰을 아래에 넣으세요.</span>
          <div className="key-row">
            <input type="password" value={token} placeholder="123456789:AA…" autoComplete="new-password" onChange={(e) => setToken(e.target.value)} />
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !token.trim()}
              onClick={async () => {
                if (await request({ kind: "telegram_save_token", token })) setToken("");
              }}
            >
              저장
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="field-hint">봇: {st.botName}</span>
          {st.connected ? (
            <span className="tag-ok">● 연결됨{st.chatLabel ? ` · ${st.chatLabel}` : ""}</span>
          ) : st.pairingCode ? (
            <span className="field-hint">
              2. 텔레그램에서 {st.botName}과의 대화에 이 코드를 보내세요: <strong className="pairing-code">{st.pairingCode}</strong>
              {st.pairingExpiresAt ? ` (${when(st.pairingExpiresAt)}까지)` : ""}
            </span>
          ) : (
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => void request({ kind: "telegram_pair" })}>
              연결하기(확인 코드 받기)
            </button>
          )}
          <label className="check-row">
            <input type="checkbox" checked={st.askApproval} disabled={busy} onChange={(e) => void request({ kind: "telegram_set_ask", on: e.target.checked })} />
            <span>승인이 필요한 일은 텔레그램 버튼으로 묻기 — 요청마다 처음 한 번 맡길지 묻고, 맡기면 그 요청은 결제·삭제까지 묻지 않고 실행(요청·할 일·주소를 텔레그램으로 보냄, 끄면 원격에서는 하지 않음)</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={st.notifyRepeat} disabled={busy} onChange={(e) => void request({ kind: "telegram_set_notify", on: e.target.checked })} />
            <span>반복 작업의 조건이 맞으면 텔레그램으로 알리기(작업 이름을 보냄 — 아래를 켜면 확인 결과 요약도)</span>
          </label>
          <label className="check-row check-row-sub">
            <input
              type="checkbox"
              checked={st.notifyRepeatSummary}
              disabled={busy || !st.notifyRepeat}
              onChange={(e) => void request({ kind: "telegram_set_notify_summary", on: e.target.checked })}
            />
            <span>
              알림에 확인 결과 요약도 보내기(기본 끔) — 요약은 확인한 페이지 내용을 보고 AI가 쓴 글이라 페이지 글자가 들어갈 수 있고, 텔레그램 서버에 남습니다(봇 대화는
              종단 간 암호화가 아님). 자동 로그인 값은 가리고 1000자까지 보냅니다.
            </span>
          </label>
          <div className="repeat-actions">
            {st.connected && (
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => void request({ kind: "telegram_disconnect" })}>
                연결 끊기
              </button>
            )}
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => void request({ kind: "telegram_clear" })}>
              토큰 지우기
            </button>
          </div>
          <span className="field-hint">토큰이 새어 나갔다면 여기서 지우는 것만으로는 막을 수 없습니다. @BotFather에서 /revoke로 토큰을 폐기하세요.</span>
          {st.recent.length > 0 && (
            <ul className="repeat-list">
              {st.recent.map((r) => (
                <li key={r.at} className="repeat-meta">
                  {when(r.at)} · {RECENT_STATUS[r.status] ?? r.status} · {r.preview}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
