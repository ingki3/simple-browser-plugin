// 설정 페이지(#127): 전체 설정은 브라우저 탭의 옵션 페이지(왼쪽 메뉴 다섯 묶음, 주소 해시)에서 하고, 바꾸면 바로 저장(API 키는
// 저장 버튼). 패널의 ⚙·"설정 열기"는 열린 설정 탭을 다시 쓰고, 패널에는 실행 방식 선택 등 빠른 설정만 남는다.
import { expect } from "../lib.mjs";

const stored = (h) => h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
const show = async (p, section) => {
  await p.locator(".settings-nav a", { hasText: section }).click();
  await p.waitForTimeout(150);
};

export default [
  {
    name: "설정 페이지는 다섯 묶음 메뉴, 해시로 고르고 고른 묶음만 보이며, 체크 항목은 바꾸면 바로 저장",
    async run(h) {
      const opt = await h.openOptions("model");
      const menu = await opt.locator(".settings-nav a").allInnerTexts();
      expect(menu.join(",") === "모델·연결,동작,사이트,기록,고급", `메뉴(${menu.join(",")})`);
      const visible = () => opt.locator(".settings-section:not([hidden])").getAttribute("data-section");
      expect((await visible()) === "model", "처음은 모델·연결");
      await show(opt, "동작");
      expect((await visible()) === "behavior" && opt.url().endsWith("#behavior"), `해시로 고름(${opt.url()})`);
      expect((await opt.locator(".settings-section[hidden]").count()) === 4, "나머지는 숨김(마운트는 유지)");
      await opt.locator("input[name=run-mode][value=auto]").check();
      await opt.waitForTimeout(300);
      expect((await stored(h)).runMode === "auto", "실행 방식이 바로 저장됨");
      await opt.close();
    },
  },
  {
    name: "API 키는 저장 버튼을 눌러야 저장, 글자 칸은 입력이 멈추면·탭을 닫을 때 저장, 패널은 키가 생기면 안내를 거둔다",
    async run(h) {
      await h.settings({ openRouterApiKey: "" });
      await h.panel.waitForTimeout(300);
      expect((await h.panel.locator(".welcome").innerText()).includes("API 키가 필요합니다"), "패널 키 안내");
      const opt = await h.openOptions("model");
      const key = opt.locator(".key-row input[autocomplete=off]");
      await key.fill("sk-or-new-key");
      await opt.waitForTimeout(900);
      expect((await stored(h)).openRouterApiKey === "", "저장 전에는 그대로");
      await opt.locator(".key-row button.primary", { hasText: "저장" }).first().click();
      await opt.waitForTimeout(300);
      expect((await stored(h)).openRouterApiKey === "sk-or-new-key", "저장 버튼으로 저장");
      await h.panel.waitForTimeout(300);
      expect(!(await h.panel.locator(".welcome").innerText()).includes("API 키가 필요합니다"), "패널이 바로 반영");
      await show(opt, "고급");
      await opt.locator(".settings-section[data-section=advanced] textarea").fill("항상 존댓말");
      await opt.waitForTimeout(1000);
      expect((await stored(h)).systemPrompt === "항상 존댓말", "입력이 멈추면 저장");
      await opt.locator(".settings-section[data-section=advanced] textarea").fill("항상 반말");
      await opt.close({ runBeforeUnload: true });
      await h.panel.waitForTimeout(500);
      expect((await stored(h)).systemPrompt === "항상 반말", "닫을 때 남은 저장");
    },
  },
  {
    name: "패널의 ⚙는 설정 탭을 열고, 열린 탭이 있으면 그 탭만 쓴다(연속으로 눌러도 하나), 설정 열기는 모델·연결로",
    async run(h) {
      const gear = () => h.panel.locator("button.icon-btn[title]", { hasText: "⚙" }).click();
      await h.panel.bringToFront();
      await gear();
      await gear();
      const first = await h.waitOptions("model");
      expect(first, "설정 탭(모델·연결)");
      await h.panel.waitForTimeout(500);
      expect(h.optionsPages().length === 1, `탭 하나(${h.optionsPages().length})`);
      // 다른 묶음을 보던 탭은 ⚙(묶음 없음)로는 그대로, 설정 열기(모델·연결)로는 그 묶음으로 바뀐다.
      await show(first, "고급");
      await h.panel.bringToFront();
      await gear();
      await h.panel.waitForTimeout(500);
      expect(first.url().endsWith("#advanced"), `⚙는 묶음을 바꾸지 않음(${first.url()})`);
      // 두 번째 설정 탭(사용자가 직접 연 것)이 있어도 패널은 그중 하나만 바꾼다.
      const second = await h.openOptions("sites");
      await h.panel.bringToFront();
      await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "open_settings", section: "records" }));
      await h.panel.waitForTimeout(500);
      const hashes = h.optionsPages().map((p) => p.url().split("#")[1]).sort();
      expect(h.optionsPages().length === 2 && hashes.filter((x) => x === "records").length === 1, `하나만 바뀜(${hashes.join(",")})`);
      // 화면 밖에서 온 것처럼 잘못된 묶음은 모델·연결로 연다.
      await first.close();
      await second.close();
      await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "open_settings", section: "javascript:x" }));
      expect(await h.waitOptions("model"), "모르는 묶음은 모델·연결");
    },
  },
  {
    name: "패널의 실행 방식 선택과 설정 페이지가 같은 값을 보인다(서로 바로 반영)",
    async run(h) {
      const opt = await h.openOptions("behavior");
      await opt.locator("input[name=run-mode][value=task]").check();
      await h.panel.waitForTimeout(400);
      expect((await h.panel.locator("#run-mode-select").inputValue()) === "task", "설정 → 패널");
      await h.panel.selectOption("#run-mode-select", "auto");
      await opt.waitForTimeout(400);
      expect(await opt.locator("input[name=run-mode][value=auto]").isChecked(), "패널 → 설정");
      await opt.close();
    },
  },
  {
    name: "설정 페이지에서 제공자·모델을 바꾸면 다음 요청은 새 제공자·모델로, 이전 대화 없이 간다",
    async run(h) {
      await h.turn([{ text: "첫 답" }], { text: "첫 요청 비밀단어" });
      const opt = await h.openOptions("model");
      // 같은 제공자에서 모델만 바꾼다.
      await opt.locator(".settings-section[data-section=model] select").nth(1).selectOption({ index: 1 });
      await opt.waitForTimeout(500);
      const model = (await stored(h)).model;
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.panel.bringToFront();
      await h.turn([{ text: "둘째 답" }], { text: "둘째 요청" });
      let req = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1));
      expect(req?.body?.model === model && !JSON.stringify(req.body.messages).includes("첫 요청 비밀단어"), `모델만 바꿔도 새 대화(${req?.body?.model})`);
      // 제공자를 바꾼다(키 있는 OpenAI).
      await h.settings({ apiKeys: { openai: "sk-test" } });
      await opt.bringToFront();
      await opt.locator(".settings-section[data-section=model] select").first().selectOption("openai");
      await opt.waitForTimeout(500);
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.panel.bringToFront();
      await h.turn([{ text: "셋째 답" }], { text: "셋째 요청" });
      req = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1));
      expect(req?.url.includes("api.openai.com") && !JSON.stringify(req.body).includes("둘째 요청"), `새 제공자·새 대화(${req?.url})`);
      await opt.close();
    },
  },
  {
    name: "두 설정 탭이 서로 다른 항목을 바꿔도 상대가 바꾼 값을 덮지 않는다",
    async run(h) {
      await h.settings({ autoApprove: true, showThinking: false });
      const a = await h.openOptions("behavior");
      const b = await h.openOptions("advanced");
      await a.bringToFront();
      await a.locator("input[name=run-mode][value=ask]").check();
      await a.waitForTimeout(400);
      await b.bringToFront();
      await b.locator(".field", { hasText: "생각 과정 보기" }).locator("input[type=checkbox]").first().check();
      await b.waitForTimeout(400);
      const st = await stored(h);
      await a.close();
      await b.close();
      expect(st.runMode === "ask" && st.showThinking === true, `둘 다 유지(${JSON.stringify({ runMode: st.runMode, showThinking: st.showThinking })})`);
    },
  },
  {
    name: "동시에 보낸 저장도 서로 덮지 않고, 한 제공자의 모델만 바꾸면 다른 제공자의 모델은 그대로",
    async run(h) {
      await h.settings({ autoApprove: true, showThinking: false, providerModels: { openai: "gpt-5" } });
      await h.panel.evaluate(async () => {
        const send = (patch) => chrome.runtime.sendMessage({ kind: "settings_patch", patch });
        await Promise.all([send({ runMode: "ask" }), send({ showThinking: true }), send({ providerModels: { gemini: "gemini-3.1-pro-preview" } })]);
      });
      const st = await stored(h);
      expect(
        st.runMode === "ask" && st.showThinking === true && st.providerModels.openai === "gpt-5" && st.providerModels.gemini === "gemini-3.1-pro-preview",
        `모두 유지(${JSON.stringify({ runMode: st.runMode, showThinking: st.showThinking, providerModels: st.providerModels })})`,
      );
    },
  },
  {
    name: "직접 조작할 사이트(#127): 열린 탭에서 고르고, 두 설정 탭에서 따로 넣어도 둘 다 남고 뺀 사이트는 되살아나지 않는다",
    async run(h) {
      await h.settings({ manualSites: [] });
      await h.tab.goto(`${h.base2}/`);
      const a = await h.openOptions("sites");
      const b = await h.openOptions("sites");
      const field = (p) => p.locator(".field", { hasText: "직접 조작할 사이트" });
      const addSite = async (p, site) => {
        await p.bringToFront();
        await field(p).locator("input[type=text]").fill(site);
        await field(p).locator(".key-row", { has: p.locator("input[type=text]") }).locator("button", { hasText: "추가" }).click();
        await p.waitForTimeout(400);
      };
      // 열린 탭에서 고르기: 시험 탭의 출처가 후보에 있고(설정 탭 자신은 없음), 고르면 들어간다.
      const pick = field(a).locator("select[aria-label='열린 탭에서 고르기']");
      await pick.focus();
      await a.waitForTimeout(300);
      const opts = await pick.locator("option").allInnerTexts();
      const origin2 = new URL(h.base2).origin;
      expect(opts.some((o) => o.startsWith(origin2)) && !opts.some((o) => o.startsWith("chrome-extension")), `후보(${JSON.stringify(opts)})`);
      await pick.selectOption(origin2);
      await field(a).locator(".manual-tab-pick button", { hasText: "추가" }).click();
      await a.waitForTimeout(400);
      expect((await stored(h)).manualSites.includes(origin2), "고른 사이트가 들어감");
      await addSite(a, "a.example");
      await addSite(b, "b.example");
      let st = await stored(h);
      expect(["https://a.example", "https://b.example"].every((s) => st.manualSites.includes(s)), `둘 다(${JSON.stringify(st.manualSites)})`);
      await a.bringToFront();
      await field(a).locator(".key-row", { hasText: "https://a.example" }).locator("button", { hasText: "빼기" }).click();
      await a.waitForTimeout(300);
      await addSite(b, "c.example");
      st = await stored(h);
      expect(!st.manualSites.includes("https://a.example") && st.manualSites.includes("https://c.example"), `뺀 사이트가 되살아나지 않음(${JSON.stringify(st.manualSites)})`);
      const bad = await a.evaluate(() => chrome.runtime.sendMessage({ kind: "manual_site_op", op: { op: "add", site: "https://x.example/path" } }));
      expect(bad?.ok === false, `잘못된 값 거절(${JSON.stringify(bad)})`);
      await a.close();
      await b.close();
    },
  },
  {
    name: "자동 로그인 목록(#127): 옛 항목에 승인 식별자를 한 번 채우고, 보던 승인과 다르면(다시 승인) 옛 화면의 변경을 받지 않는다",
    async run(h) {
      const O = h.base;
      const UUID = "0123456789abcdef0123456789abcdef";
      await h.settings({ loginSites: [{ origin: O, uuid: UUID, entryName: "Harness", totp: false }] });
      await h.sw.evaluate(() => globalThis.__sbpSettings.migrateLoginGrantIds());
      const first = (await stored(h)).loginSites[0].grantId;
      expect(/^[A-Za-z0-9_-]{22}$/.test(first ?? ""), `채움(${first})`);
      await h.sw.evaluate(() => globalThis.__sbpSettings.migrateLoginGrantIds());
      expect((await stored(h)).loginSites[0].grantId === first, "다시 불러도 그대로");
      const opt = await h.openOptions("sites");
      const row = opt.locator(".key-row", { hasText: O });
      // 저장된 값을 따라가는 칸이라 저장이 끝난 뒤에 바뀐다(check()는 바로 바뀌기를 기대한다).
      await row.locator("input[type=checkbox]").click();
      await opt.waitForTimeout(400);
      expect((await stored(h)).loginSites[0].totp === true, "코드 켜기");
      await h.settings({ loginSites: [{ origin: O, uuid: UUID, entryName: "Harness", totp: false, grantId: "BBBBBBBBBBBBBBBBBBBBBB" }] });
      const late = await opt.evaluate(
        ({ O, first }) => chrome.runtime.sendMessage({ kind: "login_site_op", op: { op: "set_totp", origin: O, grantId: first, totp: true } }),
        { O, first },
      );
      const st = (await stored(h)).loginSites;
      expect(late?.ok === false && st.length === 1 && st[0].totp === false, `옛 변경 거절(${JSON.stringify({ late, st })})`);
      await opt.waitForTimeout(300);
      await row.locator("button", { hasText: "빼기" }).click();
      await opt.waitForTimeout(400);
      expect((await stored(h)).loginSites.length === 0, "지금 승인으로 빼기");
      await opt.close();
    },
  },
];
