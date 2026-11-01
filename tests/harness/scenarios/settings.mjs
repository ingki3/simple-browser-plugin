// 설정 화면(#99): 사이드 패널 서랍 한 곳, 묶음(시작하기만 펼침), 바꾸면 바로 저장(API 키는 저장 버튼), 옵션 페이지는 안내만.
import { expect } from "../lib.mjs";

const stored = (h) => h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);

async function openDrawer(h) {
  await h.panel.bringToFront();
  await h.panel.locator("button.icon-btn[title]", { hasText: "⚙" }).click();
  await h.panel.waitForTimeout(300);
}

export default [
  {
    name: "서랍은 묶음으로, 시작하기만 펼치고, 체크 항목은 바꾸면 바로 저장",
    async run(h) {
      await openDrawer(h);
      const groups = await h.panel.locator("details.settings-group").evaluateAll((els) => els.map((e) => `${e.querySelector("summary").textContent}:${e.open}`));
      expect(groups.join(",") === "시작하기:true,동작:false,반복 작업:false,기억·기록:false,자동 로그인 (선택 · KeePassXC 필요):false,텔레그램 연동 (선택):false,MCP 연동 (선택):false,Google 연결 (선택 · 직접 빌드 필요):false,고급:false", `묶음(${groups.join(",")})`);
      expect((await h.panel.locator(".drawer-footer").count()) === 0, "저장·취소 버튼 없음");
      await h.panel.locator("details.settings-group summary", { hasText: "동작" }).click();
      await h.panel.locator("input[name=run-mode][value=auto]").check();
      await h.panel.waitForTimeout(300);
      expect((await stored(h)).runMode === "auto", "실행 방식이 바로 저장됨");
    },
  },
  {
    name: "API 키는 저장 버튼을 눌러야 저장, 글자 칸은 입력이 멈추면·닫을 때 저장",
    async run(h) {
      await openDrawer(h);
      const key = h.panel.locator(".key-row input[autocomplete=off]");
      await key.fill("sk-or-new-key");
      await h.panel.waitForTimeout(900);
      expect((await stored(h)).openRouterApiKey === "sk-or-test-dummy", "저장 전에는 그대로");
      await h.panel.locator(".key-row button.primary", { hasText: "저장" }).first().click();
      await h.panel.waitForTimeout(300);
      expect((await stored(h)).openRouterApiKey === "sk-or-new-key", "저장 버튼으로 저장");
      await h.panel.locator("details.settings-group summary", { hasText: "고급" }).click();
      await h.panel.locator(".drawer textarea").fill("항상 존댓말");
      await h.panel.waitForTimeout(1000);
      expect((await stored(h)).systemPrompt === "항상 존댓말", "입력이 멈추면 저장");
      await h.panel.locator(".drawer textarea").fill("항상 반말");
      await h.panel.locator(".drawer-header button", { hasText: "닫기" }).click();
      await h.panel.waitForTimeout(300);
      expect((await stored(h)).systemPrompt === "항상 반말", "닫을 때 남은 저장");
    },
  },
  {
    name: "옵션 페이지는 사이드 패널로 안내만 한다",
    async run(h) {
      const opt = await h.ctx.newPage();
      await opt.goto(`chrome-extension://${h.extId}/src/options/index.html`);
      await opt.waitForTimeout(400);
      const text = await opt.locator("body").innerText();
      const inputs = await opt.locator("input, textarea, select").count();
      await opt.close();
      expect(text.includes("사이드 패널의") && text.includes("사이드 패널 열기") && inputs === 0, `안내만(입력 ${inputs}개)`);
    },
  },
  {
    name: "두 패널에서 연 서랍이 서로 다른 항목을 바꿔도 상대가 바꾼 값을 덮지 않는다",
    async run(h) {
      await h.settings({ autoApprove: true, showThinking: false });
      const other = await h.ctx.newPage();
      await other.goto(`chrome-extension://${h.extId}/src/sidepanel/index.html`);
      await other.waitForTimeout(500);
      await openDrawer(h);
      await other.locator("button.icon-btn[title]", { hasText: "⚙" }).click();
      await other.waitForTimeout(300);
      // A: 실행 방식을 '모든 동작에 승인'으로
      await h.panel.locator("details.settings-group summary", { hasText: "동작" }).click();
      await h.panel.locator("input[name=run-mode][value=ask]").check();
      await h.panel.waitForTimeout(400);
      // B(열 때 자동 실행 방식이던 서랍): 생각 보기만 켜기
      await other.locator("details.settings-group summary", { hasText: "고급" }).click();
      await other.locator(".field", { hasText: "생각 과정 보기" }).locator("input[type=checkbox]").first().check();
      await other.waitForTimeout(400);
      const st = await stored(h);
      await other.close();
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
    name: "직접 조작할 사이트는 항목 하나씩 저장한다(#127): 두 서랍에서 따로 넣어도 둘 다 남고, 뺀 사이트는 다른 서랍의 추가로 되살아나지 않는다",
    async run(h) {
      await h.settings({ manualSites: [] });
      const other = await h.ctx.newPage();
      await other.goto(`chrome-extension://${h.extId}/src/sidepanel/index.html`);
      await other.waitForTimeout(500);
      await openDrawer(h);
      await other.locator("button.icon-btn[title]", { hasText: "⚙" }).click();
      await other.waitForTimeout(300);
      const field = (p) => p.locator(".field", { hasText: "직접 조작할 사이트" });
      const addSite = async (p, site) => {
        await field(p).locator("input[type=text]").fill(site);
        await field(p).locator("button", { hasText: "추가" }).click();
        await p.waitForTimeout(400);
      };
      for (const p of [h.panel, other]) await p.locator("details.settings-group summary", { hasText: "동작" }).click();
      await addSite(h.panel, "a.example");
      await addSite(other, "b.example");
      let st = await stored(h);
      expect(JSON.stringify(st.manualSites) === JSON.stringify(["https://a.example", "https://b.example"]), `둘 다(${JSON.stringify(st.manualSites)})`);
      await field(h.panel).locator(".key-row", { hasText: "https://a.example" }).locator("button", { hasText: "빼기" }).click();
      await h.panel.waitForTimeout(300);
      await addSite(other, "c.example");
      st = await stored(h);
      await other.close();
      expect(JSON.stringify(st.manualSites) === JSON.stringify(["https://b.example", "https://c.example"]), `뺀 사이트가 되살아나지 않음(${JSON.stringify(st.manualSites)})`);
      // 화면 밖(content script 등)에서 보낸 것처럼 잘못된 값은 받지 않는다.
      const bad = await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "manual_site_op", op: { op: "add", site: "https://x.example/path" } }));
      expect(bad?.ok === false && (await stored(h)).manualSites.length === 2, `잘못된 값 거절(${JSON.stringify(bad)})`);
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
      await openDrawer(h);
      await h.panel.locator("details.settings-group summary", { hasText: "자동 로그인" }).click();
      const row = h.panel.locator(".key-row", { hasText: O });
      // 저장된 값을 따라가는 칸이라 저장이 끝난 뒤에 바뀐다(check()는 바로 바뀌기를 기대한다).
      await row.locator("input[type=checkbox]").click();
      await h.panel.waitForTimeout(400);
      expect((await stored(h)).loginSites[0].totp === true, "코드 켜기");
      // 다른 곳에서 지웠다가 같은 항목으로 다시 승인(새 식별자, 코드 꺼짐) — 옛 식별자로 온 변경은 거절된다.
      await h.settings({ loginSites: [{ origin: O, uuid: UUID, entryName: "Harness", totp: false, grantId: "BBBBBBBBBBBBBBBBBBBBBB" }] });
      const late = await h.panel.evaluate(
        ({ O, first }) => chrome.runtime.sendMessage({ kind: "login_site_op", op: { op: "set_totp", origin: O, grantId: first, totp: true } }),
        { O, first },
      );
      const st = (await stored(h)).loginSites;
      expect(late?.ok === false && st.length === 1 && st[0].totp === false, `옛 변경 거절(${JSON.stringify({ late, st })})`);
      await h.panel.waitForTimeout(300);
      await row.locator("button", { hasText: "빼기" }).click();
      await h.panel.waitForTimeout(400);
      expect((await stored(h)).loginSites.length === 0, "지금 승인으로 빼기");
    },
  },
];
