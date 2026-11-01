import { useEffect, useState } from "react";
import { FieldHelp } from "./FieldHelp";
import type { Settings, SettingsPatch } from "@/lib/messages";
import {
  VOICE_DEFAULT_MODELS,
  VOICE_LABELS,
  VOICE_LANGUAGES,
  VOICE_MODEL_MAX,
  isVoiceProvider,
  type VoiceChoice,
  type VoiceProvider,
} from "@/lib/voice";

interface Props {
  settings: Settings;
  // 바꾼 하위 필드만 보낸다(SettingsPatch.voiceInput).
  onPatch: (patch: SettingsPatch, delay?: number) => void;
}

const CHOICES: VoiceChoice[] = ["off", "openrouter", "openai", "gemini", "anthropic"];

function keyOf(s: Settings, p: VoiceProvider): string {
  return p === "openrouter" ? s.openRouterApiKey : (s.apiKeys[p] ?? "");
}

// 음성 입력(#184): 음성을 글자로 바꿀 전용 모델. 제공자·제공자별 모델·언어, 그 제공자 키가 없으면 키 입력.
export function VoiceInputField({ settings, onPatch }: Props) {
  const v = settings.voiceInput;
  const provider = v.provider;
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
              key={provider}
              defaultValue={v.models[provider] ?? ""}
              placeholder={VOICE_DEFAULT_MODELS[provider]}
              maxLength={VOICE_MODEL_MAX}
              onChange={(e) => onPatch({ voiceInput: { models: { [provider]: e.target.value } } }, 600)}
              aria-label="음성 입력 모델"
            />
          </label>
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
      <FieldHelp summary="입력창의 🎤로 말하면 글자로 바꿔 입력창에 넣습니다(자동으로 보내지 않음).">
        녹음한 음성은 여기서 고른 제공자로만 보냅니다(대화 제공자와 달라도 됨). 녹음은 버튼을 누른 동안만 하고(최대 60초, 말이 끝나고
        조용하면 멈춤), 녹음 데이터는 저장하지 않습니다. 쓴 만큼 그 서비스에 요금이 나갑니다. 키는 그 제공자의 대화용 키와 같은 자리에
        저장됩니다. Claude API는 음성 입력을 받지 않아 고를 수 없습니다.
      </FieldHelp>
    </div>
  );
}
