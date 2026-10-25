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
  {
    name: "옵션 페이지에서 저장해도 사이드 패널에서 고른 제공자·키를 덮어쓰지 않는다",
    async run(h) {
      const opt = await h.ctx.newPage();
      await opt.goto(`chrome-extension://${h.extId}/src/options/index.html`);
      await opt.waitForTimeout(500);
      // 옵션 페이지를 연 뒤 다른 곳(사이드 패널)에서 OpenAI로 바꾼다.
      await h.settings({ provider: "openai", apiKeys: { openai: "sk-test-openai" } });
      await opt.locator("button.primary").first().click();
      await opt.waitForTimeout(400);
      const st = await h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
      await opt.close();
      expect(st.provider === "openai" && st.apiKeys?.openai === "sk-test-openai", `유지(${JSON.stringify({ provider: st.provider, apiKeys: st.apiKeys })})`);
    },
  },
  {
    name: "열어 둔 옵션 페이지가 제공자 변경을 따라가 안내하고 OpenRouter 연결 테스트를 막는다",
    async run(h) {
      await h.settings({ openRouterApiKey: "sk-or-test-dummy" });
      const opt = await h.ctx.newPage();
      await opt.goto(`chrome-extension://${h.extId}/src/options/index.html`);
      await opt.waitForTimeout(500);
      const testBtn = opt.locator("button", { hasText: "연결 테스트" });
      const enabledBefore = await testBtn.isEnabled().catch(() => null);
      await h.settings({ provider: "openai", apiKeys: { openai: "sk-test-openai" } });
      await opt.waitForTimeout(400);
      const notice = (await opt.locator("body").innerText()).includes("지금 모델 제공자는 OpenAI");
      const enabledAfter = await testBtn.isEnabled().catch(() => null);
      await opt.close();
      expect(enabledBefore === true, `처음엔 테스트 가능(${enabledBefore})`);
      expect(notice && enabledAfter === false, `바뀐 뒤 안내·버튼 막힘(notice=${notice}, enabled=${enabledAfter})`);
    },
  },
  {
    name: "Gemini 제공자: 호환 엔드포인트로, 도구 호출의 thought_signature를 다음 요청에 돌려준다",
    async run(h) {
      await h.settings({ provider: "gemini", apiKeys: { gemini: "AIza-test" } });
      const sig = { google: { thought_signature: "sig-123" } };
      const r = await h.turn([{ tool: "describe_page", args: {}, extra: sig }, { text: "끝" }]);
      okResult(r, "describe_page");
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs);
      expect(reqs.length === 2 && reqs.every((q) => q.url === "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"), `엔드포인트(${reqs.map((q) => q.url).join(", ")})`);
      const b = reqs[1].body;
      expect(b.model === "gemini-3.6-flash" && b.reasoning_effort === "medium" && b.max_tokens > 0, `형식(${JSON.stringify({ ...b, messages: undefined, tools: undefined })})`);
      expect(!("parallel_tool_calls" in b) && !("reasoning" in b), "보내지 않는 필드");
      const call = b.messages.flatMap((m) => m.tool_calls ?? [])[0];
      expect(JSON.stringify(call?.extra_content) === JSON.stringify(sig), `서명 돌려줌(${JSON.stringify(call)})`);
    },
  },
  {
    name: "Claude 제공자: Messages API 형식·헤더, 도구 왕복, 생각 블록과 서명을 다음 요청에 돌려준다",
    async run(h) {
      await h.settings({ provider: "anthropic", apiKeys: { anthropic: "sk-ant-test" } });
      const r = await h.turn([{ tool: "describe_page", args: {}, thinking: "페이지를 먼저 본다" }, { text: "끝" }]);
      okResult(r, "describe_page");
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs);
      expect(reqs.length === 2 && reqs.every((q) => q.url === "https://api.anthropic.com/v1/messages"), `엔드포인트(${reqs.map((q) => q.url).join(", ")})`);
      const hd = reqs[0].headers ?? {};
      expect(hd["x-api-key"] === "sk-ant-test" && hd["anthropic-version"] && hd["anthropic-dangerous-direct-browser-access"] === "true" && !hd.Authorization, `헤더(${Object.keys(hd).join(",")})`);
      const b = reqs[1].body;
      expect(typeof b.system === "string" && b.system.length > 0 && b.messages.every((m) => m.role !== "system"), "system 필드");
      expect(b.tools?.[0]?.input_schema && b.tool_choice?.type === "auto" && b.tool_choice.disable_parallel_tool_use === true, `도구 형식(${JSON.stringify(b.tool_choice)})`);
      expect(b.thinking?.type === "adaptive" && b.output_config?.effort === "medium" && !("temperature" in b), `생각(${JSON.stringify(b.thinking)})`);
      // 기록은 덧붙이기만: 두 번째 요청의 첫 메시지(사용자 요청 + 그때 붙인 현재 시각 안내)가 첫 요청과 같다.
      expect(JSON.stringify(b.messages[0]) === JSON.stringify(reqs[0].body.messages[0]), "앞 문맥 그대로");
      expect(reqs[0].body.messages[0].content.some((c) => c.type === "text" && c.text.includes("현재 시각")), "첫 요청의 현재 시각 안내가 기록에 남음");
      const asst = b.messages.find((m) => m.role === "assistant");
      expect(asst?.content?.[0]?.type === "thinking" && asst.content[0].signature === "sig-10" && asst.content[1]?.type === "tool_use", `생각·도구 블록(${JSON.stringify(asst?.content).slice(0, 300)})`);
      const res = b.messages.flatMap((m) => m.content).find((c) => c.type === "tool_result");
      expect(res && res.tool_use_id === asst.content[1].id, "tool_result 짝");
      const roles = b.messages.map((m) => m.role).join(",");
      expect(!/user,user|assistant,assistant/.test(roles), `역할 번갈음(${roles})`);
    },
  },
  {
    name: "Claude: 대화에 보낸 저장 링크 후보를 지우면 멈추고 다음 요청은 새 대화로(기록에서 거둘 수 없음)",
    async run(h) {
      await h.settings({ provider: "anthropic", apiKeys: { anthropic: "sk-ant-test" } });
      await h.sw.evaluate(async () => {
        await chrome.storage.local.set({ savedPages: [{ name: "주문 조회", url: "https://shop.example/orders", site: "https://shop.example", savedAt: 1, uses: 0 }] });
      });
      await h.turn([{ text: "첫 답" }], { text: "첫 요청" });
      const first = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1).body);
      const hasCand = (b) => JSON.stringify(b.messages).includes("저장한 링크 후보 데이터");
      expect(hasCand(first), "첫 요청에 후보");
      await h.sw.evaluate(async () => {
        await chrome.storage.local.set({ savedPages: [] });
        globalThis.__modelReqs = [];
      });
      await h.turn([{ text: "보내면 안 됨" }], { noReload: true, text: "둘째 요청" });
      const second = await h.sw.evaluate(() => globalThis.__modelReqs);
      const text = await h.panel.locator("body").innerText();
      expect(second.length === 0 && text.includes("새 대화로 시작합니다"), `둘째 요청은 보내지 않음(${second.length})`);
      await h.turn([{ text: "새 대화 답" }], { noReload: true, text: "셋째 요청" });
      const third = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1).body);
      expect(!hasCand(third) && third.messages.length === 1, `새 대화(${third.messages.length}개, 후보 ${hasCand(third)})`);
    },
  },
];
