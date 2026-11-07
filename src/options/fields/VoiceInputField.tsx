import { useEffect, useState } from "react";
import { FieldHelp } from "./FieldHelp";
import { useSyncedDraft } from "../../sidepanel/hooks/syncHelpers";
import type { Settings, SettingsPatch } from "@/lib/messages";
import {
  VOICE_DEFAULT_MODELS,
  VOICE_LABELS,
  VOICE_LANGUAGES,
  VOICE_MODEL_MAX,
  isVoiceProvider,
  normalizeVoiceModel,
  voiceModelOf,
  type VoiceChoice,
  type VoiceProvider,
} from "@/lib/voice";

interface Props {
  // 화면의 설정(저장 중·보내지 않은 변경 포함)과 저장소의 확정 값(모델 칸이 다른 곳의 변경을 따라가는 데 씀, #127).
  settings: Settings;
  stored: Settings;
  // 바꾼 하위 필드만 보낸다(SettingsPatch.voiceInput).
  onPatch: (patch: SettingsPatch, delay?: number) => void;
}

const CHOICES: VoiceChoice[] = ["off", "openrouter", "openai", "gemini", "anthropic"];

function keyOf(s: Settings, p: VoiceProvider): string {
  return p === "openrouter" ? s.openRouterApiKey : (s.apiKeys[p] ?? "");
}

// 음성 입력(#184): 음성을 글자로 바꿀 전용 모델. 제공자·제공자별 모델·언어, 그 제공자 키가 없으면 키 입력.
export function VoiceInputField({ settings, stored, onPatch }: Props) {
  const v = settings.voiceInput;
  const provider = v.provider;
  const modelField = useSyncedDraft(isVoiceProvider(provider) ? (stored.voiceInput.models[provider] ?? "") : "", provider);
  const [keyDraft, setKeyDraft] = useState("");
  useEffect(() => setKeyDraft(""), [provider]);
  const needsKey = isVoiceProvider(provider) && !keyOf(settings, provider);

  return (
    <div className="field">
      <span className="field-label">음성 입력</span>
      <select
        value={provider}
        onChange={(e) => {
          const next = e.target.value;
          if (next === "off" || isVoiceProvider(next)) onPatch({ voiceInput: { provider: next } });
        }}
        aria-label="음성 입력 제공자"
      >
        {CHOICES.map((c) => (
          <option key={c} value={c} disabled={c === "anthropic"}>
            {c === "anthropic" ? `${VOICE_LABELS[c]} — API가 음성 입력을 지원하지 않음` : VOICE_LABELS[c]}
          </option>
        ))}
      </select>
      {isVoiceProvider(provider) && (
        <>
          <label className="field-sub">
            <span className="field-help">모델</span>
            <input
              value={modelField.value}
              placeholder={VOICE_DEFAULT_MODELS[provider]}
              maxLength={VOICE_MODEL_MAX}
              onChange={(e) => {
                const text = e.target.value;
                modelField.set(text);
                // 저장되면 정리한 값(잘못된 글자면 비움)으로 돌아온다 — 그 값은 내 저장으로 보고 입력 중인 글자를 그대로 둔다.
                modelField.expect(normalizeVoiceModel(text) ?? "");
                onPatch({ voiceInput: { models: { [provider]: text } } }, 600);
              }}
              aria-label="음성 입력 모델"
            />
          </label>
          {modelField.conflict && (
            <span className="field-help error-text voice-model-conflict">
              다른 곳에서 모델이 바뀌었습니다. 이 칸을 다시 고치면 이 칸의 모델로 저장합니다.{" "}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  // 아직 보내지 않은 이 칸의 저장도 저장된 값으로 덮는다(되돌린 초안이 나중에 저장되지 않게).
                  modelField.reset();
                  onPatch({ voiceInput: { models: { [provider]: stored.voiceInput.models[provider] ?? "" } } });
                }}
              >
                저장된 모델로 되돌리기
              </button>
            </span>
          )}
          {/* 입력란은 저장 전 글자일 수 있어 실제로 쓰는 모델(저장된 값, 잘못된 글자면 기본값)을 따로 보인다. */}
          <span className="field-help">지금 쓰는 모델: {voiceModelOf(v, provider)}</span>
          <label className="field-sub">
            <span className="field-help">언어</span>
            <select value={v.language} onChange={(e) => onPatch({ voiceInput: { language: e.target.value } })} aria-label="음성 입력 언어">
              {VOICE_LANGUAGES.map(([code, name]) => (
                <option key={code || "auto"} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={v.autoSend} onChange={(e) => onPatch({ voiceInput: { autoSend: e.target.checked } })} />
            <span>받아쓴 뒤 바로 보내기(끄면 입력창에만 넣고 직접 보냄)</span>
          </label>
          {needsKey && (
            <div className="key-row">
              <input
                type="password"
                value={keyDraft}
                placeholder={`${VOICE_LABELS[provider]} API 키`}
                onChange={(e) => setKeyDraft(e.target.value)}
                aria-label="음성 입력 API 키"
              />
              <button
                type="button"
                className="ghost-btn"
                disabled={!keyDraft.trim()}
                onClick={() => {
                  const k = keyDraft.trim();
                  onPatch(provider === "openrouter" ? { openRouterApiKey: k } : { apiKeys: { [provider]: k } });
                  setKeyDraft("");
                }}
              >
                저장
              </button>
            </div>
          )}
          {needsKey && <span className="field-help error-text">{VOICE_LABELS[provider]} 키가 없어 음성 입력을 쓸 수 없습니다.</span>}
        </>
      )}
      <FieldHelp summary="입력창의 🎤로 말하면 글자로 바꿔 바로 보냅니다(끄면 입력창에만).">
        녹음한 음성은 여기서 고른 제공자로만 보냅니다(대화 제공자와 달라도 됨). 녹음은 버튼을 누른 동안만 하고(최대 60초, 말이 끝나고
        조용하면 멈춤), 녹음 데이터는 저장하지 않습니다. 쓴 만큼 그 서비스에 요금이 나갑니다. 키는 그 제공자의 대화용 키와 같은 자리에
        저장됩니다. Claude API는 음성 입력을 받지 않아 고를 수 없습니다. 바로 보내기를 켜 두면 잘못 알아들은 글도 그대로 요청이 되니,
        보내기 전에 확인하려면 끄세요(응답 중이거나 글자가 잘렸으면 켜져 있어도 입력창에만 넣습니다).
      </FieldHelp>
    </div>
  );
}
