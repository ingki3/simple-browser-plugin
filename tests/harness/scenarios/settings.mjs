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
      expect(groups.join(",") === "시작하기:true,동작:false,기억·기록:false,연결:false,고급:false", `묶음(${groups.join(",")})`);
      expect((await h.panel.locator(".drawer-footer").count()) === 0, "저장·취소 버튼 없음");
      await h.panel.locator("details.settings-group summary", { hasText: "동작" }).click();
      await h.panel.locator(".field", { hasText: "자동 실행" }).locator("input[type=checkbox]").first().check();
      await h.panel.waitForTimeout(300);
      expect((await stored(h)).autoApprove === true, "자동 실행이 바로 저장됨");
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
];
