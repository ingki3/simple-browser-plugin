// 빠르게 생각(#160): 켜면 모든 요청을 낮은 추론으로, Thought 지침을 한 문장으로. 턴 시작에 고정. 길이 초과 재시도는 한 번.
import { expect, okResult } from "../lib.mjs";

const PAGE = `<title>가게</title><main><button>주문</button><p id=out></p></main>`;
const reqs = (h) => h.sw.evaluate(() => globalThis.__modelReqs ?? []);
const clear = (h) => h.sw.evaluate(() => { globalThis.__modelReqs = []; });
// 에이전트 요청(도구가 실린 것)만.
const agentReqs = (list) => list.filter((q) => Array.isArray(q.body.tools) && q.body.tools.length);
const sysOf = (q) => (typeof q.body.system === "string" ? q.body.system : q.body.messages?.find((m) => m.role === "system")?.content ?? "");

export default [
  {
    name: "꺼져 있으면 기본 추론·전체 Thought 지침, 켜면 낮은 추론·한 문장 지침(OpenRouter)",
    pages: { "/p": PAGE },
    async run(h) {
      await clear(h);
      await h.turn([{ tool: "describe_page", args: {} }, { text: "끝" }], { path: "/p" });
      const off = agentReqs(await reqs(h));
      expect(off.length >= 2 && off.every((q) => JSON.stringify(q.body.reasoning) === JSON.stringify({ max_tokens: 4096 })), `기본 추론(${JSON.stringify(off.map((q) => q.body.reasoning))})`);
      expect(sysOf(off[0]).includes("(a) 관측 결과에 근거한") && !sysOf(off[0]).includes("한 문장으로 말한다(Thought)"), "전체 Thought 지침");
      await h.settings({ quickThinking: true });
      await clear(h);
      await h.turn([{ tool: "describe_page", args: {} }, { text: "끝" }], { path: "/p" });
      const on = agentReqs(await reqs(h));
      expect(on.length >= 2 && on.every((q) => JSON.stringify(q.body.reasoning) === JSON.stringify({ effort: "low" })), `낮은 추론(${JSON.stringify(on.map((q) => q.body.reasoning))})`);
      expect(sysOf(on[0]).includes("한 문장으로 말한다(Thought)") && !sysOf(on[0]).includes("(a) 관측 결과에 근거한"), "짧은 Thought 지침");
    },
  },
  {
    name: "턴 도중 설정을 바꿔도 그 턴은 시작 때 값으로 간다",
    pages: { "/p": PAGE },
    async run(h) {
      await clear(h);
      const turn = h.turn([{ tool: "describe_page", args: {}, delayMs: 800 }, { text: "끝" }], { path: "/p" });
      // 첫 모델 요청이 나간 뒤(턴이 시작된 뒤)에 바꾼다.
      for (let i = 0; i < 50 && !(await reqs(h)).length; i++) await h.tab.waitForTimeout(100);
      await h.settings({ quickThinking: true });
      await turn;
      const list = agentReqs(await reqs(h));
      expect(list.length >= 2 && list.every((q) => JSON.stringify(q.body.reasoning) === JSON.stringify({ max_tokens: 4096 })), `턴 동안 고정(${JSON.stringify(list.map((q) => q.body.reasoning))})`);
    },
  },
  {
    name: "Claude: 켜면 낮은 강도, 길이 초과 뒤 재시도는 한 번(낮은 강도)",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ provider: "anthropic", apiKeys: { anthropic: "sk-ant-test" }, quickThinking: true });
      await clear(h);
      const r = await h.turn([{ lengthEmpty: true }, { tool: "describe_page", args: {} }, { text: "끝" }], { path: "/p" });
      okResult(r, "describe_page");
      const list = agentReqs(await reqs(h));
      expect(list.length === 3, `요청 3번(재시도 1번 포함)(${list.length})`);
      expect(list.every((q) => q.body.output_config?.effort === "low"), `낮은 강도(${JSON.stringify(list.map((q) => q.body.output_config))})`);
    },
  },
  {
    name: "꺼져 있으면 길이 초과 뒤 재시도만 낮은 강도(OpenRouter)",
    pages: { "/p": PAGE },
    async run(h) {
      await clear(h);
      const r = await h.turn([{ lengthEmpty: true }, { tool: "describe_page", args: {} }, { text: "끝" }], { path: "/p" });
      okResult(r, "describe_page");
      const list = agentReqs(await reqs(h));
      const rs = list.map((q) => JSON.stringify(q.body.reasoning));
      expect(list.length === 3 && rs[0] === JSON.stringify({ max_tokens: 4096 }) && rs[1] === JSON.stringify({ effort: "low" }), `재시도만 낮음(${rs.join(" | ")})`);
    },
  },
  {
    name: "켜도 승인은 그대로: 묻기 모드의 클릭은 카드가 뜬다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ quickThinking: true, runMode: "ask" });
      const r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "주문" }], { path: "/p", approve: false });
      expect(r.stoppedAtCard, "승인 카드가 떠야 한다");
    },
  },
  {
    name: "Claude: 대화 도중 바꾸면 다음 요청은 새 대화로(이전 생각 서명을 다른 지침과 보내지 않음)",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ provider: "anthropic", apiKeys: { anthropic: "sk-ant-test" } });
      await h.turn([{ tool: "describe_page", args: {}, thinking: "먼저 본다" }, { text: "끝" }], { path: "/p", text: "첫 요청" });
      await h.settings({ quickThinking: true });
      await clear(h);
      await h.turn([{ text: "둘째 답" }], { noReload: true, text: "둘째 요청" });
      const list = agentReqs(await reqs(h));
      const b = list[0]?.body;
      expect(b && b.messages.length === 1 && !JSON.stringify(b.messages).includes("thinking"), `새 대화(${b?.messages?.length}개)`);
      expect(b.system.includes("한 문장으로 말한다(Thought)"), "새 지침");
    },
  },
];
