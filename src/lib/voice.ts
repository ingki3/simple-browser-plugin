// 음성 입력(#184): 패널에서 녹음한 음성을 사용자가 설정에서 고른 전용 모델로 글자로 바꾼다. 바뀐 글자는 입력창에만 넣고
// 자동으로 보내지 않는다. 이 모듈은 설정 정리·제공자별 요청 만들기·응답 읽기·WAV 만들기(순수 함수)만 둔다.
// 녹음은 패널(useVoiceInput), 전송은 백그라운드(background/voice.ts)가 한다.

export type VoiceProvider = "openrouter" | "openai" | "gemini";
// 화면에 보이는 선택지. anthropic은 API가 음성 입력을 받지 않아 고를 수 없게 보인다(저장되지 않음).
export type VoiceChoice = "off" | VoiceProvider | "anthropic";

export const VOICE_PROVIDERS: readonly VoiceProvider[] = ["openrouter", "openai", "gemini"];

export interface VoiceInputSettings {
  // 꺼짐이 기본: 음성을 어느 서버로 보낼지 사용자가 고르기 전에는 녹음·전송하지 않는다.
  provider: "off" | VoiceProvider;
  // 제공자별 모델(비우면 기본값). 제공자를 바꿔도 다른 제공자의 모델 문자열이 섞이지 않게 따로 둔다.
  models: Partial<Record<VoiceProvider, string>>;
  // ISO-639-1 두 글자. 빈 값은 자동 감지.
  language: string;
}

// 바꾼 하위 필드만 보내는 patch(저장 대기 중 연속 편집·다른 패널의 다른 하위 필드 변경을 통째로 덮지 않게).
export interface VoiceInputPatch {
  provider?: "off" | VoiceProvider;
  models?: Partial<Record<VoiceProvider, string>>;
  language?: string;
}

export const DEFAULT_VOICE_INPUT: VoiceInputSettings = { provider: "off", models: {}, language: "ko" };

export const VOICE_DEFAULT_MODELS: Record<VoiceProvider, string> = {
  openrouter: "openai/gpt-4o-transcribe",
  openai: "gpt-4o-mini-transcribe",
  gemini: "gemini-3.6-flash",
};

export const VOICE_LABELS: Record<VoiceChoice, string> = {
  off: "끄기",
  openrouter: "OpenRouter",
  openai: "ChatGPT(OpenAI)",
  gemini: "Gemini",
  anthropic: "Claude",
};

export const VOICE_LANGUAGES: ReadonlyArray<readonly [string, string]> = [
  ["ko", "한국어"],
  ["en", "영어"],
  ["ja", "일본어"],
  ["zh", "중국어"],
  ["", "자동 감지"],
];

export const VOICE_MODEL_MAX = 100;
// 녹음 길이·크기 상한. 16kHz 모노 16bit WAV 60초 ≈ 1.92MB.
export const VOICE_MAX_SECONDS = 60;
export const VOICE_MIN_SECONDS = 0.5;
export const VOICE_SAMPLE_RATE = 16_000;
export const VOICE_MAX_BYTES = 4 * 1024 * 1024;
export const VOICE_TEXT_MAX = 2000;
export const VOICE_TIMEOUT_MS = 30_000;

// 모델 ID는 주소 경로(Gemini)·요청 본문에 들어가므로 구조로만 검사한다(영숫자와 / . _ : -, 100자).
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9/._:-]{0,99}$/;

export function isVoiceProvider(v: unknown): v is VoiceProvider {
  return typeof v === "string" && (VOICE_PROVIDERS as readonly string[]).includes(v);
}

export function normalizeVoiceModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return MODEL_RE.test(t) ? t : null;
}

function normalizeLanguage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v === "" || /^[a-z]{2}$/.test(v) ? v : null;
}

function normalizeModels(v: unknown): Partial<Record<VoiceProvider, string>> {
  const out: Partial<Record<VoiceProvider, string>> = {};
  if (!v || typeof v !== "object") return out;
  for (const p of VOICE_PROVIDERS) {
    const m = normalizeVoiceModel((v as Record<string, unknown>)[p]);
    if (m) out[p] = m;
  }
  return out;
}

// 저장소에서 읽은 값 정리. 알 수 없는 제공자·anthropic은 off(음성을 보내지 않음).
export function normalizeVoiceInput(raw: unknown): VoiceInputSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    provider: isVoiceProvider(r.provider) ? r.provider : "off",
    models: normalizeModels(r.models),
    language: normalizeLanguage(r.language) ?? DEFAULT_VOICE_INPUT.language,
  };
}

// 바꾼 하위 필드만 합친다(models는 제공자별로 한 단계 더). 빈 모델 문자열은 그 제공자의 모델을 지운다(기본값으로).
export function mergeVoiceInput(base: VoiceInputSettings, patch: VoiceInputPatch | undefined): VoiceInputSettings {
  // 패널이 보낸 값이라 모양을 믿지 않는다(객체가 아니면 무시).
  if (!patch || typeof patch !== "object") return base;
  const models = { ...base.models };
  const pm = patch.models && typeof patch.models === "object" ? patch.models : null;
  for (const p of VOICE_PROVIDERS) {
    if (!pm || !Object.prototype.hasOwnProperty.call(pm, p)) continue;
    const m = normalizeVoiceModel(pm[p]);
    if (m) models[p] = m;
    else delete models[p];
  }
  return normalizeVoiceInput({
    provider: patch.provider ?? base.provider,
    models,
    language: patch.language ?? base.language,
  });
}

