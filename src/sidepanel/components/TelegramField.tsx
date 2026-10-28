import { useCallback, useEffect, useState } from "react";

interface Status {
  hasToken: boolean;
  botName: string;
  connected: boolean;
  chatLabel: string;
  pairingCode: string | null;
  pairingExpiresAt: number | null;
  status: "idle" | "stopped_auth" | "stopped_conflict";
  notifyRepeat: boolean;
  recent: Array<{ at: number; preview: string; status: string }>;
}

type Req =
  | { kind: "telegram_status" }
  | { kind: "telegram_save_token"; token: string }
  | { kind: "telegram_pair" }
  | { kind: "telegram_disconnect" }
  | { kind: "telegram_clear" }
  | { kind: "telegram_set_notify"; on: boolean };

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

  const request = useCallback(async (msg: Req) => {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: Status; error?: string } | undefined;
      if (!res?.ok || !res.data) throw new Error(res?.error ?? "응답이 없습니다.");
      setSt(res.data);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void request({ kind: "telegram_status" });
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
        텔레그램으로 할 일을 보내면 브라우저의 새 탭에서 처리하고 최종 답만 텔레그램으로 보냅니다. 이동은 요청에 적은 사이트 안에서만 하고, 결제·삭제·개인정보 입력·로그인·저장처럼 승인이 필요한 동작은 하지 않습니다. 브라우저가 켜져 있어야 하며 받는 데 최대 1분쯤 걸립니다. 답은 텔레그램(제3자 서비스)을 거칩니다.
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
            <input type="checkbox" checked={st.notifyRepeat} disabled={busy} onChange={(e) => void request({ kind: "telegram_set_notify", on: e.target.checked })} />
            <span>반복 작업의 조건이 맞으면 텔레그램으로 알리기(작업 이름만 보냄)</span>
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
