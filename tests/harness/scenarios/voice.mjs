// 음성 입력(#184): 가짜 마이크(--use-fake-device-for-media-stream)로 녹음하고, 서비스 워커 fetch로 음성 변환 응답을 흉내 낸다.
// 받아쓴 글자는 입력창에만 들어가고 보내지 않는다. 녹음을 시작할 때 고정한 제공자로만 보내고, 설정이 바뀌면 보내지 않거나 멈춘다.
import { expect, waitUntil } from "../lib.mjs";

// 기존 시나리오는 입력창에만 넣는 동작(autoSend 끔)을 본다. 바로 보내기는 아래 SEND 시나리오들.
const OPENAI = { voiceInput: { provider: "openai", models: {}, language: "ko", autoSend: false }, apiKeys: { openai: "sk-voice-test" } };
const SEND = { voiceInput: { provider: "openai", models: {}, language: "ko", autoSend: true }, apiKeys: { openai: "sk-voice-test" } };
const userBubbles = (h) => h.panel.locator(".bubble-user").allInnerTexts();
const chatTexts = (h) =>
  h.sw.evaluate(() =>
    (globalThis.__modelReqs ?? []).flatMap((r) => (r.body?.messages ?? []).filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content)),
  );
const mic = (h) => h.panel.locator("button.composer-btn.mic");
const voiceReqs = (h) => h.sw.evaluate(() => globalThis.__voiceReqs ?? []);
const chatReqs = (h) => h.sw.evaluate(() => (globalThis.__modelReqs ?? []).length);
const input = (h) => h.panel.locator("textarea.composer-input");

// 조건이 참이 될 때까지 기다린다(8초). 안 되면 label(과 detail)을 담아 실패한다(#262 — 예전엔 false를 돌려 호출처가 expect).
const waitFor = (h, fn, label, { ms = 8000, detail } = {}) => waitUntil(fn, { timeoutMs: ms, intervalMs: 100, label, detail });

const recording = (h, label) => waitFor(h, async () => (await h.panel.locator(".voice-live").count()) > 0, label);

// 녹음 → 1.2초 → 멈춤.
async function speak(h) {
  await mic(h).click();
  await recording(h, "녹음 중 표시");
  await h.panel.waitForTimeout(1200);
  await mic(h).click();
}

// 설정의 voiceInput 하위 필드만 바꾼다(다른 창에서 바꾼 것처럼 저장소에 바로).
async function patchVoice(h, part) {
  await h.sw.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get("settings")).settings ?? {};
    await chrome.storage.local.set({ settings: { ...cur, voiceInput: { ...cur.voiceInput, ...p } } });
  }, part);
}

