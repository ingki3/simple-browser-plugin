// 처음 쓸 때(#129): 키가 없으면 첫 화면이 키 안내를 보이고, 보내기는 쓴 글을 남긴 채 설정을 연다.
// 키가 있으면 첫 작업 예시를 눌러 바로 보내고, 설정의 연결 확인은 저장한 키·모델로 짧은 요청을 보낸다.
import { expect } from "../lib.mjs";

const modelReqCount = (h) => h.sw.evaluate(() => (globalThis.__modelReqs ?? []).length);

// 보내는 것 안내(웹 스토어 사용자 데이터 정책): 문장과 개인정보처리방침 링크(새 탭).
async function checkPrivacyNote(h, state) {
  const note = h.panel.locator(".welcome .welcome-privacy");
  expect((await note.count()) === 1, `${state}: 보내는 것 안내가 있어야 한다`);
  const text = await note.innerText();
  expect(text.includes("주소·제목") && text.includes("페이지 내용") && text.includes("반복 작업"), `${state}: 안내 범위(${text})`);
  const link = note.locator("a");
  expect((await link.getAttribute("href"))?.endsWith("/docs/privacy.md"), `${state}: 처리방침 링크`);
  expect((await link.getAttribute("target")) === "_blank", `${state}: 새 탭으로`);
}

export default [
  {
    name: "키가 없으면 첫 화면에 키 안내, 보내기는 글을 남기고 설정을 연다",
    async run(h) {
      await h.settings({ openRouterApiKey: "" });
      await h.panel.waitForTimeout(300);
      const welcome = h.panel.locator(".welcome");
      expect((await welcome.innerText()).includes("API 키가 필요합니다"), "키 안내가 보여야 한다");
      expect((await welcome.locator("a", { hasText: "키 발급" }).count()) === 4, "제공자 넷의 키 발급 링크");
      await checkPrivacyNote(h, "키 없음");
      await h.panel.fill("textarea.composer-input", "요약해 줘");
      await h.panel.click("button.composer-btn.primary");
      await h.panel.waitForTimeout(300);
      expect(await h.waitOptions("model"), "설정 페이지(모델·연결)가 열려야 한다");
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
      await checkPrivacyNote(h, "키 있음");
      await h.panel.locator(".welcome-examples button").first().click();
      await h.panel.waitForTimeout(1500);
      const sent = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs?.[0]?.body ?? {}));
      expect(sent.includes("이 페이지 세 줄로 요약해 줘"), "예시 문장을 보내야 한다");
    },
  },
  {
    name: "낮은 패널에서도 첫 화면의 안내가 잘리지 않는다",
    async run(h) {
      const size = h.panel.viewportSize();
      try {
        await h.settings({ openRouterApiKey: "" });
        await h.panel.setViewportSize({ width: 360, height: 420 });
        await h.panel.waitForTimeout(300);
        const list = h.panel.locator(".message-list.empty");
        await list.evaluate((el) => el.scrollTo(0, 0));
        const listBox = await list.boundingBox();
        const title = await h.panel.locator(".welcome-title").boundingBox();
        const note = await h.panel.locator(".welcome-privacy").boundingBox();
        expect(listBox && title && note, "목록·제목·안내의 위치");
        // 넘칠 때 가운데 정렬이 위쪽을 잘라 스크롤로도 닿지 않던 문제(justify-content: center) 회귀 방지.
        expect(title.y >= listBox.y - 1, `맨 위로 스크롤하면 제목이 보여야 한다(제목 ${title.y}, 목록 ${listBox.y})`);
        expect(note.y >= listBox.y - 1, `안내 위쪽이 잘리면 안 된다(안내 ${note.y}, 목록 ${listBox.y})`);
        await h.panel.locator(".welcome-privacy").scrollIntoViewIfNeeded();
        const seen = await h.panel.locator(".welcome-privacy").boundingBox();
        expect(seen.y >= listBox.y - 1 && seen.y + seen.height <= listBox.y + listBox.height + 1, "안내로 스크롤하면 목록 안에 보여야 한다");
      } finally {
        if (size) await h.panel.setViewportSize(size);
      }
    },
  },
  {
    name: "연결 확인: 저장한 키·모델로 짧은 요청을 보내 결과를 보인다",
    async run(h) {
      await h.settings({ provider: "anthropic", apiKeys: { anthropic: "sk-ant-test" } });
      await h.panel.locator("button.icon-btn[title]", { hasText: "⚙" }).click();
      const opt = await h.waitOptions();
      expect(opt, "설정 페이지");
      await opt.getByRole("button", { name: "연결 확인" }).click();
      await opt.waitForTimeout(1000);
      expect(await opt.getByText("✓ 연결됨").count(), "연결됨이 보여야 한다");
      const req = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1));
      expect(req.url.includes("api.anthropic.com") && req.body.max_tokens <= 64, `짧은 요청(${JSON.stringify(req.body)})`);
    },
  },
];
