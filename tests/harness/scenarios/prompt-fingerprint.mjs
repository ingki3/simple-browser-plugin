// ChatAgent 분리(#263) 단계 1의 진단: 시스템 지침·원격 안내 문구를 src/background/agent/prompts.ts로 옮겨도 모델에 가는 글이
// 한 글자도 바뀌지 않는지 SHA-256으로 본다. 기대값은 옮기기 전 dist(dev 27d2919)에서 뽑아 아래 EXPECTED에 적었다.
// 지침·안내 문구를 일부러 고치면 이 값도 함께 고친다 — 값을 다시 뽑으려면 HARNESS_PRINT_FINGERPRINTS=1로 돌려 출력된 값을 옮긴다.
// #297 2단계: describe_page 결과 읽는 법에 pathHints 줄을 더해 system 값(과 tests/agentPrompts.test.mjs의 스냅숏)을 고쳤다.
//
// 해시 대상과 정규화 규칙:
// - system: 그 턴 첫 에이전트 요청의 messages[0].content(시스템 지침 — composeSystemPrompt). 날짜·시각 안내(nowNote)는 요청 끝의
//   다른 메시지라 여기 섞이지 않는다. 정규화 없음.
// - remote: 그 턴 첫 에이전트 요청에서 "요청: <요청 글>"이 든 사용자 메시지. 앞의 탭 머리말(시험 서버 주소·포트·제목이 실림)은
//   구조 경계 "[사용자 요청]\n" 뒤만 남겨 뺀다(머리말이 없으면 글 전체). 남는 것은 원격 안내(remoteTurnNote) + "\n\n요청: " + 요청 글.
// - task: 그 요청에서 "실행 방식:"으로 시작하는 사용자 메시지(TASK_MODE_NOTE). 정규화 없음.
// - 공통: 시험 서버 주소(http://127.0.0.1:<포트>, http://localhost:<포트>)가 섞이면 "<ORIGIN>"으로 바꾼 뒤 해시한다(포트가 실행마다 다름).
//   지금 조합은 그런 주소가 들어가지 않게 골랐다(원격 허용 사이트는 고정 주소 https://example.com).
// 만들 수 있는 조합만: 하네스 빌드에는 OAuth 클라이언트 ID가 없어 Google 지침은 늘 빠진다(있음 쪽은 tests/agentPrompts.test.mjs).
import { createHash } from "node:crypto";
import { ask, expect, waitUntil } from "../lib.mjs";
import { connect as tgConnect, deliver as tgDeliver, replies as tgReplies } from "./telegram.mjs";
import { askReady } from "./mcp.mjs";

const PRINT = !!process.env.HARNESS_PRINT_FINGERPRINTS;
const PAGE = `<title>가게</title><main><button>주문</button><p id=out></p></main>`;
const REMOTE_SITE = "https://example.com";
const CUSTOM = "시험용 사용자 지침: 답은 존댓말로 짧게.";

