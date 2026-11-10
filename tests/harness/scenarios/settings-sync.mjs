// 설정 페이지(탭)를 여러 개·오래 열어 두어도 최신 값을 따라가는지(#127 2단계): 저장 값과 편집 초안을 나눈 칸(키·음성 모델·MCP 포트),
// 백그라운드에서 읽어 오는 목록(저장 링크·동작 기록·페이지 제안)의 다시 읽기와 늦은 옛 변경 거절.
import { ask, expect, waitUntil } from "../lib.mjs";
import { connect } from "./telegram.mjs";

const stored = (h) => h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);


export default [
  {
    name: "API 키 칸: 고치지 않은 칸은 다른 서랍이 저장한 키를 따라가고, 고치는 중인 칸은 초안을 두고 알린다",
    async run(h) {
      const a = await h.openOptions("model");
      const other = await h.openOptions("model");
      const key = (p) => p.locator(".key-row input[autocomplete=off]");
      const save = (p) => p.locator(".key-row button.primary", { hasText: "저장" }).first().click();
      await key(a).fill("sk-or-A");
      await save(a);
      await a.waitForTimeout(500);
      expect((await key(other).inputValue()) === "sk-or-A", `고치지 않은 칸은 따라감(${await key(other).inputValue()})`);
      // B가 고치는 중에 A가 다시 저장한다.
      await key(other).fill("sk-or-B-draft");
      await key(a).fill("sk-or-A2");
      await save(a);
      await other.waitForTimeout(500);
      expect((await key(other).inputValue()) === "sk-or-B-draft", "고치는 중인 초안은 그대로");
      expect((await other.locator(".key-conflict").count()) === 1, "다른 곳에서 바뀌었다는 안내");
      await other.locator(".key-conflict button", { hasText: "되돌리기" }).click();
      expect((await key(other).inputValue()) === "sk-or-A2" && (await other.locator(".key-conflict").count()) === 0, "되돌리기");
      expect((await stored(h)).openRouterApiKey === "sk-or-A2", "저장 값");
      await a.close();
      await other.close();
    },
  },
  {
    name: "음성 입력 모델 칸: 다른 서랍이 바꾼 모델을 따라가고, 내가 입력한 글자는 저장이 돌아와도 그대로",
    async run(h) {
      await h.settings({ voiceInput: { provider: "openai", models: {}, language: "ko", autoSend: true } });
      const a = await h.openOptions("behavior");
      const other = await h.openOptions("behavior");
      const model = (p) => p.locator("input[aria-label='음성 입력 모델']");
      await model(a).fill("whisper-1");
      await a.waitForTimeout(1200);
      expect((await stored(h)).voiceInput.models.openai === "whisper-1", "저장");
      expect((await model(a).inputValue()) === "whisper-1", "내 칸은 그대로");
      expect((await model(other).inputValue()) === "whisper-1", `다른 서랍이 따라감(${await model(other).inputValue()})`);
      // 잘못된 글자는 저장 값이 비지만(기본 모델) 입력 중인 글자를 지우지 않는다.
      await model(a).fill("bad model");
      await a.waitForTimeout(1200);
      expect((await model(a).inputValue()) === "bad model" && !(await stored(h)).voiceInput.models.openai, "입력 중인 글자 유지");
      expect((await a.locator(".voice-model-conflict").count()) === 0, "내 저장은 충돌이 아님");
      await a.close();
      await other.close();
    },
  },
  {
    name: "MCP 포트 칸: 상태를 다시 읽어도 고치는 중인 포트를 덮지 않는다",
    async run(h) {
      await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "mcp_set", enabled: true }));
      const opt = await h.openOptions("model");
      // 다른 묶음으로 옮겨 가도(마운트 유지) 초안이 남는다.
      const port = opt.locator("input[aria-label='포트']");
      await port.fill("48000");
      await opt.locator(".settings-nav a", { hasText: "고급" }).click();
      // 다른 화면이 묻기 설정을 바꾸면 이 화면이 상태를 다시 읽는다.
      await h.sw.evaluate(async () => {
        const cur = (await chrome.storage.local.get("mcp")).mcp;
        await chrome.storage.local.set({ mcp: { ...cur, askApproval: !cur.askApproval } });
      });
      await opt.waitForTimeout(600);
      await opt.locator(".settings-nav a", { hasText: "모델·연결" }).click();
      expect((await port.inputValue()) === "48000", `초안 유지(${await port.inputValue()})`);
      await opt.close();
      await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "mcp_set", enabled: false }));
    },
  },
  {
    name: "저장 링크·동작 기록: 다른 곳에서 바꾸면 열린 서랍의 목록·개수가 바뀐다",
    async run(h) {
      await h.sw.evaluate(async (base) => {
        await chrome.storage.local.set({
          savedPages: [
            { id: "s1", name: "상품 검색", purpose: "", template: { base: `${base}/shop/search`, params: [{ key: "q", slot: "상품명" }], hash: "" }, slots: [{ key: "상품명", hint: "" }], site: base, savedAt: 1, lastUsedAt: 1, uses: 0 },
            { id: "s2", name: "주문 조회", purpose: "", template: { base: `${base}/orders`, params: [], hash: "" }, slots: [], site: base, savedAt: 2, lastUsedAt: 2, uses: 0 },
          ],
          actionLog: [],
        });
      }, h.base);
      const opt = await h.openOptions("records");
      const names = () => opt.locator(".saved-name").allInnerTexts();
      expect((await names()).length === 2, `처음 두 개(${JSON.stringify(await names())})`);
      await h.sw.evaluate(async () => {
        const cur = (await chrome.storage.local.get("savedPages")).savedPages;
        await chrome.storage.local.set({ savedPages: cur.filter((p) => p.id !== "s1") });
      });
      await opt.waitForTimeout(500);
      const after = await names();
      expect(after.length === 1 && after[0].includes("주문 조회"), `지운 링크가 빠짐(${JSON.stringify(after)})`);
      const clearBtn = opt.locator(".field", { hasText: "동작 기록" }).locator("button", { hasText: "기록 지우기" });
      expect(await clearBtn.isDisabled(), "기록 0건이면 지우기 꺼짐");
      await h.sw.evaluate(async () => {
        await chrome.storage.local.set({ actionLog: [{ at: Date.now(), tool: "click_element", origin: "https://a.example", path: "/", ok: true }] });
      });
      await opt.waitForTimeout(500);
      const text = await opt.locator(".field", { hasText: "동작 기록" }).innerText();
      expect(!(await clearBtn.isDisabled()), `기록이 생기면 지우기 켜짐(${text.slice(0, 80)})`);
      await opt.close();
    },
  },
  {
    name: "페이지 제안: 고치는 동안 다른 곳에서 그 규칙이 바뀌면 알리고 옛 초안 저장을 거절한다",
    async run(h) {
      await h.sw.evaluate(async (base) => {
        await chrome.storage.local.set({
          pageSuggestions: [{ id: "r1", origin: base, path: "/article/*", label: "번역해 드릴까요?", request: "번역해줘", enabled: true, version: 1, createdAt: 1 }],
        });
      }, h.base);
      const opt = await h.openOptions("records");
      const field = opt.locator(".page-suggestions");
      await field.locator("button", { hasText: "고치기" }).click();
      await field.locator(".suggestion-label-input").fill("옛 초안");
      // 다른 화면에서 같은 규칙을 고친다.
      const r = await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "page_suggest_update", id: "r1", label: "다른 곳에서 고침" }));
      expect(r?.ok, "다른 곳 저장");
      await opt.waitForTimeout(400);
      expect((await field.locator(".suggestion-conflict").count()) === 1, "바뀌었다는 안내");
      await field.locator("button", { hasText: "저장" }).click();
      await opt.waitForTimeout(400);
      const rules = await h.sw.evaluate(async () => (await chrome.storage.local.get("pageSuggestions")).pageSuggestions);
      expect(rules[0].label === "다른 곳에서 고침", `옛 초안은 저장되지 않음(${rules[0].label})`);
      expect((await field.innerText()).includes("다른 곳에서 바뀌었습니다"), "거절 이유");
      await opt.close();
    },
  },
  {
    name: "텔레그램 알림 요약 체크박스(#209): 알림이 꺼져 있으면 비활성, 눌러 저장, 다른 곳에서 바꾸면 열린 설정 화면이 따라간다",
    async run(h) {
      await connect(h);
      const a = await h.openOptions("model");
      const b = await h.openOptions("model");
      const notify = (p) => p.locator("label.check-row", { hasText: "반복 작업의 조건이 맞으면 텔레그램으로 알리기" }).locator("input");
      const summary = (p) => p.locator("label.check-row", { hasText: "알림에 확인 결과 요약도 보내기" }).locator("input");
      const tg = () => h.sw.evaluate(async () => (await chrome.storage.local.get("telegram")).telegram);
      const until = (fn, label) => waitUntil(fn, { timeoutMs: 5000, intervalMs: 100, label });
      expect((await summary(a).count()) === 1, "요약 체크박스가 있음");
      expect((await summary(a).isDisabled()) && !(await summary(a).isChecked()), "알림 꺼짐이면 요약은 꺼진 채 비활성");
      // 체크박스는 저장 응답으로 바뀌는 제어 칸이라 check() 대신 눌러 두고 결과를 기다린다.
      await notify(a).click();
      await until(async () => (await notify(a).isChecked()) && !(await summary(a).isDisabled()), "알림을 켜면 요약 활성");
      await summary(a).click();
      await until(async () => (await tg()).notifyRepeatSummary === true, "요약 저장");
      await until(async () => (await summary(b).isChecked()) && !(await summary(b).isDisabled()), "다른 설정 화면이 따라감");
      // 다른 곳(패널 메시지)에서 끄면 열린 두 화면이 따라간다.
      expect((await ask(h, { kind: "telegram_set_notify_summary", on: false })).ok, "다른 곳에서 요약 끔");
      await until(async () => !(await summary(a).isChecked()) && !(await summary(b).isChecked()), "요약 끔을 따라감");
      // 알림을 끄면 요약은 비활성이지만 저장 값은 그대로 둔다.
      await ask(h, { kind: "telegram_set_notify_summary", on: true });
      await ask(h, { kind: "telegram_set_notify", on: false });
      await until(async () => (await summary(a).isDisabled()) && (await summary(a).isChecked()), "알림 끔이면 비활성(값은 그대로)");
      expect((await tg()).notifyRepeatSummary === true, "저장 값 유지");
      await a.close();
      await b.close();
    },
  },
];
