// 평소 문구(#130): 카드의 쉬운 도구 이름, 사용자가 취소한 호출은 실패와 구분, 모델 제공자 오류는 원인·다음 행동·원문(자세히).
import { expect } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };

export default [
  {
    name: "카드는 쉬운 도구 이름을 보이고, 취소한 호출은 '실행 안 함'으로 실패와 구분한다",
    async run(h) {
      let badge = "";
      await h.turn([findC, { click: "적용" }, { text: "알겠습니다." }], {
        onCard: async (card) => {
          badge = await card.locator(".tool-card-badge").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(badge === "누르기", `카드 이름(${badge})`);
      const result = h.panel.locator(".tool-result").last();
      expect(await result.evaluate((el) => el.classList.contains("tool-cancelled") && !el.classList.contains("tool-failed")), "취소 표시");
      expect((await result.locator(".tool-card-title").innerText()).includes("실행 안 함"), "제목");
    },
  },
  {
    name: "제공자 401 오류: 키 확인 안내와 설정 열기 버튼, 원문은 자세히에",
    async run(h) {
      await h.sw.evaluate(() => {
        globalThis.__realMockFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) =>
          /openrouter\.ai/.test(String(url))
            ? new Response(JSON.stringify({ error: { message: "No auth credentials found", code: 401 } }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            : globalThis.__realMockFetch(url, init);
      });
      try {
        await h.turn([{ text: "끝" }], { maxWaitMs: 3000 });
        const bubble = h.panel.locator(".bubble-error").last();
        const text = await bubble.innerText();
        expect(text.includes("API 키가 맞지 않거나"), `원인 안내(${text})`);
        expect((await bubble.locator(".error-detail").textContent()).includes("No auth credentials found"), "원문은 자세히에");
        await bubble.getByRole("button", { name: "설정 열기" }).click();
        await h.panel.waitForTimeout(300);
        expect((await h.panel.locator(".drawer").count()) === 1, "설정이 열려야 한다");
      } finally {
        await h.sw.evaluate(() => {
          globalThis.fetch = globalThis.__realMockFetch;
        });
      }
    },
  },
];