const EXPECTED = {
  "panel system 기본": "5fdde95d928283b9a64f38cadae4697e806124058e69fbe88c43b25bcce00b66",
  "panel system 빠르게 생각": "00ca1fa241ade641b1ec4ab472422841736978e455dcf0f3a9ef9eb1082b2f3d",
  "panel system 사용자 지침": "6771ded3f4f774de578d6100a8d93d9a55b47a726c9e5e6a5a37086f10d250d7",
  "panel system 빠르게 생각+사용자 지침": "cf6f4453409203bf47eef6ee787668b7bfd4b38ffe61710e284b5b6c3b594743",
  "panel task 실행 방식 task": "005077764e71dffdebd5bbe7080c10908d6da03e06479ff4fa7e00cc96a3c4ec",
  "telegram system": "5fdde95d928283b9a64f38cadae4697e806124058e69fbe88c43b25bcce00b66",
  "telegram remote 물음·사이트 없음": "5b2053387f0352cbc9d12a77f2cdee3b1e12007de4538e50fa5cffb760507896",
  "telegram remote 물음·허용 사이트": "b854635168e5b6504a758ce3e10640600efae6ef725455e2153173f50ebf5a58",
  "telegram task 물음": "005077764e71dffdebd5bbe7080c10908d6da03e06479ff4fa7e00cc96a3c4ec",
  "telegram remote 안 물음·적은 사이트": "4a549a5193436df4abfc8df4d96ead6a4e64aa55eef706f87d7df4bdc9a30aad",
  "telegram remote 안 물음·사이트 없음": "c34ad2a03be90d1dd2dce38dabdfd483ebf945ac438f241cdff41747883be72b",
  "telegram remote 안 물음·허용 사이트": "1e57b4f4f1c1759d9bc4247337b02098f969eb165a77e80dbdfacb4dfc7ae8ed",
  "telegram remote 안 물음·적은 사이트+허용 사이트": "78ced2185c67d101a409d0a31ec31597df1600799090cb6dcd15be0bcd735576",
  "mcp system": "5fdde95d928283b9a64f38cadae4697e806124058e69fbe88c43b25bcce00b66",
  "mcp remote 물음·사이트 없음": "37599ab9fba155d92a7f5dc88e20b41d0a1c63c84fa878aafad4dedfb2b02841",
  "mcp remote 물음·적은 사이트": "22c0ecf0afa95ddfece2bbff48dd7d67c5d77512ab33107c1e1fe170f924782c",
  "mcp remote 물음·허용 사이트": "0798b10b7190fdf4bbe1b010e59d28c09f6b1a15ccd579fbcb4b1a2ea405b763",
  "mcp remote 안 물음·사이트 없음": "ccfd074024df1fd0b1d623136a7138be29e5f06257df337e18a19ab0e0fbc3a4",
  "mcp remote 안 물음·적은 사이트": "0793ebda90ab2862dcc377b5acb9fd1cec072560d3a13f7e8a0d2e083e0572cd",
  "mcp remote 안 물음·허용 사이트": "1bd4f089b6bea187922f1eda8ae66b37076779dbd91eef3ba0f826e3131b75f3",
};

const normalize = (s) => s.replace(/http:\/\/(127\.0\.0\.1|localhost):\d+/g, "<ORIGIN>");
const sha = (s) => createHash("sha256").update(normalize(s), "utf8").digest("hex");
const text = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));

const clearReqs = (h) => h.sw.evaluate(() => { globalThis.__modelReqs = []; });
// 이번 턴의 첫 에이전트 요청(도구가 실린 것 — 저장 카드 초안·번역 요청은 뺀다).
const firstAgentReq = (h) =>
  h.sw.evaluate(() => (globalThis.__modelReqs ?? []).find((q) => Array.isArray(q.body?.tools) && q.body.tools.length)?.body ?? null);

// 한 요청 본문에서 해시할 글을 뽑는다.
function parts(body, request) {
  const msgs = body?.messages ?? [];
  const sys = msgs[0]?.role === "system" ? text(msgs[0].content) : null;
  const u = request ? msgs.find((m) => m.role === "user" && text(m.content).includes(`요청: ${request}`)) : null;
  let remote = null;
  if (u) {
    const t = text(u.content);
    const i = t.indexOf("[사용자 요청]\n");
    remote = i >= 0 ? t.slice(i + "[사용자 요청]\n".length) : t;
  }
  const task = msgs.find((m) => m.role === "user" && text(m.content).startsWith("실행 방식:"));
  return { sys, remote, task: task ? text(task.content) : null };
}