export default [
  {
    name: "음성 입력(#184): 꺼져 있으면 녹음하지 않고 설정 안내",
    async run(h) {
      await mic(h).click();
      await waitFor(h, async () => (await h.panel.locator(".voice-error").count()) > 0, "안내");
      const t = await h.panel.locator(".voice-error").innerText();
      expect(t.includes("음성 입력") && t.includes("설정 열기"), `설정 안내(${t})`);
      expect((await voiceReqs(h)).length === 0 && (await h.panel.locator(".voice-live").count()) === 0, "녹음·전송 없음");
    },
  },
  {
    name: "음성 입력(#184): ChatGPT로 받아쓴 글자를 입력창 기존 글자 뒤에 넣고 보내지 않는다",
    async run(h) {
      await h.settings(OPENAI);
      await h.panel.waitForTimeout(300);
      await input(h).fill("기존");
      await h.panel.locator("body").click({ position: { x: 5, y: 5 } });
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()) === "기존 음성 글자", "입력창", { detail: () => input(h).inputValue() });
      const reqs = await voiceReqs(h);
      expect(reqs.length === 1 && reqs[0].url === "https://api.openai.com/v1/audio/transcriptions", `OpenAI로만(${JSON.stringify(reqs.map((r) => r.url))})`);
      expect(reqs[0].form.model === "gpt-4o-mini-transcribe" && reqs[0].form.language === "ko" && reqs[0].form.fileType === "audio/wav" && reqs[0].form.fileSize > 16000, `요청(${JSON.stringify(reqs[0].form)})`);
      expect(reqs[0].headers.Authorization === "Bearer sk-voice-test", "키 머리글");
      expect((await chatReqs(h)) === 0 && (await h.panel.locator(".bubble-user").count()) === 0, "보내지 않음");
    },
  },
  {
    name: "음성 입력(#184): Gemini·OpenRouter는 각자 형식으로, 제공자별 모델은 따로 보관",
    async run(h) {
      await h.settings({ voiceInput: { provider: "gemini", models: { gemini: "gemini-x", openai: "whisper-1" }, language: "en", autoSend: false }, apiKeys: { gemini: "g-key" } });
      await h.panel.waitForTimeout(300);
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()) === "음성 글자", "Gemini 글자");
      let reqs = await voiceReqs(h);
      expect(reqs[0].url.endsWith("/models/gemini-x:generateContent") && reqs[0].headers["x-goog-api-key"] === "g-key", `Gemini(${reqs[0].url})`);
      expect(reqs[0].json.contents[0].parts[0].inline_data.mime_type === "audio/wav" && reqs[0].json.contents[0].parts[1].text.includes("영어"), "Gemini 본문");
      await input(h).fill("");
      await h.settings({ voiceInput: { provider: "openrouter", models: { gemini: "gemini-x", openai: "whisper-1" }, language: "", autoSend: false } });
      await h.panel.waitForTimeout(300);
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()) === "음성 글자", "OpenRouter 글자");
      reqs = await voiceReqs(h);
      const or = reqs[1];
      expect(or.url === "https://openrouter.ai/api/v1/audio/transcriptions" && or.json.model === "openai/gpt-4o-transcribe" && or.json.input_audio.format === "wav" && !("language" in or.json), `OpenRouter(${JSON.stringify({ ...or.json, input_audio: undefined })})`);
      expect(or.headers.Authorization === "Bearer sk-or-test-dummy", "OpenRouter 키");
    },
  },
  {
    name: "음성 입력(#184): 녹음 중 제공자가 바뀌면 녹음을 버리고 보내지 않는다",
    async run(h) {
      await h.settings({ ...OPENAI, apiKeys: { openai: "sk-voice-test", gemini: "g" } });
      await h.panel.waitForTimeout(300);
      await mic(h).click();
      await recording(h, "녹음 중");
      await patchVoice(h, { provider: "gemini" });
      await waitFor(h, async () => (await h.panel.locator(".voice-error").count()) > 0, "안내");
      expect((await h.panel.locator(".voice-error").innerText()).includes("설정이 바뀌어"), "설정 바뀜 안내");
      await h.panel.waitForTimeout(1500);
      expect((await voiceReqs(h)).length === 0 && (await h.panel.locator(".voice-live").count()) === 0, "보내지 않음");
    },
  },
  {
    name: "음성 입력(#184): 보내는 중 모델이 바뀌면 요청을 멈추고 입력창에 넣지 않는다",
    async run(h) {
      await h.settings(OPENAI);
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 4000;
      });
      await h.panel.waitForTimeout(300);
      await speak(h);
      await waitFor(h, async () => (await voiceReqs(h)).length === 1, "요청 시작");
      await patchVoice(h, { models: { openai: "whisper-1" } });
      await waitFor(h, async () => (await voiceReqs(h))[0]?.aborted === true, "요청 중단");
      await waitFor(h, async () => (await h.panel.locator(".voice-error").count()) > 0, "안내");
      await h.panel.waitForTimeout(500);
      expect((await input(h).inputValue()) === "", "입력창 그대로");
    },
  },
  {
    name: "음성 입력(#184): 변환 중 취소·새 대화면 늦은 결과를 넣지 않고, 취소 직후 다시 녹음된다",
    async run(h) {
      await h.settings(OPENAI);
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 3000;
      });
      await h.panel.waitForTimeout(300);
      await speak(h);
      await waitFor(h, async () => (await voiceReqs(h)).length === 1, "요청 시작");
      await mic(h).click(); // 변환 중 누르면 취소
      await waitFor(h, async () => (await voiceReqs(h))[0]?.aborted === true, "취소하면 요청 중단");
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 3000;
      });
      await speak(h);
      await waitFor(h, async () => (await voiceReqs(h)).length === 2, "다시 녹음해 보냄");
      await h.panel.locator('button.icon-btn[title="새 대화"]').click();
      await waitFor(h, async () => (await voiceReqs(h))[1]?.aborted === true, "새 대화면 요청 중단");
      await h.panel.waitForTimeout(3500);
      expect((await input(h).inputValue()) === "", `늦은 결과를 넣지 않음(${await input(h).inputValue()})`);
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 0;
      });
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()) === "음성 글자", "새 대화에서 다시 됨");
    },
  },
  {
    name: "음성 입력(#184): 두 패널이 따로 녹음하고, 한쪽 패널을 닫으면 그 요청만 멈춘다",
    async run(h) {
      await h.settings(OPENAI);
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 3000;
      });
      const other = await h.ctx.newPage();
      await other.goto(`chrome-extension://${h.extId}/src/sidepanel/index.html`);
      await other.waitForTimeout(600);
      await speak(h);
      await other.locator("button.composer-btn.mic").click();
      await other.waitForTimeout(1200);
      await other.locator("button.composer-btn.mic").click();
      await waitFor(h, async () => (await voiceReqs(h)).length === 2, "두 요청");
      await other.close();
      await waitFor(h, async () => (await voiceReqs(h))[1]?.aborted === true, "닫은 패널의 요청만 중단");
      await waitFor(h, async () => (await input(h).inputValue()) === "음성 글자", "남은 패널은 받음");
      expect((await voiceReqs(h))[0].aborted === false, "첫 요청은 그대로");
    },
  },
  {
    name: "음성 입력(#184): 제공자 오류는 짧은 안내로(키·음성 없이)",
    async run(h) {
      await h.settings(OPENAI);
      await h.sw.evaluate(() => {
        globalThis.__voiceStatus = 401;
      });
      await h.panel.waitForTimeout(300);
      await speak(h);
      await waitFor(h, async () => (await h.panel.locator(".voice-error").count()) > 0, "오류 안내");
      const t = await h.panel.locator(".voice-error").innerText();
      expect(t.includes("401") && t.includes("bad key") && !t.includes("sk-voice-test"), `오류(${t})`);
    },
  },
  {
    name: "음성 입력(#184): 두 패널이 다른 하위 필드를 동시에 바꿔도 둘 다 남는다(settings_patch 하위 합치기)",
    async run(h) {
      await h.settings(OPENAI);
      await h.panel.evaluate(async () => {
        await Promise.all([
          chrome.runtime.sendMessage({ kind: "settings_patch", patch: { voiceInput: { language: "en" } } }),
          chrome.runtime.sendMessage({ kind: "settings_patch", patch: { voiceInput: { models: { openai: "whisper-1" } } } }),
          chrome.runtime.sendMessage({ kind: "settings_patch", patch: { voiceInput: { models: { gemini: "g-2" } } } }),
        ]);
      });
      const v = await h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings.voiceInput);
      expect(v.provider === "openai" && v.language === "en" && v.models.openai === "whisper-1" && v.models.gemini === "g-2", `합쳐짐(${JSON.stringify(v)})`);
      await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "settings_patch", patch: { voiceInput: { provider: "anthropic" } } }));
      const w = await h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings.voiceInput);
      expect(w.provider === "off", `Claude는 저장되지 않음(${w.provider})`);
    },
  },
  {
    name: "음성 입력(#184): 🎤를 누르기 전 커서 자리에 넣는다(버튼으로 포커스가 옮겨도)",
    async run(h) {
      await h.settings(OPENAI);
      await h.panel.waitForTimeout(300);
      await input(h).fill("앞뒤");
      await input(h).evaluate((el) => {
        el.focus();
        el.setSelectionRange(1, 1);
      });
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()) === "앞 음성 글자뒤", "커서 자리", { detail: () => input(h).inputValue() });
    },
  },
  {
    name: "음성 입력: 바로 보내기(기본) — 받아쓰면 기존 글자와 합쳐 바로 보내고 입력창을 비운다",
    async run(h) {
      await h.settings(SEND);
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ text: "알겠습니다" }];
      });
      await h.panel.waitForTimeout(300);
      await input(h).fill("앞말");
      await h.panel.locator("body").click({ position: { x: 5, y: 5 } });
      await speak(h);
      await waitFor(h, async () => (await userBubbles(h)).length === 1, "사용자 말풍선");
      const b = await userBubbles(h);
      expect(b[0].includes("앞말 음성 글자"), `합친 글을 보냄(${b[0]})`);
      await waitFor(h, async () => (await chatTexts(h)).some((t) => t.includes("앞말 음성 글자")), "모델 요청에 그 글");
      expect((await input(h).inputValue()) === "", "입력창 비움");
    },
  },
  {
    name: "음성 입력: 바로 보내기 — 응답 중이거나 글자가 잘렸으면 보내지 않고 입력창에 넣고 알린다",
    async run(h) {
      await h.settings(SEND);
      await h.sw.evaluate(() => {
        // 녹음·변환이 끝날 때까지 응답 중이게 간격을 넉넉히 둔다(느린 CI에서 5초면 먼저 끝나 바로 보내졌다).
        globalThis.__steps = [{ textParts: ["앞부분 ", "뒷부분"], gapMs: 20000 }];
      });
      await h.panel.waitForTimeout(300);
      await input(h).fill("첫 요청");
      await h.panel.click("button.composer-btn.primary");
      await h.panel.waitForFunction(() => !!document.querySelector("button.composer-btn.danger"), null, { timeout: 5000 });
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()) === "음성 글자", "입력창에", { detail: () => input(h).inputValue() });
      expect((await userBubbles(h)).length === 1, "보내지 않음");
      expect((await h.panel.locator(".composer-hint").allInnerTexts()).some((t) => t.includes("응답을 받는 중")), "안내");
      await h.panel.waitForFunction(() => !document.querySelector("button.composer-btn.danger"), null, { timeout: 30000 });
      await input(h).fill("");
      await h.sw.evaluate(() => {
        globalThis.__voiceReply = "가".repeat(2100);
      });
      await speak(h);
      await waitFor(h, async () => (await input(h).inputValue()).length === 2000, "잘린 글은 입력창에");
      expect((await userBubbles(h)).length === 1, "잘린 글은 보내지 않음");
    },
  },
  {
    name: "음성 입력: 바로 보내기 — 변환 중 취소·새 대화면 보내지 않는다",
    async run(h) {
      await h.settings(SEND);
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 2500;
        globalThis.__steps = [{ text: "x" }, { text: "y" }];
      });
      await h.panel.waitForTimeout(300);
      await speak(h);
      await waitFor(h, async () => (await voiceReqs(h)).length === 1, "요청 시작");
      await mic(h).click();
      await speak(h);
      await waitFor(h, async () => (await voiceReqs(h)).length === 2, "다시");
      await h.panel.locator('button.icon-btn[title="새 대화"]').click();
      await h.panel.waitForTimeout(3500);
      expect((await userBubbles(h)).length === 0 && (await chatReqs(h)) === 0, `보내지 않음(${(await userBubbles(h)).length}/${await chatReqs(h)})`);
    },
  },
  {
    name: "음성 입력: 바로 보내기 — 변환 중 고친 글은 합쳐 보내고, 그사이 직접 보낸 초안은 다시 보내지 않으며, 변환 중 끄면 입력창에만",
    async run(h) {
      await h.settings(SEND);
      await h.sw.evaluate(() => {
        globalThis.__voiceDelayMs = 2000;
        globalThis.__steps = [{ text: "a" }, { text: "b" }, { text: "c" }];
      });
      await h.panel.waitForTimeout(300);
      // 1) 변환 중 입력창에 글을 쓰면 그 글 뒤에 붙여 보낸다.
      await speak(h);
      await input(h).fill("고친글");
      await h.panel.locator("body").click({ position: { x: 5, y: 5 } });
      await waitFor(h, async () => (await userBubbles(h)).length === 1, "보냄");
      expect((await userBubbles(h))[0].includes("고친글 음성 글자"), `최근 편집 유지(${(await userBubbles(h))[0]})`);
      await h.panel.waitForFunction(() => !document.querySelector("button.composer-btn.danger"), null, { timeout: 10000 });
      // 2) 변환 중 초안을 직접 보내면, 도착한 받아쓰기는 그 초안 없이 보낸다(초안 재전송 없음).
      await speak(h);
      await input(h).fill("직접보냄");
      await h.panel.click("button.composer-btn.primary");
      await waitFor(h, async () => (await userBubbles(h)).length === 2, "직접 보냄");
      await h.panel.waitForFunction(() => !document.querySelector("button.composer-btn.danger"), null, { timeout: 10000 });
      await h.panel.waitForTimeout(2500);
      const b = await userBubbles(h);
      expect(b.filter((t) => t.includes("직접보냄")).length === 1, `초안은 한 번만(${JSON.stringify(b)})`);
      // 3) 변환 중 바로 보내기를 끄면 입력창에만.
      const n = (await userBubbles(h)).length;
      await speak(h);
      await patchVoice(h, { autoSend: false });
      await waitFor(h, async () => (await input(h).inputValue()).includes("음성 글자"), "입력창에");
      expect((await userBubbles(h)).length === n, "끄면 보내지 않음");
    },
  },
];
