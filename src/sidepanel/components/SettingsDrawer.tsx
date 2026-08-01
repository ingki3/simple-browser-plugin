import { useEffect, useState } from "react";
import { MODEL_IDS, MODEL_LABELS } from "@/lib/models";
import {
  DEFAULT_MAX_TOOL_HOPS,
  MAX_MAX_TOOL_HOPS,
  MIN_MAX_TOOL_HOPS,
} from "@/lib/messages";
import { useSettings } from "../hooks/useSettings";
import { KO } from "../i18n/ko";

interface Props {
  open: boolean;
  onClose: () => void;
}

const clampHops = (n: number) =>
  Math.min(
    MAX_MAX_TOOL_HOPS,
    Math.max(MIN_MAX_TOOL_HOPS, Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_TOOL_HOPS),
  );

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  clientId: string;
}

export function SettingsDrawer({ open, onClose }: Props) {
  const { settings, loaded, save } = useSettings();
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [googleBusy, setGoogleBusy] = useState<"connect" | "disconnect" | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [diag, setDiag] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  useEffect(() => {
    if (loaded) setDraft(settings);
  }, [loaded, settings]);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const refreshGoogleStatus = async () => {
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "google_status" })) as {
        ok: boolean;
        data?: GoogleStatus;
      };
      if (res?.ok && res.data) setGoogleStatus(res.data);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (open) refreshGoogleStatus();
  }, [open]);

  const connectGoogle = async () => {
    setGoogleBusy("connect");
    setGoogleError(null);
    try {
      await save({ ...draft, maxToolHops: clampHops(draft.maxToolHops) });
      let res: { ok: boolean; error?: string } | undefined;
      try {
        res = (await chrome.runtime.sendMessage({ kind: "google_connect" })) as
          | { ok: boolean; error?: string }
          | undefined;
      } catch (sendErr) {
        throw new Error(
          `BG로 메시지를 보낼 수 없습니다: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}. 확장을 재설치해 보세요.`,
        );
      }
      if (!res) {
        throw new Error(
          "BG에서 응답이 없습니다. 서비스 워커 콘솔에서 에러를 확인해 주세요.",
        );
      }
      if (!res.ok) throw new Error(res.error ?? "알 수 없는 오류");
      await refreshGoogleStatus();
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : String(err));
    } finally {
      setGoogleBusy(null);
    }
  };

  const runDiag = async () => {
    setDiagBusy(true);
    setGoogleError(null);
    const panelSide: Record<string, unknown> = {
      panelChromeIdentity: typeof chrome.identity !== "undefined",
      panelRedirectUrl:
        typeof chrome.identity !== "undefined"
          ? (() => {
              try {
                return chrome.identity.getRedirectURL();
              } catch (e) {
                return `error: ${e instanceof Error ? e.message : String(e)}`;
              }
            })()
          : "(panel에서도 chrome.identity 없음)",
      panelChromeRuntimeId: chrome.runtime?.id ?? "(none)",
    };
    let bg: unknown = "(no response)";
    let bgError: string | null = null;
    try {
      const res = (await chrome.runtime.sendMessage({
        kind: "google_diag",
      })) as { ok: boolean; data?: unknown; error?: string } | undefined;
      if (!res) bgError = "BG 응답 없음 (서비스 워커 기동 실패 가능)";
      else if (!res.ok) bgError = res.error ?? "알 수 없는 BG 에러";
      else bg = res.data;
    } catch (err) {
      bgError = err instanceof Error ? err.message : String(err);
    }
    const out = JSON.stringify(
      { panel: panelSide, bg, bgError, capturedAt: new Date().toISOString() },
      null,
      2,
    );
    setDiag(out);
    setDiagBusy(false);
  };

  const copyDiag = async () => {
    if (!diag) return;
    try {
      await navigator.clipboard.writeText(diag);
    } catch {
      /* ignore */
    }
  };

  const disconnectGoogle = async () => {
    setGoogleBusy("disconnect");
    setGoogleError(null);
    try {
      await chrome.runtime.sendMessage({ kind: "google_disconnect" });
      await refreshGoogleStatus();
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : String(err));
    } finally {
      setGoogleBusy(null);
    }
  };

  if (!open) return null;

  // noop — hoisted above

  const handleSave = async () => {
    await save({ ...draft, maxToolHops: clampHops(draft.maxToolHops) });
    onClose();
  };

  const handleCancel = () => {
    setDraft(settings);
    onClose();
  };

  return (
    <div className="drawer-overlay" onClick={handleCancel}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>{KO.settingsTitle}</h2>
        </div>
        {googleError && (
          <div className="drawer-alert">
            <strong>Google 연결 실패</strong>
            <div>{googleError}</div>
          </div>
        )}
        <div className="drawer-body">
          <label className="field">
            <span className="field-label">{KO.apiKeyLabel}</span>
            <div className="key-row">
              <input
                type={showKey ? "text" : "password"}
                value={draft.openRouterApiKey}
                onChange={(e) =>
                  setDraft({ ...draft, openRouterApiKey: e.target.value })
                }
                placeholder="sk-or-v1-..."
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="ghost-btn" onClick={() => setShowKey((v) => !v)}>
                {showKey ? KO.apiKeyHide : KO.apiKeyShow}
              </button>
            </div>
            <span className="field-help">{KO.apiKeyHelp}</span>
          </label>

          <label className="field">
            <span className="field-label">{KO.modelLabel}</span>
            <input
              type="text"
              list="openrouter-models"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="provider/model"
              spellCheck={false}
            />
            <datalist id="openrouter-models">
              {MODEL_IDS.map((id) => (
                <option key={id} value={id} label={MODEL_LABELS[id]} />
              ))}
            </datalist>
            <span className="field-help">
              OpenRouter 모델 ID를 입력합니다. 모델은 tool calling을 지원해야 합니다.
            </span>
          </label>

          <label className="field">
            <span className="field-label">{KO.translationLangLabel}</span>
            <input
              type="text"
              value={draft.translationTargetLang}
              onChange={(e) =>
                setDraft({ ...draft, translationTargetLang: e.target.value })
              }
              placeholder="ko"
            />
          </label>

          <label className="field">
            <span className="field-label">{KO.downloadFolderLabel}</span>
            <input
              type="text"
              value={draft.downloadFolderPrefix}
              onChange={(e) =>
                setDraft({ ...draft, downloadFolderPrefix: e.target.value })
              }
              placeholder="simple-browser-plugin"
            />
          </label>

          <label className="field">
            <span className="field-label">{KO.maxToolHopsLabel}</span>
            <input
              type="number"
              min={MIN_MAX_TOOL_HOPS}
              max={MAX_MAX_TOOL_HOPS}
              step={1}
              value={draft.maxToolHops}
              onChange={(e) =>
                setDraft({ ...draft, maxToolHops: Number(e.target.value) })
              }
            />
            <span className="field-help">{KO.maxToolHopsHelp}</span>
          </label>

          <div className="field">
            <span className="field-label">Google Workspace (Sheets / Docs / Drive)</span>
            <div className="google-status-row">
              {googleStatus?.connected ? (
                <span className="tag-ok">● 연결됨</span>
              ) : googleStatus?.configured ? (
                <span className="tag-warn">● 연결 필요</span>
              ) : (
                <span className="tag-off">● manifest 설정 필요</span>
              )}
              <button
                type="button"
                className="ghost-btn"
                disabled={googleBusy !== null || !googleStatus?.configured}
                onClick={connectGoogle}
              >
                {googleBusy === "connect" ? "연결 중…" : "Google 연결"}
              </button>
              {googleStatus?.connected && (
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={googleBusy !== null}
                  onClick={disconnectGoogle}
                >
                  {googleBusy === "disconnect" ? "해제 중…" : "연결 해제"}
                </button>
              )}
              <button
                type="button"
                className="ghost-btn"
                disabled={diagBusy}
                onClick={runDiag}
              >
                {diagBusy ? "진단 중…" : "연결 진단"}
              </button>
            </div>
            {!googleStatus?.configured && (
              <div className="setup-card">
                <strong>OAuth 설정 4단계 (1회성)</strong>
                <ol>
                  <li><a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud 콘솔</a>에서 Sheets · Docs · Drive API 활성화</li>
                  <li>"OAuth 동의 화면" 구성 → 본인 이메일을 테스터 등록</li>
                  <li>"사용자 인증 정보" → "OAuth 클라이언트 ID" 생성<br />
                    → 유형 <strong>"Chrome 확장 프로그램"</strong><br />
                    → Application ID: <code className="copy-hint">이 확장의 ID</code> (chrome://extensions에서 복사)</li>
                  <li>발급된 client_id를 <code>manifest.config.ts</code>의 <code>GOOGLE_OAUTH_CLIENT_ID</code>에 붙여넣기 → <code>npm run build</code> → 확장 재설치</li>
                </ol>
                <p className="setup-note">redirect URI 등록은 필요 없습니다 (Chrome이 내부 처리).</p>
              </div>
            )}
            {googleError && <span className="field-error">{googleError}</span>}
            {diag && (
              <div className="diag-box">
                <div className="diag-header">
                  <span>진단 결과</span>
                  <div className="diag-actions">
                    <button type="button" className="ghost-btn" onClick={copyDiag}>
                      복사
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => setDiag(null)}
                    >
                      닫기
                    </button>
                  </div>
                </div>
                <pre className="diag-body">{diag}</pre>
              </div>
            )}
          </div>
        </div>
        <div className="drawer-footer">
          <button type="button" className="ghost-btn" onClick={handleCancel}>
            {KO.cancel}
          </button>
          <button type="button" className="primary" onClick={handleSave}>
            {KO.save}
          </button>
        </div>
      </div>
    </div>
  );
}