// 이름별 실제 해시를 모아 두었다가 끝에 한꺼번에 비교한다(어긋난 것을 모두 보이게).
function collector() {
  const got = {};
  return {
    put(name, s) {
      expect(typeof s === "string" && s.length > 0, `${name}: 해시할 글이 없음`);
      got[name] = sha(s);
      if (PRINT) console.log(`    [text] ${name} (${s.length}자): ${JSON.stringify(normalize(s).slice(0, 90))} … ${JSON.stringify(normalize(s).slice(-60))}`);
    },
    check(names) {
      if (PRINT) console.log(`    [fingerprints] ${JSON.stringify(Object.fromEntries(names.map((n) => [n, got[n]])), null, 2)}`);
      const bad = names.filter((n) => got[n] !== EXPECTED[n]);
      expect(!bad.length, `지침·안내 글이 바뀜: ${bad.map((n) => `${n} 기대 ${EXPECTED[n].slice(0, 12)} 실제 ${String(got[n]).slice(0, 12)}`).join("; ")}`);
      return got;
    },
  };
}

export default [
  {
    name: "지침·원격 안내 글이 바뀌지 않는다: 패널(빠르게 생각 켬·끔, 사용자 지침 유무, 실행 방식 task 안내)",
    pages: { "/p": PAGE },
    async run(h) {
      const c = collector();
      const combos = [
        ["panel system 기본", {}],
        ["panel system 빠르게 생각", { quickThinking: true }],
        ["panel system 사용자 지침", { systemPrompt: CUSTOM }],
        ["panel system 빠르게 생각+사용자 지침", { quickThinking: true, systemPrompt: CUSTOM }],
      ];
      for (const [name, patch] of combos) {
        // 새 대화(패널 다시 열기)와 기본 설정에서 시작해 그 조합만 켠다.
        await h.reset();
        if (Object.keys(patch).length) await h.settings(patch);
        await clearReqs(h);
        await h.turn([{ text: "끝" }], { path: "/p", text: "지침 확인" });
        c.put(name, parts(await firstAgentReq(h), null).sys);
      }
      await h.reset();
      await h.settings({ runMode: "task" });
      await clearReqs(h);
      await h.turn([{ text: "끝" }], { path: "/p", text: "실행 방식 확인" });
      const body = await firstAgentReq(h);
      c.put("panel task 실행 방식 task", parts(body, null).task);
      // 실행 방식은 시스템 지침을 바꾸지 않는다.
      c.put("panel system 기본", parts(body, null).sys);
      c.check(combos.map(([n]) => n).concat("panel task 실행 방식 task"));
    },
  },
  {
    name: "지침·원격 안내 글이 바뀌지 않는다: 텔레그램(묻기 켬·끔, 요청 글에 적은 사이트 유무, 원격 허용 사이트 유무)",
    async run(h) {
      const c = collector();
      await tgConnect(h);
      const one = async (request, answer) => {
        await h.sw.evaluate((a) => {
          globalThis.__tg.sent = [];
          globalThis.__modelReqs = [];
          globalThis.__steps = [{ text: a }];
        }, answer);
        await tgDeliver(h, request);
        await waitUntil(async () => (await tgReplies(h)).includes(answer), { timeoutMs: 20_000, intervalMs: 250, label: `텔레그램 답(${request})` });
        return parts(await firstAgentReq(h), request);
      };
      const site = async (op) => expect((await ask(h, { kind: "remote_site_op", op: { op, site: REMOTE_SITE } }))?.ok, `원격 허용 사이트 ${op}`);

      // 묻기 켬(기본) — 실행 방식이 task라 작업 맡기기 안내(REMOTE_TASK_NOTE)와 실행 방식 안내가 붙는다.
      let p = await one("오늘 경제 뉴스 정리해줘", "답1");
      c.put("telegram system", p.sys);
      c.put("telegram remote 물음·사이트 없음", p.remote);
      c.put("telegram task 물음", p.task);
      await site("add");
      p = await one("오늘 날씨 정리해줘", "답2");
      c.put("telegram remote 물음·허용 사이트", p.remote);
      await site("remove");
      expect((await ask(h, { kind: "telegram_set_ask", on: false })).ok, "묻기 끔");
      p = await one("news.naver.com 경제 뉴스 정리해줘", "답3");
      c.put("telegram remote 안 물음·적은 사이트", p.remote);
      p = await one("오늘 스포츠 뉴스 정리해줘", "답4");
      c.put("telegram remote 안 물음·사이트 없음", p.remote);
      await site("add");
      p = await one("오늘 문화 뉴스 정리해줘", "답5");
      c.put("telegram remote 안 물음·허용 사이트", p.remote);
      p = await one("news.naver.com 사회 뉴스 정리해줘", "답6");
      c.put("telegram remote 안 물음·적은 사이트+허용 사이트", p.remote);
      const got = c.check([
        "telegram system",
        "telegram remote 물음·사이트 없음",
        "telegram remote 물음·허용 사이트",
        "telegram task 물음",
        "telegram remote 안 물음·적은 사이트",
        "telegram remote 안 물음·사이트 없음",
        "telegram remote 안 물음·허용 사이트",
        "telegram remote 안 물음·적은 사이트+허용 사이트",
      ]);
      // 텔레그램에서 물을 수 있으면 허용 사이트와 관계없이 같은 안내다(요청 글만 다르므로 해시는 다르다) — 지침은 패널 기본과 같다.
      expect(got["telegram system"] === EXPECTED["panel system 기본"], "텔레그램 지침 = 패널 기본 지침");
    },
  },
  {
    name: "지침·원격 안내 글이 바뀌지 않는다: MCP(묻기 켬·끔, 요청 글에 적은 사이트 유무, 원격 허용 사이트 유무)",
    async run(h) {
      const c = collector();
      const site = async (op) => expect((await ask(h, { kind: "remote_site_op", op: { op, site: REMOTE_SITE } }))?.ok, `원격 허용 사이트 ${op}`);
      let id = 2;
      const one = async (bridge, request, answer) => {
        await h.sw.evaluate((a) => {
          globalThis.__modelReqs = [];
          globalThis.__steps = [{ text: a }];
        }, answer);
        bridge.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_task", arguments: { request } } });
        const res = await bridge.reply(id, 30_000);
        id += 1;
        expect(res?.result?.content?.[0]?.text === answer, `MCP 답(${JSON.stringify(res).slice(0, 200)})`);
        return parts(await firstAgentReq(h), request);
      };
      // 물을 수 있음(elicitation 지원 + 묻기 켬).
      let bridge = await askReady(h);
      try {
        let p = await one(bridge, "오늘 경제 뉴스 정리해줘", "답1");
        c.put("mcp system", p.sys);
        c.put("mcp remote 물음·사이트 없음", p.remote);
        p = await one(bridge, "news.naver.com 경제 뉴스 정리해줘", "답2");
        c.put("mcp remote 물음·적은 사이트", p.remote);
        await site("add");
        p = await one(bridge, "오늘 날씨 정리해줘", "답3");
        c.put("mcp remote 물음·허용 사이트", p.remote);
        await site("remove");
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
      // 물을 수 없음(elicitation 없음, 묻기 끔).
      id = 2;
      bridge = await askReady(h, { askApproval: false, capabilities: {} });
      try {
        let p = await one(bridge, "오늘 스포츠 뉴스 정리해줘", "답4");
        c.put("mcp remote 안 물음·사이트 없음", p.remote);
        p = await one(bridge, "news.naver.com 사회 뉴스 정리해줘", "답5");
        c.put("mcp remote 안 물음·적은 사이트", p.remote);
        await site("add");
        p = await one(bridge, "오늘 문화 뉴스 정리해줘", "답6");
        c.put("mcp remote 안 물음·허용 사이트", p.remote);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
      const got = c.check([
        "mcp system",
        "mcp remote 물음·사이트 없음",
        "mcp remote 물음·적은 사이트",
        "mcp remote 물음·허용 사이트",
        "mcp remote 안 물음·사이트 없음",
        "mcp remote 안 물음·적은 사이트",
        "mcp remote 안 물음·허용 사이트",
      ]);
      expect(got["mcp system"] === EXPECTED["panel system 기본"], "MCP 지침 = 패널 기본 지침");
    },
  },
];
