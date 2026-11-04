import { useCallback, useEffect, useState } from "react";
import { useLatestGate, useSyncedDraft } from "../hooks/syncHelpers";
import { LATEST_RELEASE_URL } from "@/lib/projectLinks";

interface Status {
  enabled: boolean;
  port: number;
  hasSecret: boolean;
  connected: boolean;
  lastOkAt: number;
  bridgeVersion: string;
  lastError: string;
  askApproval: boolean;
  askViaTelegram: boolean;
}

type Req =
  | { kind: "mcp_status" }
  | { kind: "mcp_set"; enabled?: boolean; port?: number; askApproval?: boolean; askViaTelegram?: boolean }
  | { kind: "mcp_regenerate" };

const when = (ms: number) => new Date(ms).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

// MCP 연동(#140): 켜기·포트·비밀(보기·복사·새로 만들기)·연결 상태와 MCP 클라이언트 설정 예시.
export function McpField() {
  const [st, setSt] = useState<Status | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 상태 조회는 늦게 온 옛 응답을 버린다(#127). 포트 칸은 상태와 편집 초안을 나눠, 10초 상태 조회가 고치는 중인 포트를 덮지 않는다.
  const statusGate = useLatestGate();
  const secretGate = useLatestGate();
  const portField = useSyncedDraft(st ? String(st.port) : "");
  const port = portField.value;

  const request = useCallback(
    async (msg: Req) => {
      const latest = statusGate();
      const quiet = msg.kind === "mcp_status";
      if (!quiet) setBusy(true);
      if (!quiet) setError(null);
      try {
        const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: Status; error?: string } | undefined;
        if (!res?.ok || !res.data) throw new Error(res?.error ?? "응답이 없습니다.");
        if (latest()) setSt(res.data);
      } catch (err) {
        if (latest() || !quiet) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [statusGate],
  );

  const showSecret = async () => {
    const latest = secretGate();
    const res = (await chrome.runtime.sendMessage({ kind: "mcp_secret" })) as { ok: boolean; data?: string; error?: string } | undefined;
    if (!latest()) return;
    if (res?.ok && typeof res.data === "string") setSecret(res.data);
    else setError(res?.error ?? "비밀을 읽지 못했습니다.");
  };

  useEffect(() => {
    void request({ kind: "mcp_status" });
    const t = setInterval(() => void request({ kind: "mcp_status" }), 10_000);
    // 다른 화면에서 비밀을 새로 만들면 보이던 비밀·설정 예시는 더 쓸 수 없다: 지우고 진행 중인 비밀 조회도 버린다.
    // 켜기·포트·묻기가 바뀌어도 상태를 다시 읽는다(작업·연결 기록만 바뀐 것은 10초 조회로).
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !("mcp" in changes)) return;
      const o = (changes.mcp.oldValue ?? {}) as Record<string, unknown>;
      const n = (changes.mcp.newValue ?? {}) as Record<string, unknown>;
      if (o.secret !== n.secret) {
        secretGate();
        setSecret(null);
      }
      if (o.secret !== n.secret || o.enabled !== n.enabled || o.port !== n.port || o.askApproval !== n.askApproval || o.askViaTelegram !== n.askViaTelegram) void request({ kind: "mcp_status" });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      clearInterval(t);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [request, secretGate]);

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
        Claude Code·Claude Desktop 같은 AI 도구가 이 도우미에게 브라우저 일을 시키고 최종 답을 받습니다. 새 탭에서 처리하고, 승인이 필요한 동작은 아래 "MCP 클라이언트에 묻기"를 켰을 때만 이동·클릭을 그 AI 도구에 묻습니다(끄면 하지 않음). 다리 프로그램(mcp/sbp-mcp.mjs, Node 22 이상 필요)을 그 AI 도구에 등록해야 합니다. 다리는 GitHub 릴리스의 설치용 ZIP에 들어 있습니다 — 웹 스토어로 설치했어도{" "}
        <a className="mcp-release-link" href={LATEST_RELEASE_URL} target="_blank" rel="noopener noreferrer">
          최신 릴리스
        </a>
        에서 ZIP을 받아 풀고 mcp 폴더의 파일을 씁니다. 답은 그 AI 도구로 가고, 그 도구가 자기 AI 서비스로 보낼 수 있습니다.
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
          <label className="check-row">
            <input type="checkbox" checked={st.askApproval} disabled={busy} onChange={(e) => void request({ kind: "mcp_set", askApproval: e.target.checked })} />
            <span>승인이 필요한 이동·클릭은 MCP 클라이언트에 묻기(대상·주소를 클라이언트로 보냄)</span>
          </label>
          <span className="field-hint">
            켜면 승인을 MCP 클라이언트 프로그램에 맡깁니다. 클라이언트가 질문 창(elicitation)을 사람에게 보여 주지 않고 자동으로 답하게 만들어져 있으면 사람이 확인하지 않은 채 실행될 수 있습니다. 직접 쓰는 클라이언트(Claude Code·Claude Desktop 등)에서만 켜세요. 클라이언트가 질문 창을 지원하지 않으면 지금처럼 하지 않습니다.
          </span>
          <label className="check-row">
            <input
              type="checkbox"
              className="mcp-ask-telegram"
              checked={st.askViaTelegram}
              disabled={busy}
              onChange={(e) => void request({ kind: "mcp_set", askViaTelegram: e.target.checked })}
            />
            <span>MCP 클라이언트가 묻지 못하면 텔레그램으로 묻기</span>
          </label>
          <span className="field-hint">
            텔레그램 연동이 연결돼 있고 "텔레그램으로 묻기"가 켜져 있어야 합니다. 질문에는 "[MCP 요청]"과 요청 글 앞부분(120자), 할 동작(대상·주소·입력할 값)이 실려 텔레그램 서버를 거쳐 갑니다. 텔레그램 요청을 처리하는 중이거나 다른 질문이 열려 있으면 묻지 않고 하지 않습니다.
          </span>
          <div className="key-row">
            <input value={port} inputMode="numeric" onChange={(e) => portField.set(e.target.value.replace(/\D/g, ""))} aria-label="포트" />
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || Number(port) === st.port}
              onClick={() => {
                portField.commit();
                void request({ kind: "mcp_set", port: Number(port) });
              }}
            >
              포트 저장
            </button>
          </div>
          {portField.conflict && (
            <span className="field-help error-text">
              다른 곳에서 포트가 바뀌었습니다(지금 {st.port}). 저장하면 이 칸의 포트로 덮어씁니다.{" "}
              <button type="button" className="link-btn" onClick={portField.reset}>
                되돌리기
              </button>
            </span>
          )}
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
                secretGate();
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
