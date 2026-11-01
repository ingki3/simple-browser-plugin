import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOICE_INPUT,
  OPENAI_TRANSCRIBE_URL,
  OPENROUTER_TRANSCRIBE_URL,
  VOICE_DEFAULT_MODELS,
  VOICE_MAX_BYTES,
  VOICE_TEXT_MAX,
  base64ToBytes,
  buildVoiceRequest,
  bytesToBase64,
  encodeWav,
  finishVoiceText,
  mergeVoiceInput,
  mergeVoicePatch,
  normalizeVoiceInput,
  normalizeVoiceModel,
  parseVoiceResponse,
  sameTarget,
  voiceErrorMessage,
  voiceModelOf,
  wavSeconds,
} from "../src/lib/voice.ts";

test("normalizeVoiceInput: 기본 꺼짐, anthropic·알 수 없는 값은 off, 모델·언어 구조 검사", () => {
  assert.deepEqual(normalizeVoiceInput(undefined), DEFAULT_VOICE_INPUT);
  assert.equal(normalizeVoiceInput({ provider: "anthropic" }).provider, "off");
  assert.equal(normalizeVoiceInput({ provider: "x" }).provider, "off");
  assert.equal(normalizeVoiceInput({ provider: "gemini" }).provider, "gemini");
  const v = normalizeVoiceInput({ provider: "openai", models: { openai: " whisper-1 ", gemini: "bad model", openrouter: "../x" }, language: "en" });
  assert.deepEqual(v.models, { openai: "whisper-1" }, "잘못된 모델 문자열은 버린다");
  assert.equal(v.language, "en");
  assert.equal(normalizeVoiceInput({ language: "kor" }).language, "ko");
  assert.equal(normalizeVoiceInput({ language: "" }).language, "");
  assert.equal(normalizeVoiceInput({}).autoSend, true, "바로 보내기 기본 켜짐");
  assert.equal(normalizeVoiceInput({ autoSend: false }).autoSend, false);
  assert.equal(normalizeVoiceInput({ autoSend: "no" }).autoSend, true);
  assert.equal(normalizeVoiceModel("a".repeat(101)), null);
  assert.equal(normalizeVoiceModel("openai/gpt-4o-transcribe"), "openai/gpt-4o-transcribe");
  assert.equal(normalizeVoiceModel("models/x?key=1"), null);
});

test("mergeVoiceInput: 바꾼 하위 필드만, 모델은 제공자별로, 빈 모델은 지움", () => {
  const base = normalizeVoiceInput({ provider: "openai", models: { openai: "whisper-1", gemini: "g-1" }, language: "ko" });
  assert.deepEqual(mergeVoiceInput(base, { language: "en" }), { ...base, language: "en" });
  assert.deepEqual(mergeVoiceInput(base, { models: { gemini: "g-2" } }).models, { openai: "whisper-1", gemini: "g-2" });
  assert.deepEqual(mergeVoiceInput(base, { models: { openai: "" } }).models, { gemini: "g-1" });
  assert.equal(mergeVoiceInput(base, { provider: "gemini" }).models.openai, "whisper-1", "제공자를 바꿔도 다른 제공자 모델 유지");
  assert.equal(voiceModelOf(mergeVoiceInput(base, { provider: "openrouter" }), "openrouter"), VOICE_DEFAULT_MODELS.openrouter);
  assert.deepEqual(mergeVoicePatch({ models: { openai: "a" } }, { models: { gemini: "b" }, language: "en" }), { models: { openai: "a", gemini: "b" }, language: "en" });
  assert.deepEqual(mergeVoicePatch(undefined, { provider: "off" }), { provider: "off" });
  assert.deepEqual(mergeVoiceInput(base, { models: "x" }), base, "모양이 틀린 models는 무시");
  assert.equal(mergeVoiceInput(base, { autoSend: false }).autoSend, false);
  assert.equal(mergeVoiceInput({ ...base, autoSend: false }, { language: "en" }).autoSend, false, "다른 하위 필드는 autoSend를 바꾸지 않음");
  assert.equal(mergeVoiceInput(base, { autoSend: "x" }).autoSend, base.autoSend);
  assert.deepEqual(mergeVoiceInput(base, "x"), base);
});

