// 처음 쓸 때(#129): 키가 없으면 첫 화면이 키 안내를 보이고, 보내기는 쓴 글을 남긴 채 설정을 연다.
// 키가 있으면 첫 작업 예시를 눌러 바로 보내고, 설정의 연결 확인은 저장한 키·모델로 짧은 요청을 보낸다.
import { expect } from "../lib.mjs";

const modelReqCount = (h) => h.sw.evaluate(() => (globalThis.__modelReqs ?? []).length);

export default [
  {
    name: "키가 없으면 첫 화면에 키 안내, 보내기는 글을 남기고 설정을 연다",
    async run(h) {
      await h.settings({ openRouterApiKey: "" });
      await h.panel.waitForTimeout(300);
      const welcome = h.panel.locator(".welcome");
      expect((await welcome.innerText()).includes("API 키가 필요합니다"), "키 안내가 보여야 한다");
      expect((await welcome.locator("a", { hasText: "키 발급" }).count()) === 4, "제공자 넷의 키 발급 링크");
      await h.panel.fill("textarea.composer-input", "요약해 줘");
      await h.panel.click("button.composer-btn.primary");
      await h.panel.waitForTimeout(300);
      expect((await h.panel.locator(".drawer").count()) === 1, "설정 서랍이 열려야 한다");
      expect((await h.panel.inputValue("textarea.composer-input")) === "요약해 줘", "쓴 글은 남아야 한다");
      expect((await modelReqCount(h)) === 0, "모델에 보내면 안 된다");
    },
  },
  {
    name: "키가 있으면 첫 작업 예시를 눌러 바로 보낸다",
    async run(h) {
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ text: "요약했습니다." }];
      });
      await h.panel.locator(".welcome-examples button").first().click();
      await h.panel.waitForTimeout(1500);
      const sent = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs?.[0]?.body ?? {}));
      expect(sent.includes("이 페이지 세 줄로 요약해 줘"), "예시 문장을 보내야 한다");
    },
  },
  {
    name: "연결 확인: 저장한 키·모델로 짧은 요청을 보내 결과를 보인다",
    async run(h) {
      await h.settings({ provider: "anthropic", apiKeys: { anthropic: "sk-ant-test" } });
      await h.panel.locator("button.icon-btn[title]", { hasText: "⚙" }).click();
      await h.panel.waitForTimeout(300);
      await h.panel.getByRole("button", { name: "연결 확인" }).click();
      await h.panel.waitForTimeout(1000);
      expect(await h.panel.getByText("✓ 연결됨").count(), "연결됨이 보여야 한다");
      const req = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1));
      expect(req.url.includes("api.anthropic.com") && req.body.max_tokens <= 64, `짧은 요청(${JSON.stringify(req.body)})`);
    },
  },
];