export function mergeVoicePatch(a: VoiceInputPatch | undefined, b: VoiceInputPatch | undefined): VoiceInputPatch | undefined {
  if (!a) return b;
  if (!b) return a;
  return { ...a, ...b, ...(a.models || b.models ? { models: { ...a.models, ...b.models } } : {}) };
}

export function voiceModelOf(v: VoiceInputSettings, p: VoiceProvider): string {
  return v.models[p] || VOICE_DEFAULT_MODELS[p];
}

// 녹음을 시작할 때 고정하는 전송 대상.
export interface VoiceTarget {
  provider: VoiceProvider;
  model: string;
  language: string;
}

export function sameTarget(a: VoiceTarget, b: VoiceTarget): boolean {
  return a.provider === b.provider && a.model === b.model && a.language === b.language;
}

// ── 제공자별 요청 ──

export const OPENROUTER_TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
export const GEMINI_GENERATE_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

const LANGUAGE_NAMES: Record<string, string> = { ko: "한국어", en: "영어", ja: "일본어", zh: "중국어" };

// Gemini에 주는 고정 지시(사용자 글자·페이지 글자를 섞지 않는다).
export function geminiInstruction(language: string): string {
  const lang = LANGUAGE_NAMES[language];
  return [
    "이 음성을 들리는 그대로 받아 적어라.",
    "받아 적은 글자만 출력하고, 설명·번역·따옴표·머리말을 붙이지 마라.",
    "음성에 말이 없으면 아무것도 출력하지 마라.",
    lang ? `언어: ${lang}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface VoiceRequest {
  url: string;
  headers: Record<string, string>;
  // JSON 본문(문자열) 또는 multipart(FormData — 백그라운드에서 만든다).
  body: string | FormData;
}

// wav: WAV 바이트. base64: 같은 바이트의 base64(패널이 보낸 그대로).
export function buildVoiceRequest(t: VoiceTarget, apiKey: string, wav: Uint8Array, base64: string): VoiceRequest {
  if (t.provider === "openrouter") {
    return {
      url: OPENROUTER_TRANSCRIBE_URL,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: t.model, input_audio: { data: base64, format: "wav" }, ...(t.language ? { language: t.language } : {}) }),
    };
  }
  if (t.provider === "openai") {
    const form = new FormData();
    form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio.wav");
    form.append("model", t.model);
    form.append("response_format", "json");
    if (t.language) form.append("language", t.language);
    return { url: OPENAI_TRANSCRIBE_URL, headers: { Authorization: `Bearer ${apiKey}` }, body: form };
  }
  return {
    url: `${GEMINI_GENERATE_BASE}${encodeURIComponent(t.model)}:generateContent`,
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: "audio/wav", data: base64 } }, { text: geminiInstruction(t.language) }] }],
    }),
  };
}

// 응답에서 받아쓴 글자. 형식이 맞지 않으면 null.
export function parseVoiceResponse(provider: VoiceProvider, json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (provider === "gemini") {
    const cands = j.candidates;
    if (!Array.isArray(cands) || !cands.length) return null;
    const parts = (cands[0] as { content?: { parts?: unknown } })?.content?.parts;
    if (!Array.isArray(parts)) return null;
    return parts
      .filter((p): p is { text: string; thought?: boolean } => !!p && typeof (p as { text?: unknown }).text === "string" && (p as { thought?: unknown }).thought !== true)
      .map((p) => p.text)
      .join("");
  }
  return typeof j.text === "string" ? j.text : null;
}

// 결과 정리: 앞뒤 공백, 상한(넘으면 자르고 알림).
export function finishVoiceText(text: string): { text: string; truncated: boolean } {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (t.length <= VOICE_TEXT_MAX) return { text: t, truncated: false };
  return { text: t.slice(0, VOICE_TEXT_MAX), truncated: true };
}

// 오류 응답에서 짧은 메시지(키·음성 데이터를 담지 않는 제공자 메시지만, 200자).
export function voiceErrorMessage(status: number, json: unknown): string {
  let msg = "";
  if (json && typeof json === "object") {
    const e = (json as { error?: unknown }).error;
    if (typeof e === "string") msg = e;
    else if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") msg = (e as { message: string }).message;
  }
  msg = msg.replace(/\s+/g, " ").trim().slice(0, 200);
  return `음성 변환 실패(${status})${msg ? `: ${msg}` : ""}`;
}

// ── WAV ──

// 모노 Float32 표본을 16bit PCM WAV로.
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

// WAV 머리글 검사(패널이 보낸 바이트가 우리가 만든 형식인지): RIFF/WAVE, PCM 모노 16bit, 길이 일치. 초 단위 길이를 돌려준다.
export function wavSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") return null;
  if (v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint16(34, true) !== 16) return null;
  const rate = v.getUint32(24, true);
  const data = v.getUint32(40, true);
  if (!rate || data + 44 !== bytes.length) return null;
  return data / 2 / rate;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

// base64 → 바이트. 형식이 틀리거나 상한을 넘으면 null(디코딩한 바이트 기준 상한).
export function base64ToBytes(b64: unknown, maxBytes = VOICE_MAX_BYTES): Uint8Array | null {
  if (typeof b64 !== "string" || !b64 || b64.length > Math.ceil((maxBytes * 4) / 3) + 4) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length > maxBytes) return null;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