test("WAV: 만들고 머리글 검사, base64 왕복·상한", () => {
  const samples = new Float32Array(16000).map((_, i) => Math.sin(i / 10));
  const wav = encodeWav(samples, 16000);
  assert.equal(wav.length, 44 + 32000);
  assert.equal(wavSeconds(wav), 1);
  const b64 = bytesToBase64(wav);
  assert.deepEqual(base64ToBytes(b64), wav);
  const bad = wav.slice();
  bad[22] = 2;
  assert.equal(wavSeconds(bad), null, "스테레오 거부");
  assert.equal(wavSeconds(wav.slice(0, 100)), null, "길이 불일치");
  assert.equal(base64ToBytes("not base64!"), null);
  assert.equal(base64ToBytes(123), null);
  assert.equal(base64ToBytes(bytesToBase64(new Uint8Array(VOICE_MAX_BYTES + 1))), null, "디코딩 기준 상한");
  assert.ok(base64ToBytes(bytesToBase64(new Uint8Array(1000)), 1000));
  assert.equal(base64ToBytes(bytesToBase64(new Uint8Array(1001)), 1000), null);
});

test("buildVoiceRequest: 제공자별 주소·머리글·본문", async () => {
  const wav = encodeWav(new Float32Array(8000), 16000);
  const b64 = bytesToBase64(wav);
  const or = buildVoiceRequest({ provider: "openrouter", model: "openai/whisper-1", language: "ko" }, "k1", wav, b64);
  assert.equal(or.url, OPENROUTER_TRANSCRIBE_URL);
  assert.equal(or.headers.Authorization, "Bearer k1");
  assert.deepEqual(JSON.parse(or.body), { model: "openai/whisper-1", input_audio: { data: b64, format: "wav" }, language: "ko" });
  const auto = buildVoiceRequest({ provider: "openrouter", model: "m", language: "" }, "k", wav, b64);
  assert.equal("language" in JSON.parse(auto.body), false);
  const oa = buildVoiceRequest({ provider: "openai", model: "gpt-4o-mini-transcribe", language: "en" }, "k2", wav, b64);
  assert.equal(oa.url, OPENAI_TRANSCRIBE_URL);
  assert.equal(oa.headers.Authorization, "Bearer k2");
  assert.equal(oa.headers["Content-Type"], undefined, "multipart 경계는 fetch가 정한다");
  assert.equal(oa.body.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(oa.body.get("language"), "en");
  const file = oa.body.get("file");
  assert.equal(file.type, "audio/wav");
  assert.equal((await file.arrayBuffer()).byteLength, wav.length);
  const ge = buildVoiceRequest({ provider: "gemini", model: "gemini-3.6-flash", language: "ko" }, "k3", wav, b64);
  assert.equal(ge.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
  assert.equal(ge.headers["x-goog-api-key"], "k3");
  assert.ok(!ge.url.includes("k3"), "키는 주소에 넣지 않는다");
  const body = JSON.parse(ge.body);
  assert.equal(body.contents[0].parts[0].inline_data.mime_type, "audio/wav");
  assert.equal(body.contents[0].parts[0].inline_data.data, b64);
  assert.ok(body.contents[0].parts[1].text.includes("한국어"));
  assert.equal("generationConfig" in body, false);
});

test("parseVoiceResponse·finishVoiceText·voiceErrorMessage", () => {
  assert.equal(parseVoiceResponse("openai", { text: "안녕" }), "안녕");
  assert.equal(parseVoiceResponse("openrouter", { text: "x", usage: {} }), "x");
  assert.equal(parseVoiceResponse("openai", {}), null);
  assert.equal(parseVoiceResponse("gemini", { candidates: [{ content: { parts: [{ text: "생각", thought: true }, { text: "말한 " }, { text: "글" }] } }] }), "말한 글");
  assert.equal(parseVoiceResponse("gemini", { candidates: [] }), null);
  assert.equal(parseVoiceResponse("gemini", null), null);
  assert.deepEqual(finishVoiceText("  가나\r\n다 "), { text: "가나\n다", truncated: false });
  const long = finishVoiceText("x".repeat(VOICE_TEXT_MAX + 5));
  assert.equal(long.text.length, VOICE_TEXT_MAX);
  assert.equal(long.truncated, true);
  assert.equal(voiceErrorMessage(401, { error: { message: "Invalid key" } }), "음성 변환 실패(401): Invalid key");
  assert.equal(voiceErrorMessage(500, null), "음성 변환 실패(500)");
  assert.ok(voiceErrorMessage(400, { error: "x".repeat(500) }).length < 230);
});

test("sameTarget", () => {
  const a = { provider: "openai", model: "m", language: "ko" };
  assert.equal(sameTarget(a, { ...a }), true);
  assert.equal(sameTarget(a, { ...a, model: "n" }), false);
  assert.equal(sameTarget(a, { ...a, language: "en" }), false);
  assert.equal(sameTarget(a, { ...a, provider: "gemini" }), false);
});
