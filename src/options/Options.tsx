import { useEffect, useState } from "react";
import {
  DEFAULT_MODEL,
  MODEL_IDS,
  MODEL_LABELS,
  agentReasoningConfig,
  normalizeModelId,
} from "@/lib/models";
import {
  DEFAULT_MAX_TOOL_HOPS,
  MAX_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MIN_MAX_TOOL_HOPS,
  SETTINGS_KEY,
  type Settings,
} from "@/lib/messages";

const DEFAULTS: Settings = {
  openRouterApiKey: "",
  model: DEFAULT_MODEL,
  systemPrompt: "",
  translationTargetLang: "ko",
  downloadFolderPrefix: "simple-browser-plugin",
  maxToolHops: DEFAULT_MAX_TOOL_HOPS,
};

export function Options() {
  const [draft, setDraft] = useState<Settings>(DEFAULTS);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    chrome.storage.local.get(SETTINGS_KEY).then((obj) => {
      const raw = (obj[SETTINGS_KEY] ?? {}) as Partial<Settings>;
      setDraft({
        openRouterApiKey: raw.openRouterApiKey ?? DEFAULTS.openRouterApiKey,
        model: normalizeModelId(raw.model),
        systemPrompt:
          typeof raw.systemPrompt === "string"
            ? raw.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH)
            : DEFAULTS.systemPrompt,
        translationTargetLang: raw.translationTargetLang ?? DEFAULTS.translationTargetLang,
        downloadFolderPrefix: raw.downloadFolderPrefix ?? DEFAULTS.downloadFolderPrefix,
        maxToolHops:
          typeof raw.maxToolHops === "number" && Number.isFinite(raw.maxToolHops)
            ? Math.min(MAX_MAX_TOOL_HOPS, Math.max(MIN_MAX_TOOL_HOPS, Math.floor(raw.maxToolHops)))
            : DEFAULTS.maxToolHops,
      });
    });
  }, []);

  const save = async () => {
    const normalized: Settings = {
      ...draft,
      systemPrompt: draft.systemPrompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH),
      maxToolHops: Math.min(
        MAX_MAX_TOOL_HOPS,
        Math.max(
          MIN_MAX_TOOL_HOPS,
          Number.isFinite(draft.maxToolHops) ? Math.floor(draft.maxToolHops) : DEFAULT_MAX_TOOL_HOPS,
        ),
      ),
    };
    setDraft(normalized);
    await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
    await chrome.runtime.sendMessage({ kind: "settings_updated" }).catch(() => {
      /* ignore */
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${draft.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: draft.model,
          messages: [{ role: "user", content: "hi" }],
          reasoning: agentReasoningConfig(draft.model),
          max_tokens: 5,
        }),
      });
      if (res.ok) {
        setTestResult({ ok: true, msg: "연결 확인됨" });
      } else {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setTestResult({
          ok: false,
          msg: body?.error?.message ?? `OpenRouter HTTP ${res.status}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, msg });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="options">
      <h1>간편 도우미 설정</h1>
      <p className="intro">
        OpenRouter API 키와 모델을 설정합니다. API 키는 이 기기의 chrome.storage.local에 평문으로
        저장되며, 외부로 전송되지 않습니다.
      </p>

      <label className="field">
        <span className="field-label">OpenRouter API 키</span>
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
            {showKey ? "숨김" : "표시"}
          </button>
        </div>
        <span className="field-help">
          키는 openrouter.ai/keys에서 발급할 수 있습니다.
        </span>
      </label>

      <label className="field">
        <span className="field-label">모델</span>
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
          OpenRouter 모델 ID를 입력합니다. 에이전트 기능에는 tool calling 지원 모델이 필요합니다.
        </span>
      </label>

      <label className="field">
        <span className="field-label">기본 시스템 지침</span>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
          placeholder="예: 모든 출력은 한글로 작성해줘."
          maxLength={MAX_SYSTEM_PROMPT_LENGTH}
          rows={5}
        />
        <span className="field-help">
          모든 대화에 적용됩니다. 내부 안전 규칙과 도구 사용 규칙은 변경하지 않습니다.
        </span>
      </label>

      <label className="field">
        <span className="field-label">번역 대상 언어 (BCP-47)</span>
        <input
          type="text"
          value={draft.translationTargetLang}
          onChange={(e) => setDraft({ ...draft, translationTargetLang: e.target.value })}
          placeholder="ko"
        />
        <span className="field-help">예: ko, en, ja</span>
      </label>

      <label className="field">
        <span className="field-label">다운로드 폴더 접두사</span>
        <input
          type="text"
          value={draft.downloadFolderPrefix}
          onChange={(e) => setDraft({ ...draft, downloadFolderPrefix: e.target.value })}
          placeholder="simple-browser-plugin"
        />
        <span className="field-help">
          Chrome 기본 다운로드 폴더 안에 이 이름으로 하위 폴더가 만들어집니다.
        </span>
      </label>

      <label className="field">
        <span className="field-label">도구 호출 순환 한도</span>
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
        <span className="field-help">
          한 요청에서 에이전트가 도구를 연속 호출할 수 있는 최대 횟수 (1~30, 기본 8).
        </span>
      </label>

      <div className="actions">
        <button className="primary" onClick={save}>
          저장
        </button>
        <button
          className="ghost-btn"
          onClick={testKey}
          disabled={testing || !draft.openRouterApiKey || !draft.model}
        >
          {testing ? "확인 중…" : "연결 테스트"}
        </button>
        {saved && <span className="saved-indicator">✓ 저장됨</span>}
        {testResult && (
          <span className={`test-result ${testResult.ok ? "ok" : "err"}`}>
            {testResult.ok ? "✓" : "✕"} {testResult.msg}
          </span>
        )}
      </div>
    </div>
  );
}
