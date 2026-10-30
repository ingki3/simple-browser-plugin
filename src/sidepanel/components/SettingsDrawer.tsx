import { McpField } from "./McpField";
import { TelegramField } from "./TelegramField";
import { RepeatTasksField } from "./RepeatTasksField";
import { useEffect, useRef, useState } from "react";
import { ActionLogField } from "./ActionLogField";
import { RunModeField } from "./RunModeField";
import { RememberPagesField } from "./RememberPagesField";
import { HistoryPickField } from "./HistoryPickField";
import { TrustedInputField } from "./TrustedInputField";
import { ManualSitesField } from "./ManualSitesField";
import { LoginSitesField } from "./LoginSitesField";
import { ShowThinkingField } from "./ShowThinkingField";
import { QuickThinkingField } from "./QuickThinkingField";
import { CsvMaxCharsField } from "./CsvMaxCharsField";
import { MODEL_IDS, MODEL_LABELS } from "@/lib/models";
import { PROVIDER_LINKS } from "@/lib/providerLinks";
import { OPENAI_DEFAULT_MODEL, OPENAI_MODEL_SUGGESTIONS } from "@/lib/providers/openai";
import { GEMINI_DEFAULT_MODEL, GEMINI_MODEL_SUGGESTIONS } from "@/lib/providers/gemini";
import { ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_MODEL_SUGGESTIONS } from "@/lib/providers/anthropic";

// OpenRouter 밖에서 직접 연결하는 제공자의 설정 칸(#97).
const DIRECT_PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    keyPlaceholder: "sk-...",
    keyHelp: "platform.openai.com의 API 키.",
    defaultModel: OPENAI_DEFAULT_MODEL,
    suggestions: OPENAI_MODEL_SUGGESTIONS as readonly string[],
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    keyPlaceholder: "AIza...",
    keyHelp: "Google AI Studio(aistudio.google.com)의 API 키.",
    defaultModel: GEMINI_DEFAULT_MODEL,
    suggestions: GEMINI_MODEL_SUGGESTIONS as readonly string[],
  },
  anthropic: {
    id: "anthropic",
    label: "Claude",
    keyPlaceholder: "sk-ant-...",
    keyHelp: "Anthropic Console(console.anthropic.com)의 API 키.",
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    suggestions: ANTHROPIC_MODEL_SUGGESTIONS as readonly string[],
  },
} as const;
import {
  DEFAULT_MAX_TOOL_HOPS,
  MAX_MAX_TOOL_HOPS,
  MAX_SYSTEM_PROMPT_LENGTH,
  MIN_MAX_TOOL_HOPS,
  type Settings,
} from "@/lib/messages";
import { useSettings } from "../hooks/useSettings";
import { FieldHelp } from "./FieldHelp";
import { mergeSettingsPatch } from "@/lib/settings";

const SAVE_DELAY_MS = 600;
const CUSTOM_MODEL = "__custom__";
const CUSTOM_LANG = "__custom__";
// 번역할 언어 목록(#130). 값은 BCP-47 코드.
const TRANSLATION_LANGS: ReadonlyArray<readonly [string, string]> = [
  ["ko", "한국어"],
  ["en", "영어"],
  ["ja", "일본어"],
  ["zh-CN", "중국어(간체)"],
  ["zh-TW", "중국어(번체)"],
  ["es", "스페인어"],
  ["fr", "프랑스어"],
  ["de", "독일어"],
  ["vi", "베트남어"],
  ["th", "태국어"],
  ["id", "인도네시아어"],
  ["ru", "러시아어"],
  ["pt", "포르투갈어"],
];

