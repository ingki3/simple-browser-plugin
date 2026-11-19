import { useCallback, useEffect, useState } from "react";
import { useLatestGate } from "../../sidepanel/hooks/syncHelpers";

interface Status {
  hasKey: boolean;
  linkSet: boolean;
  connected: boolean;
  needsLogin: boolean;
  connectedAt: number;
}

type Req =
  | { kind: "kakao_status" }
  | { kind: "kakao_save_keys"; restKey: string; clientSecret: string; linkUrl: string }
  | { kind: "kakao_connect" }
  | { kind: "kakao_disconnect" }
  | { kind: "kakao_clear" }
  | { kind: "kakao_test_send" };

const when = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 카카오톡 나에게 보내기(#310): 사용자가 만든 Kakao Developers 앱의 키·시크릿·링크 주소 저장(돌려받지 않음), 카카오 로그인 연결,
// 시험 메시지, 연결 끊기·지우기. 상태는 연결 여부·연결 시각만 보인다.
export function KakaoField() {
  const [st, setSt] = useState<Status | null>(null);
  const [restKey, setRestKey] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 콘솔에 먼저 등록할 리다이렉트 URI(확장 ID 기반 — identity 권한 없이도 보인다).
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const gate = useLatestGate();
  const request = useCallback(
    async (msg: Req) => {
      const latest = gate();
      const quiet = msg.kind === "kakao_status";
      if (!quiet) {
        setBusy(true);
        setError(null);
        setNotice(null);
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
    void request({ kind: "kakao_status" });
  }, [request]);
  // 다른 화면에서 연결·끊기·키를 바꾸면(또는 보내다 로그인이 끝나면) 다시 읽는다.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && "kakao" in changes) void request({ kind: "kakao_status" });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [request]);

  // 사용자 동작 안에서 선택 권한(identity)을 먼저 요청한 뒤 연결한다. 이미 있으면(Google 연동 빌드) 요청하지 않는다.
  const connect = async () => {
    setError(null);
    setNotice(null);
    if (typeof chrome.identity === "undefined") {
      let ok = false;
      try {
        ok = await chrome.permissions.request({ permissions: ["identity"] });
      } catch {
        ok = false;
      }
      if (!ok) {
        setError("권한이 없어 연결하지 않았습니다.");
        return;
      }
    }
    if (await request({ kind: "kakao_connect" })) setNotice("연결했습니다. '시험 메시지 보내기'로 카카오톡에 오는지 확인하세요.");
  };

  const showForm = !st?.hasKey || editing;
  const canSave = !!restKey.trim() && !!linkUrl.trim();

  return (
    <div className="field">
      <span className="field-label">카카오톡 나에게 보내기</span>
      <span className="field-help">
        패널에서 "결과를 카톡으로 보내 줘"라고 하면 그 글을 내 카카오톡 "나와의 채팅"으로 보냅니다(한 메시지 200자, 5개까지). 직접 만든 Kakao Developers 앱으로
        로그인합니다. 보낸 글은 카카오(제3자 서비스)를 거칩니다. 카카오톡에서 받은 글로 도우미를 시키는 기능은 없습니다.
      </span>
      {error && <span className="field-help error-text">{error}</span>}
      {notice && <span className="field-hint">{notice}</span>}
      <details className="field-hint">
        <summary>카카오 개발자 콘솔 설정 순서</summary>
        <ol>
          <li>developers.kakao.com에서 앱을 만듭니다.</li>
          <li>앱 키의 REST API 키와 (켰다면) 클라이언트 시크릿을 확인합니다.</li>
          <li>카카오 로그인을 사용으로 켭니다.</li>
          <li>REST API 키의 리다이렉트 URI에 아래 주소를 등록합니다.</li>
          <li>동의항목에서 "카카오톡 메시지 전송(talk_message)"을 선택 동의로 켭니다.</li>
          <li>제품 링크 관리 → 웹 도메인에 메시지 링크 주소의 도메인을 등록합니다.</li>
        </ol>
      </details>
      <span className="field-hint">
        리다이렉트 URI: <code className="copy-hint">{redirectUri}</code>{" "}
        <button type="button" className="ghost-btn" onClick={() => void navigator.clipboard.writeText(redirectUri).catch(() => {})}>
          복사
        </button>
      </span>

      {showForm ? (
        <>
          <input type="password" value={restKey} placeholder="REST API 키" autoComplete="new-password" aria-label="REST API 키" onChange={(e) => setRestKey(e.target.value)} />
          <input
            type="password"
            value={clientSecret}
            placeholder="클라이언트 시크릿(선택 — 콘솔에서 껐으면 비움)"
            autoComplete="new-password"
            aria-label="클라이언트 시크릿"
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <input type="text" inputMode="url" spellCheck={false} value={linkUrl} placeholder="메시지 링크 주소(https://…, 콘솔 웹 도메인에 등록한 주소)" aria-label="메시지 링크 주소" onChange={(e) => setLinkUrl(e.target.value)} />
          <div className="repeat-actions">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !canSave}
              onClick={async () => {
                if (await request({ kind: "kakao_save_keys", restKey, clientSecret, linkUrl })) {
                  setRestKey("");
                  setClientSecret("");
                  setLinkUrl("");
                  setEditing(false);
                }
              }}
            >
              저장
            </button>
            {editing && (
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => setEditing(false)}>
                취소
              </button>
            )}
          </div>
          {st?.hasKey && <span className="field-hint">새로 저장하면 연결이 끊기고 다시 연결해야 합니다.</span>}
        </>
      ) : (
        <>
          <span className="field-hint">REST API 키·링크 주소 저장됨(가림)</span>
          {st?.connected ? (
            <span className="tag-ok">● 연결됨{st.connectedAt ? ` · ${when(st.connectedAt)}` : ""}</span>
          ) : st?.needsLogin ? (
            <span className="tag-warn">● 다시 로그인 필요</span>
          ) : (
            <span className="tag-off">● 연결 안 됨</span>
          )}
          <div className="repeat-actions">
            <button type="button" className="ghost-btn" disabled={busy || !st?.linkSet} onClick={() => void connect()}>
              {st?.connected ? "다시 연결" : "카카오 연결"}
            </button>
            {st?.connected && (
              <button
                type="button"
                className="ghost-btn"
                disabled={busy}
                onClick={async () => {
                  if (await request({ kind: "kakao_test_send" })) setNotice("시험 메시지를 보냈습니다. 카카오톡 나와의 채팅을 확인하세요.");
                }}
              >
                시험 메시지 보내기
              </button>
            )}
            {(st?.connected || st?.needsLogin) && (
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => void request({ kind: "kakao_disconnect" })}>
                연결 끊기
              </button>
            )}
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => setEditing(true)}>
              키 바꾸기
            </button>
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => void request({ kind: "kakao_clear" })}>
              모두 지우기
            </button>
          </div>
          <span className="field-hint">연결 끊기는 이 브라우저의 토큰만 지웁니다. 카카오 쪽 연결은 카카오 계정 → 연결된 서비스 관리에서 끊을 수 있습니다.</span>
        </>
      )}
    </div>
  );
}
