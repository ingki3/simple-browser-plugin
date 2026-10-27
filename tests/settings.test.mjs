import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CSV_MAX_CHARS,
  MAX_CSV_MAX_CHARS,
  MIN_CSV_MAX_CHARS,
  normalizeCsvMaxChars,
  DEFAULT_MAX_TOOL_HOPS,
  MAX_TOOL_HOPS_VERSION,
  normalizeMaxToolHops,
} from "../src/lib/messages.ts";

test("normalizeCsvMaxChars: 없거나 잘못된 값은 기본값, 범위 밖은 끝값", () => {
  assert.equal(normalizeCsvMaxChars(undefined), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars("50000"), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(Number.NaN), DEFAULT_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(10), MIN_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(10_000_000), MAX_CSV_MAX_CHARS);
  assert.equal(normalizeCsvMaxChars(12_345.9), 12_345);
});

test("normalizeMaxToolHops: 버전 표시 없는 예전 기본값 8은 새 기본값, 저장한 8은 그대로", () => {
  assert.equal(DEFAULT_MAX_TOOL_HOPS, 16);
  assert.equal(normalizeMaxToolHops(undefined), 16);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 8 }), 16);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 8, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 8);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 12 }), 12);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 99, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 99);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 100, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 100);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 250, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 100);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 0, maxToolHopsVersion: MAX_TOOL_HOPS_VERSION }), 1);
  assert.equal(normalizeMaxToolHops({ maxToolHops: 0.5 }), 1);
  assert.equal(normalizeMaxToolHops({ maxToolHops: "8" }), 16);
});

import { DEFAULT_SETTINGS, normalizeSettings, settingsForStorage } from "../src/lib/settings.ts";

test("normalizeSettings: 비거나 형식이 틀린 값은 기본값, 켜짐 기본은 false일 때만 끈다", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  const s = normalizeSettings({
    openRouterApiKey: 42,
    translationTargetLang: "k",
    downloadFolderPrefix: null,
    actionLogEnabled: "no",
    rememberPages: false,
    autoApprove: "true",
    trustedInput: true,
    manualSites: ["https://a.example", "https://a.example/x", 3],
    systemPrompt: "x".repeat(5000),
  });
  assert.equal(s.openRouterApiKey, "");
  assert.equal(s.translationTargetLang, "ko");
  assert.equal(s.downloadFolderPrefix, DEFAULT_SETTINGS.downloadFolderPrefix);
  assert.equal(s.actionLogEnabled, true);
  assert.equal(s.rememberPages, false);
  assert.equal(s.runMode, "ask");
  assert.equal(s.trustedInput, true);
  assert.deepEqual(s.manualSites, ["https://a.example"]);
  assert.equal(s.systemPrompt.length, 4000);
});

test("runMode(#123): 예전 autoApprove는 true면 auto, 값이 있으면 그 값, 틀린 값은 ask", () => {
  assert.equal(normalizeSettings({ autoApprove: true }).runMode, "auto");
  assert.equal(normalizeSettings({ autoApprove: false }).runMode, "ask");
  assert.equal(normalizeSettings({ runMode: "task", autoApprove: true }).runMode, "task");
  assert.equal(normalizeSettings({ runMode: "ask", autoApprove: true }).runMode, "ask");
  assert.equal(normalizeSettings({ runMode: "skip" }).runMode, "ask");
  assert.equal("autoApprove" in normalizeSettings({ autoApprove: true }), false);
});

test("settingsForStorage: 한도 표시를 붙이고 목록·숫자를 정리한다", () => {
  const out = settingsForStorage({ ...DEFAULT_SETTINGS, maxToolHops: 8, csvMaxChars: 5, manualSites: ["https://a.example", "https://a.example"] });
  assert.equal(out.maxToolHopsVersion, MAX_TOOL_HOPS_VERSION);
  assert.equal(out.maxToolHops, 8);
  assert.equal(out.csvMaxChars, MIN_CSV_MAX_CHARS);
  assert.deepEqual(out.manualSites, ["https://a.example"]);
  // 저장한 값을 다시 읽으면 사용자가 고른 8을 그대로 둔다.
  assert.equal(normalizeSettings(out).maxToolHops, 8);
});

import { mergeSettingsPatch } from "../src/lib/settings.ts";

test("mergeSettingsPatch: 바꾼 필드만, 제공자별 키·모델은 한 단계 더 합친다", () => {
  const base = normalizeSettings({ runMode: "task", apiKeys: { openai: "a", gemini: "g" }, providerModels: { openai: "gpt-5" } });
  const next = mergeSettingsPatch(base, { showThinking: true, providerModels: { gemini: "gemini-3.6-flash" }, apiKeys: { gemini: "g2" } });
  assert.equal(next.runMode, "task");
  assert.equal(next.showThinking, true);
  assert.deepEqual(next.providerModels, { openai: "gpt-5", gemini: "gemini-3.6-flash" });
  assert.deepEqual(next.apiKeys, { openai: "a", gemini: "g2" });
});