// 두 patch를 합친다(제공자별 키·모델은 한 단계 더).
function mergePatch(a: Partial<Settings>, b: Partial<Settings>): Partial<Settings> {
  return {
    ...a,
    ...b,
    ...(a.apiKeys || b.apiKeys ? { apiKeys: { ...a.apiKeys, ...b.apiKeys } } : {}),
    ...(a.providerModels || b.providerModels ? { providerModels: { ...a.providerModels, ...b.providerModels } } : {}),
  };
}
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
  const { settings, loaded, savePatch } = useSettings();
  const [draft, setDraft] = useState(settings);
  const direct = draft.provider === "openrouter" ? null : DIRECT_PROVIDERS[draft.provider];
  const [showKey, setShowKey] = useState(false);
  // 바꾸면 바로 저장(#99): 고르는 항목은 곧바로, 글자 칸은 입력이 멈추면(SAVE_DELAY_MS) 저장한다. 닫을 때 남은 저장을 마친다.
  // API 키만 "저장" 버튼으로 확정한다(keyDraft).
  // 저장 상태: dirty(아직 보내지 않은 변경)와 inflight(저장 중인 변경). 저장은 한 번에 하나씩만 보낸다 — 실패한 옛 변경이
  // 나중 변경을 되돌리거나, 늦게 온 저장 알림이 최신 입력을 덮지 않게.
  const dirty = useRef<Partial<Settings>>({});
  const inflight = useRef<Partial<Settings> | null>(null);
  const timer = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  // 저장이 끝날 때마다 화면을 저장소의 확정 값(범위로 고친 값 포함)으로 다시 맞춘다.
  const [syncTick, setSyncTick] = useState(0);
  const [savedAt, setSavedAt] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedKey = direct ? (settings.apiKeys[direct.id] ?? "") : settings.openRouterApiKey;
  const [keyDraft, setKeyDraft] = useState(savedKey);
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [googleBusy, setGoogleBusy] = useState<"connect" | "disconnect" | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [diag, setDiag] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  // OpenRouter 모델을 목록 밖에서 직접 입력하는 중인지. 저장된 모델이 목록에 없으면 처음부터 입력 칸을 보인다.
  const [customModel, setCustomModel] = useState(false);
  useEffect(() => {
    if (loaded && !(MODEL_IDS as readonly string[]).includes(settings.model)) setCustomModel(true);
  }, [loaded, settings.model]);
  // 번역할 언어를 목록 밖에서 직접 입력하는 중인지. 저장된 값이 목록에 없으면 입력 칸을 보인다.
  const [customLang, setCustomLang] = useState(false);
  useEffect(() => {
    if (loaded && !TRANSLATION_LANGS.some(([code]) => code === settings.translationTargetLang)) setCustomLang(true);
  }, [loaded, settings.translationTargetLang]);
  // 연결 확인(#129): 저장한 키·모델로 짧은 요청 한 번.
  const [check, setCheck] = useState<{ state: "busy" | "ok" | "error"; text: string } | null>(null);

  // 저장소의 설정(다른 창·패널에서 바꾼 것 포함)을 따라가되, 이 서랍의 저장 중인 변경과 아직 보내지 않은 변경을 그 위에 둔다.
  useEffect(() => {
    if (loaded) setDraft(mergeSettingsPatch(mergeSettingsPatch(settings, inflight.current ?? {}), dirty.current));
  }, [loaded, settings, open, syncTick]);
  // 제공자를 바꾸거나 서랍을 열 때만 키 칸을 그 제공자의 저장된 키로(저장 알림이 입력 중인 키를 되돌리지 않게).
  const savedKeyRef = useRef(savedKey);
  savedKeyRef.current = savedKey;
  useEffect(() => {
    setKeyDraft(savedKeyRef.current);
  }, [draft.provider, open, loaded]);

  // "저장됨"은 잠깐만 보인다.
  useEffect(() => {
    if (!savedAt) return;
    const t = window.setTimeout(() => setSavedAt(0), 1500);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  // 보내지 않은 변경을 하나씩 차례로 저장한다(백그라운드가 바꾼 필드만 최신 설정에 합친다). 저장 중에 생긴 변경은 끝난 뒤 이어서.
  // 실패한 변경은 다시 넣지 않는다(옛 변경이 나중 선택을 되돌리지 않게) — 오류를 보이고 화면을 저장된 값으로 되돌린다.
  // 결과: 이번 저장들이 모두 성공했는지(방문 기록 찾기는 실패면 시작하지 않는다 — 화면과 다른 모델로 보내지 않게).
  const flush = (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (saving.current) return saving.current;
    const run = (async () => {
      let ok = true;
      while (Object.keys(dirty.current).length) {
        const patch = dirty.current;
        dirty.current = {};
        inflight.current = patch;
        try {
          await savePatch(patch.maxToolHops !== undefined ? { ...patch, maxToolHops: clampHops(patch.maxToolHops) } : patch);
          setSaveError(null);
          setSavedAt(Date.now());
        } catch (err) {
          ok = false;
          setSaveError(`${err instanceof Error ? err.message : String(err)} — 바뀌지 않은 값이 보입니다. 다시 바꿔 주세요.`);
        } finally {
          inflight.current = null;
          setSyncTick((t) => t + 1);
        }
      }
      return ok;
    })();
    saving.current = run.finally(() => {
      saving.current = null;
    });
    return saving.current;
  };
  // patch를 반영하고 저장한다. delay가 있으면 그동안 다음 변경을 모아 한 번에 저장한다.
  const update = (patch: Partial<Settings>, delay = 0) => {
    setDraft((cur) => mergeSettingsPatch(cur, patch));
    dirty.current = mergePatch(dirty.current, patch);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), delay);
  };
  // 패널이 닫히거나(Chrome의 패널 닫기) 숨겨지면 남은 변경을 기다리지 않고 바로 보낸다(문서가 사라지면 진행 중인 저장 뒤의
  // 이어 저장이 실행되지 않는다). 백그라운드가 받은 순서대로 합치므로 앞서 보낸 저장 뒤에 처리된다.
  useEffect(() => {
    const now = () => {
      window.clearTimeout(timer.current);
      const patch = dirty.current;
      if (!Object.keys(patch).length) return;
      dirty.current = {};
      // 닫히는 중이라 결과를 보일 수 없다. 실패하면 다음에 열 때 저장된 값이 보인다(옛 변경을 다시 넣지 않는다).
      void savePatch(patch.maxToolHops !== undefined ? { ...patch, maxToolHops: clampHops(patch.maxToolHops) } : patch).catch(() => {});
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") now();
    };
    window.addEventListener("pagehide", now);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", now);
      document.removeEventListener("visibilitychange", onHide);
    };
  });
  // 확인 중에 제공자·키·모델이 바뀌면 늦게 온 이전 응답은 버린다.
  const checkSeq = useRef(0);
  const checkConnection = async () => {
    const seq = ++checkSeq.current;
    setCheck({ state: "busy", text: "확인 중…" });
    const show = (next: { state: "ok" | "error"; text: string }) => {
      if (seq === checkSeq.current) setCheck(next);
    };
    try {
      // 입력이 멈추기를 기다리는 모델 변경도 먼저 저장해, 화면에 보이는 모델로 확인한다.
      await flush();
      const res = (await chrome.runtime.sendMessage({ kind: "check_connection" })) as
        | { ok: boolean; data?: { model: string }; error?: string }
        | undefined;
      if (res?.ok && res.data) show({ state: "ok", text: `✓ 연결됨 · ${res.data.model}` });
      else show({ state: "error", text: res?.error ?? "응답이 없습니다." });
    } catch (err) {
      show({ state: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };
  const checkedModel = draft.provider === "openrouter" ? draft.model : (draft.providerModels[draft.provider] ?? "");
  useEffect(() => {
    checkSeq.current++;
    setCheck(null);
  }, [draft.provider, savedKey, checkedModel]);

  const saveKey = () =>
    update(direct ? { apiKeys: { [direct.id]: keyDraft.trim() } } : { openRouterApiKey: keyDraft.trim() });

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
      await flush();
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
          "확장이 응답하지 않습니다. chrome://extensions에서 이 확장을 새로고침한 뒤 다시 시도해 주세요.",
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
      if (!res) bgError = "확장 응답 없음 (확장을 새로고침해 보세요)";
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

  const handleClose = async () => {
    await flush();
    onClose();
  };

  return (
    <div className="drawer-overlay" onClick={() => void handleClose()}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>{KO.settingsTitle}</h2>
          <span className="drawer-saved" aria-live="polite">
            {saveError ? `저장하지 못함: ${saveError}` : savedAt ? "저장됨" : ""}
          </span>
          <button type="button" className="ghost-btn" onClick={() => void handleClose()}>
            닫기
          </button>
        </div>
        {googleError && (
          <div className="drawer-alert">
            <strong>Google 연결 실패</strong>
            <div>{googleError}</div>
          </div>
        )}
        <div className="drawer-body">
          <p className="drawer-note">바꾸면 바로 저장됩니다. API 키만 저장 버튼을 누르세요.</p>
          <details className="settings-group" open>
            <summary>시작하기</summary>
            <label className="field">
              <span className="field-label">모델 제공자</span>
              <select value={draft.provider} onChange={(e) => update({ provider: e.target.value as Settings["provider"] })}>
                <option value="openrouter">OpenRouter (여러 회사 모델)</option>
                <option value="openai">OpenAI (ChatGPT API 키)</option>
                <option value="gemini">Google Gemini (AI Studio API 키)</option>
                <option value="anthropic">Anthropic Claude (Claude API 키)</option>
              </select>
              <FieldHelp summary="대화·페이지 내용은 고른 제공자로만 보냅니다.">
                제공자나 모델을 바꾸면 대화를 새로 시작하고, 진행 중인 페이지 번역도 멈춥니다.
              </FieldHelp>
            </label>

            <div className="field">
              <span className="field-label">{direct ? `${direct.label} API 키` : KO.apiKeyLabel}</span>
              <div className="key-row">
                <input
                  type={showKey ? "text" : "password"}
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={direct ? direct.keyPlaceholder : "sk-or-v1-..."}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className="ghost-btn" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? KO.apiKeyHide : KO.apiKeyShow}
                </button>
                <button type="button" className="primary" disabled={keyDraft.trim() === savedKey} onClick={saveKey}>
                  저장
                </button>
              </div>
              <FieldHelp summary={keyDraft.trim() !== savedKey ? "바꾼 키는 저장을 눌러야 적용됩니다." : direct ? direct.keyHelp : "openrouter.ai/keys에서 발급합니다."}>
                키는 이 브라우저(chrome.storage.local)에만 평문으로 저장되고, 그 제공자를 부를 때만 씁니다.
              </FieldHelp>
              <div className="provider-links">
                <a href={PROVIDER_LINKS[draft.provider].keyUrl} target="_blank" rel="noopener noreferrer">키 발급</a>
                <a href={PROVIDER_LINKS[draft.provider].pricingUrl} target="_blank" rel="noopener noreferrer">요금</a>
                <a href={PROVIDER_LINKS[draft.provider].usageUrl} target="_blank" rel="noopener noreferrer">사용량</a>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={!savedKey || keyDraft.trim() !== savedKey || check?.state === "busy"}
                  onClick={() => void checkConnection()}
                >
                  연결 확인
                </button>
              </div>
              {check && <span className={`field-help${check.state === "error" ? " error-text" : ""}`}>{check.text}</span>}
              <FieldHelp summary="API는 쓴 만큼 그 서비스에 요금이 나갑니다. 앱 구독과는 따로입니다.">
                요청마다 보낸 글자(대화·페이지 내용)와 받은 답의 양에 따라 요금이 정해집니다. 긴 페이지를 읽거나 단계가 많은 작업일수록
                많이 듭니다. 연결 확인은 아주 짧은 요청을 한 번 보냅니다. 키를 받은 곳에서 사용 한도를 정해 두면 안심하고 쓸 수 있습니다.
              </FieldHelp>
            </div>

            <label className="field">
              <span className="field-label">{KO.modelLabel}</span>
              {direct ? (
                <>
                  <input
                    type="text"
                    list={`${direct.id}-models`}
                    value={draft.providerModels[direct.id] ?? ""}
                    onChange={(e) => update({ providerModels: { [direct.id]: e.target.value } }, SAVE_DELAY_MS)}
                    placeholder={direct.defaultModel}
                    spellCheck={false}
                  />
                  <datalist id={`${direct.id}-models`}>
                    {direct.suggestions.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <FieldHelp summary={`비우면 기본(${direct.defaultModel})을 씁니다. 목록에서 고르거나 모델 ID를 입력하세요. 도구 호출을 지원해야 합니다.`} />
                </>
              ) : (
                <>
                  {/* 목록에서 고르고, 목록에 없는 모델만 ID를 직접 입력한다(#129). */}
                  <select
                    value={customModel ? CUSTOM_MODEL : draft.model}
                    onChange={(e) => {
                      if (e.target.value === CUSTOM_MODEL) setCustomModel(true);
                      else {
                        setCustomModel(false);
                        update({ model: e.target.value });
                      }
                    }}
                  >
                    {MODEL_IDS.map((id) => (
                      <option key={id} value={id}>
                        {MODEL_LABELS[id]}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL}>목록에 없는 모델 직접 입력…</option>
                  </select>
                  {customModel && (
                    <input
                      type="text"
                      value={draft.model}
                      onChange={(e) => update({ model: e.target.value }, SAVE_DELAY_MS)}
                      placeholder="provider/model (예: anthropic/claude-sonnet-5.5)"
                      spellCheck={false}
                    />
                  )}
                  <FieldHelp summary="잘 모르면 기본을 쓰세요. 직접 입력하는 모델은 도구 호출을 지원해야 합니다." />
                </>
              )}
            </label>
          </details>

          <details className="settings-group">
            <summary>동작</summary>
            <RunModeField mode={draft.runMode} onChange={(runMode) => update({ runMode })} />
            <QuickThinkingField enabled={draft.quickThinking} onToggle={(quickThinking) => update({ quickThinking })} />
            <ManualSitesField sites={draft.manualSites} onChange={(manualSites) => update({ manualSites })} currentTabButton />
            <TrustedInputField enabled={draft.trustedInput} onToggle={(trustedInput) => update({ trustedInput })} />
          </details>

          <details className="settings-group">
            <summary>반복 작업</summary>
            <RepeatTasksField />
          </details>

          <details className="settings-group">
            <summary>기억·기록</summary>
            <RememberPagesField enabled={draft.rememberPages} onToggle={(rememberPages) => update({ rememberPages })} />
            {draft.rememberPages && <HistoryPickField beforeStart={flush} onOpened={() => void handleClose()} />}
            <ActionLogField enabled={draft.actionLogEnabled} onToggle={(actionLogEnabled) => update({ actionLogEnabled })} />
          </details>

          <details className="settings-group">
            <summary>자동 로그인 (선택 · KeePassXC 필요)</summary>
            <LoginSitesField sites={draft.loginSites} onChange={(loginSites) => update({ loginSites })} />
          </details>

          <details className="settings-group">
            <summary>텔레그램 연동 (선택)</summary>
            <TelegramField />
          </details>

          <details className="settings-group">
            <summary>MCP 연동 (선택)</summary>
            <McpField />
          </details>

          <details className="settings-group">
            <summary>Google 연결 (선택 · 직접 빌드 필요)</summary>
            <div className="field">
              <span className="field-label">Google Workspace (Sheets / Docs / Drive)</span>
              <div className="google-status-row">
                {googleStatus?.connected ? (
                  <span className="tag-ok">● 연결됨</span>
                ) : googleStatus?.configured ? (
                  <span className="tag-warn">● 연결 필요</span>
                ) : (
                  <span className="tag-off">● 직접 빌드 필요</span>
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
                  <strong>선택 기능 · 직접 빌드한 경우만</strong>
                  <p className="setup-note">
                    기본 사용에는 필요 없습니다. 릴리스 ZIP에서는 꺼져 있고, 자기 Google Cloud 프로젝트로 직접 빌드해야 씁니다.{" "}
                    <a href="https://github.com/ingki3/simple-browser-plugin/blob/main/docs/install.md#google-연동선택-직접-빌드-필요" target="_blank" rel="noopener">
                      설치 안내
                    </a>
                  </p>
                  <ol>
                    <li><a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener">Google Cloud 콘솔</a>에서 Sheets · Docs · Drive API 활성화</li>
                    <li>"OAuth 동의 화면" 구성 → 본인 이메일을 테스터 등록</li>
                    <li>"사용자 인증 정보" → "OAuth 클라이언트 ID" 생성<br />
                      → 유형 <strong>"Chrome 확장 프로그램"</strong><br />
                      → Application ID: <code className="copy-hint">이 확장의 ID</code> (chrome://extensions에서 복사)</li>
                    <li>발급된 client_id로 <code>GOOGLE_OAUTH_CLIENT_ID=… npm run build</code> → 확장 새로고침</li>
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
          </details>

          <details className="settings-group">
            <summary>고급</summary>
            <label className="field">
              <span className="field-label">{KO.systemPromptLabel}</span>
              <textarea
                value={draft.systemPrompt}
                onChange={(e) => update({ systemPrompt: e.target.value }, SAVE_DELAY_MS)}
                placeholder="예: 모든 출력은 한글로 작성해줘."
                maxLength={MAX_SYSTEM_PROMPT_LENGTH}
                rows={5}
              />
              <FieldHelp summary={KO.systemPromptHelp} />
            </label>

            <label className="field">
              <span className="field-label">{KO.translationLangLabel}</span>
              {/* 목록에서 고르고, 목록에 없는 언어만 코드(BCP-47)로 직접 입력한다(#130). */}
              <select
                value={customLang ? CUSTOM_LANG : draft.translationTargetLang}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_LANG) setCustomLang(true);
                  else {
                    setCustomLang(false);
                    update({ translationTargetLang: e.target.value });
                  }
                }}
              >
                {TRANSLATION_LANGS.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
                <option value={CUSTOM_LANG}>다른 언어(코드 직접 입력)…</option>
              </select>
              {customLang && (
                <input
                  type="text"
                  value={draft.translationTargetLang}
                  onChange={(e) => update({ translationTargetLang: e.target.value }, SAVE_DELAY_MS)}
                  placeholder="언어 코드(예: nl, pl, ar)"
                />
              )}
            </label>

            <label className="field">
              <span className="field-label">{KO.downloadFolderLabel}</span>
              <input
                type="text"
                value={draft.downloadFolderPrefix}
                onChange={(e) => update({ downloadFolderPrefix: e.target.value }, SAVE_DELAY_MS)}
                placeholder="simple-browser-plugin"
              />
              <FieldHelp summary={KO.downloadFolderHelp} />
            </label>

            <label className="field">
              <span className="field-label">{KO.maxToolHopsLabel}</span>
              <input
                type="number"
                min={MIN_MAX_TOOL_HOPS}
                max={MAX_MAX_TOOL_HOPS}
                step={1}
                value={draft.maxToolHops}
                onChange={(e) => update({ maxToolHops: clampHops(Number(e.target.value)) }, SAVE_DELAY_MS)}
              />
              <FieldHelp summary={KO.maxToolHopsHelp} />
            </label>

            <CsvMaxCharsField value={draft.csvMaxChars} onChange={(csvMaxChars) => update({ csvMaxChars }, SAVE_DELAY_MS)} />
            <ShowThinkingField enabled={draft.showThinking} onToggle={(showThinking) => update({ showThinking })} />
          </details>
        </div>
      </div>
    </div>
  );
}
