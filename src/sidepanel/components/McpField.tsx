import { useCallback, useEffect, useState } from "react";

interface Status {
  enabled: boolean;
  port: number;
  hasSecret: boolean;
  connected: boolean;
  lastOkAt: number;
  bridgeVersion: string;
  lastError: string;
}

type Req =
  | { kind: "mcp_status" }
  | { kind: "mcp_set"; enabled?: boolean; port?: number }
  | { kind: "mcp_regenerate" };

const when = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// MCP 연동(#140): 켜기·포트·비밀(보기·복사·새로 만들기)·연결 상태와 MCP 클라이언트 설정 예시.
export function McpField() {
  const [st, setSt] = useState<Status | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [port, setPort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback(async (msg: Req) => {
    setBusy(true);
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: Status; error?: string } | undefined;
      if (!res?.ok || !res.data) throw new Error(res?.error ?? "응답이 없습니다.");
      setSt(res.data);
      setPort(String(res.data.port));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const showSecret = async () => {
    const res = (await chrome.runtime.sendMessage({ kind: "mcp_secret" })) as { ok: boolean; data?: string; error?: string } | undefined;
    if (res?.ok && typeof res.data === "string") setSecret(res.data);
    else setError(res?.error ?? "비밀을 읽지 못했습니다.");
  };

  useEffect(() => {
    void request({ kind: "mcp_status" });
    const t = setInterval(() => void request({ kind: "mcp_status" }), 10_000);
    return () => clearInterval(t);
  }, [request]);

  const s = secret ?? "<설정에서 복사한 비밀>";
  const p = st?.port ?? 47615;
  const portEnv = p === 47615 ? "" : ` -e SBP_PORT=${p}`;
  const cli = `claude mcp add simple-browser -e SBP_SECRET=${s}${portEnv} -- node "<압축 푼 폴더>/mcp/sbp-mcp.mjs"`;
  const desktop = JSON.stringify(
    { mcpServers: { "simple-browser": { command: "<node 절대 경로>", args: ["<압축 푼 폴더>/mcp/sbp-mcp.mjs"], env: { SBP_SECRET: s, ...(p === 47615 ? {} : { SBP_PORT: String(p) }) } } } },
    null,
    2,
  );

  return (
    <div className="field">
      <span className="field-label">MCP (다른 AI 도구에서 시키기)</span>
      <span className="field-help">
        Claude Code·Claude Desktop 같은 AI 도구가 이 도우미에게 브라우저 일을 시키고 최종 답을 받습니다. 처리 방식은 텔레그램과 같습니다(새 탭에서, 승인이 필요한 동작은 하지 않음). 함께 들어 있는 다리 프로그램(mcp/sbp-mcp.mjs, Node 22 이상 필요)을 그 AI 도구에 등록해야 합니다. 답은 그 AI 도구로 가고, 그 도구가 자기 AI 서비스로 보낼 수 있습니다.
      </span>
      {error && <span className="field-help error-text">{error}</span>}
      <label className="check-row">
        <input type="checkbox" checked={!!st?.enabled} disabled={busy || !st} onChange={(e) => void request({ kind: "mcp_set", enabled: e.target.checked })} />
        <span>MCP 연동 켜기</span>
      </label>
      {st?.enabled && (
        <>
          <span className={st.connected ? "tag-ok" : "field-hint"}>
            {st.connected ? `● 다리와 연결됨 (v${st.bridgeVersion})` : st.lastOkAt ? `마지막 연결 ${when(st.lastOkAt)}` : "다리를 기다리는 중 — AI 도구에서 다리가 실행되면 연결됩니다."}
          </span>
          {!st.connected && st.lastError && <span className="field-hint">{st.lastError}</span>}
          <div className="key-row">
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} aria-label="포트" />
            <button type="button" className="ghost-btn" disabled={busy || Number(port) === st.port} onClick={() => void request({ kind: "mcp_set", port: Number(port) })}>
              포트 저장
            </button>
          </div>
          <div className="repeat-actions">
            <button type="button" className="ghost-btn" onClick={() => void showSecret()}>
              비밀 보기
            </button>
            {secret && (
              <button type="button" className="ghost-btn" onClick={() => void navigator.clipboard.writeText(secret)}>
                비밀 복사
              </button>
            )}
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={async () => {
                setSecret(null);
                await request({ kind: "mcp_regenerate" });
              }}
            >
              비밀 새로 만들기
            </button>
          </div>
          <span className="field-hint">비밀은 다리 설정(SBP_SECRET)에만 넣고 다른 곳에 붙여 넣지 마세요. 새로 만들면 예전 설정은 더 이상 연결되지 않습니다.</span>
          <span className="field-hint">Claude Code:</span>
          <pre className="tool-card-details">{cli}</pre>
          <span className="field-hint">Claude Desktop (claude_desktop_config.json):</span>
          <pre className="tool-card-details">{desktop}</pre>
        </>
      )}
    </div>
  );
}
