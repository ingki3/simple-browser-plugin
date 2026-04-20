import { useEffect, useState } from "react";
import { MODEL_IDS, MODEL_LABELS, type ModelId } from "@/lib/models";
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
  expiresAt: number | null;
  clientId: string;
}

export function SettingsDrawer({ open, onClose }: Props) {
  const { settings, loaded, save } = useSettings();
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [googleBusy, setGoogleBusy] = useState<"connect" | "disconnect" | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);

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
      const res = (await chrome.runtime.sendMessage({ kind: "google_connect" })) as {
        ok: boolean;
        error?: string;
      };
      if (!res?.ok) throw new Error(res?.error ?? "알 수 없는 오류");
      await refreshGoogleStatus();
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : String(err));
    } finally {
      setGoogleBusy(null);
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
        <div className="drawer-body">
          <label className="field">
            <span className="field-label">{KO.apiKeyLabel}</span>
            <div className="key-row">
              <input
                type={showKey ? "text" : "password"}
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                placeholder="AIza..."
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
            <select
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value as ModelId })}
            >
              {MODEL_IDS.map((id) => (
                <option key={id} value={id}>
                  {MODEL_LABELS[id]}
                </option>
              ))}
            </select>
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
            <input
              type="text"
              value={draft.googleClientId}
              onChange={(e) => setDraft({ ...draft, googleClientId: e.target.value })}
              placeholder="xxxxx.apps.googleusercontent.com"
              autoComplete="off"
              spellCheck={false}
            />
            <span className="field-help">
              Google Cloud 콘솔에서 OAuth 2.0 클라이언트 ID (웹 애플리케이션)를 만들고, 승인된 리디렉션 URI에
              <code> https://&lt;확장 ID&gt;.chromiumapp.org/</code> 를 추가한 뒤 여기에 client_id만 붙여넣으세요.
              Sheets·Docs·Drive API를 활성화해야 합니다.
            </span>
            <div className="google-status-row">
              {googleStatus?.connected ? (
                <span className="tag-ok">● 연결됨</span>
              ) : googleStatus?.configured ? (
                <span className="tag-warn">● 연결 필요</span>
              ) : (
                <span className="tag-off">● 미설정</span>
              )}
              <button
                type="button"
                className="ghost-btn"
                disabled={googleBusy !== null || !draft.googleClientId.trim()}
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
            </div>
            {googleError && <span className="field-error">{googleError}</span>}
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
