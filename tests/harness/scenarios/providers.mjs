// 모델 제공자(#97): 고른 제공자의 엔드포인트·키·요청 형식으로 보낸다.
import { expect, okResult } from "../lib.mjs";

export default [
  {
    name: "OpenAI 제공자: api.openai.com으로, OpenAI 형식(max_completion_tokens·reasoning_effort, 기록의 OpenRouter 필드 제거)",
    async run(h) {
      await h.settings({ provider: "openai", apiKeys: { openai: "sk-test-openai" }, providerModels: { openai: "gpt-5-mini" } });
      const r = await h.turn([{ tool: "describe_page", args: {} }, { text: "끝" }]);
      okResult(r, "describe_page");
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs);
      expect(reqs.length >= 2 && reqs.every((q) => q.url === "https://api.openai.com/v1/chat/completions"), `엔드포인트(${reqs.map((q) => q.url).join(", ")})`);
      const b = reqs[1].body;
      expect(b.model === "gpt-5-mini" && b.max_completion_tokens > 0 && b.reasoning_effort === "medium", `형식(${JSON.stringify({ ...b, messages: undefined, tools: undefined })})`);
      expect(!("reasoning" in b) && !("max_tokens" in b) && !("temperature" in b), "OpenRouter 전용 필드 없음");
      const bad = b.messages.filter((m) => "reasoning" in m || "reasoning_details" in m || (m.role === "tool" && "name" in m));
      expect(bad.length === 0, `기록 정리(${JSON.stringify(bad).slice(0, 200)})`);
    },
  },
  {
    name: "키가 없는 제공자는 요청을 보내지 않고 안내한다",
    async run(h) {
      await h.settings({ provider: "openai", apiKeys: {} });
      await h.turn([{ text: "끝" }]);
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs);
      const text = await h.panel.locator("body").innerText();
      expect(reqs.length === 0, `요청 없음(${reqs.length})`);
      expect(text.includes("OpenAI API 키가 설정되지 않았습니다"), "안내 문구");
    },
  },
  {
    name: "OpenRouter 제공자(기본)는 예전처럼 openrouter.ai로",
    async run(h) {
      const r = await h.turn([{ tool: "describe_page", args: {} }, { text: "끝" }]);
      okResult(r, "describe_page");
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs);
      expect(reqs.every((q) => q.url === "https://openrouter.ai/api/v1/chat/completions") && "reasoning" in reqs[0].body, "OpenRouter 형식");
    },
  },
  {
    name: "턴 도중 제공자를 바꾸면 남은 내용을 어느 제공자로도 보내지 않고 멈춘다",
    async run(h) {
      let before = -1;
      const r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "적용" }, { tool: "describe_page", args: {} }, { text: "끝" }], {
        onCard: async (card, n) => {
          if (n > 1) return;
          await h.settings({ provider: "openai", apiKeys: { openai: "sk-test-openai" } });
          await h.panel.waitForTimeout(200);
          before = (await h.sw.evaluate(() => globalThis.__modelReqs)).length;
          await card.locator(".btn-approve").click();
        },
      });
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs);
      expect(before === 2, `카드 전 요청 2개(${before})`);
      expect(reqs.length === before, `바꾼 뒤 요청 없음(${reqs.map((q) => q.url).join(", ")})`);
      const text = await h.panel.locator("body").innerText();
      expect(text.includes("이 요청을 멈췄습니다"), "멈춤 안내");
      void r;
    },
  },
];
