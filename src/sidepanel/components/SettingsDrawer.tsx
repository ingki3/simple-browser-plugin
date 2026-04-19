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

export function SettingsDrawer({ open, onClose }: Props) {
  const { settings, loaded, save } = useSettings();
  const [draft, setDraft] = useState(settings);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (loaded) setDraft(settings);
  }, [loaded, settings]);

  // When drawer opens, reset draft to current saved settings so a previous
  // unsaved change doesn't leak across open/close cycles.
  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  if (!open) return null;

  const clampHops = (n: number) =>
    Math.min(
      MAX_MAX_TOOL_HOPS,
      Math.max(MIN_MAX_TOOL_HOPS, Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_TOOL_HOPS),
    );

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
