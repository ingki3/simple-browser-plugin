// ChatAgent 분리(#263) 단계 0: 분리할 경로 중 기존 시나리오가 덮지 못하던 것 — 요청별 읽기 한도, 깨진 도구 인자, 한도 카드 "계속",
// 길이 한도 재시도·잘림 안내, 팝업 창을 따라가는 턴의 머리말. 모두 제품 코드(src/background/agent/chatAgent.ts) 동작을 그대로 고정한다.
import { expect, findC, okResult } from "../lib.mjs";

const PAGE = `<title>가게</title><main><button>주문</button><p id=out></p></main>`;
const describe = { tool: "describe_page", args: {} };
const reqs = (h) => h.sw.evaluate(() => globalThis.__modelReqs ?? []);
// 에이전트 요청(도구가 실린 것)만 — 저장 카드 초안·번역 요청은 뺀다.
const agentReqs = (list) => list.filter((q) => Array.isArray(q.body.tools) && q.body.tools.length);
const panelText = (h) => h.panel.locator("body").innerText();
// 마지막 요청 기록에 실린 그 도구의 결과(모델에 간 그대로, 호출 순서) — 한 응답의 여러 호출을 모두 본다(__toolLog는 요청마다 마지막 결과 하나만).
const sentResults = async (h, name) => {
  const last = (await reqs(h)).at(-1)?.body;
  return (last?.messages ?? []).filter((m) => m.role === "tool" && m.name === name).map((m) => JSON.parse(m.content));
};
// 카드가 뜨면 취소한다(읽기 도구가 묻는 카드 — 한도를 세는 데에는 실행 여부가 상관없다).
const cancelCards = async (card) => {
  await card.locator(".btn-cancel").first().click();
};

// 이 탭·패널 밖의 탭·창을 닫는다(팝업 창이 다음 시나리오에 남지 않게).
async function closeExtraTabs(h) {
  for (const p of h.ctx.pages()) if (p !== h.tab && p !== h.panel) await p.close().catch(() => {});
  await h.tab.bringToFront();
}

export default [
  {
    name: "한 요청에서 다른 탭 읽기는 2번, 파일 읽기는 5번까지(넘는 호출은 한도 오류 결과)",
    pages: { "/p": PAGE },
    async run(h) {
      const tabs = Array.from({ length: 3 }, (_, i) => ({ tool: "read_other_tabs", args: { purpose: `참고 ${i + 1}` } }));
      await h.turn([{ calls: tabs }, { text: "끝" }], { path: "/p", onCard: cancelCards });
      const tabRes = await sentResults(h, "read_other_tabs");
      expect(tabRes.length === 3, `다른 탭 읽기 결과 3개(${tabRes.length})`);
      const tabLimit = (t) => String(t.error ?? "").includes("한 요청에서 다른 탭 읽기는 최대 2번입니다");
      expect(!tabLimit(tabRes[0]) && !tabLimit(tabRes[1]) && tabLimit(tabRes[2]), `셋째만 한도 오류(${JSON.stringify(tabRes.map((t) => t.error ?? "ok"))})`);

      const docs = Array.from({ length: 6 }, (_, i) => ({ tool: "read_document", args: { url: `${h.base}/files/doc${i + 1}.pdf` } }));
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.turn([{ calls: docs }, { text: "끝" }], { path: "/p", onCard: cancelCards });
      const docRes = await sentResults(h, "read_document");
      expect(docRes.length === 6, `파일 읽기 결과 6개(${docRes.length})`);
      const docLimit = (t) => String(t.error ?? "").includes("한 요청에서 파일은 최대 5개까지 읽을 수 있습니다");
      expect(docRes.slice(0, 5).every((t) => !docLimit(t)) && docLimit(docRes[5]), `여섯째만 한도 오류(${JSON.stringify(docRes.map((t) => t.error ?? "ok"))})`);
      // 한도 오류는 실행 전에 막는다 — 여섯째 파일은 서버에 요청하지 않는다.
      expect(!h.hits.some((x) => x.includes("/files/doc6.pdf")), `여섯째 파일은 요청하지 않음(${h.hits.filter((x) => x.includes("/files/")).join(",")})`);
    },
  },
  {
    name: "인자가 깨진 호출은 실패 결과로 돌려주고 턴을 잇는다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([{ tool: "describe_page", rawArgs: "{" }, describe, { text: "끝냄" }], { path: "/p" });
      const res = r.tools.filter((t) => t.name === "describe_page");
      expect(res.length === 2, `describe_page 결과 2개(${res.length})`);
      expect(res[0].error && res[0].result === undefined && /JSON/i.test(String(res[0].error)), `깨진 인자는 해석 오류 결과(${JSON.stringify(res[0])})`);
      expect(!res[1].error && res[1].result !== undefined, `다음 호출은 실행(${JSON.stringify(res[1]).slice(0, 200)})`);
      const list = agentReqs(await reqs(h));
      expect(list.length === 3, `요청 3번 — 깨진 호출 뒤에도 이어 감(${list.length})`);
      expect((await panelText(h)).includes("끝냄"), "최종 답");
    },
  },
  {
    name: "한도 카드에서 계속하면 설정 한도만큼 더 진행한다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ autoApprove: true, maxToolHops: 2, maxToolHopsVersion: 2 });
      // 같은 호출이 되풀이되면 헛돌기로 멈추므로 두 도구를 번갈아 부른다.
      const steps = Array.from({ length: 8 }, (_, i) => (i % 2 ? findC : describe));
      const seen = [];
      const r = await h.turn(steps, {
        path: "/p",
        onCard: async (card, n) => {
          const txt = await card.innerText();
          seen.push(txt);
          // 첫 카드는 계속, 둘째 카드는 그만두기.
          await card.locator(n === 1 ? ".btn-approve" : ".btn-cancel").click();
        },
      });
      expect(r.cards === 2, `한도 카드 2번(${r.cards})`);
      const ran = r.tools.filter((t) => t.name === "describe_page" || t.name === "find_clickables");
      expect(ran.length === 4, `도구 4번(한도 2 + 계속 2)(${ran.length}: ${ran.map((t) => t.name).join(",")})`);
      const list = agentReqs(await reqs(h));
      const last = list.at(-1)?.body;
      expect(list.length === 5 && last?.tool_choice === "none", `도구 요청 4번 + 마무리 1번(${list.length}, ${JSON.stringify(last?.tool_choice)})`);
    },
  },
  {
    name: "길이 재시도가 또 빈 답이면 오류로 끝낸다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.turn([{ lengthEmpty: true }, { lengthEmpty: true }, { text: "보내면 안 됨" }], { path: "/p" });
      const list = agentReqs(await reqs(h));
      expect(list.length === 2, `요청 2번(처음 + 재시도 1번)(${list.length})`);
      const text = await panelText(h);
      expect(text.includes("모델이 생각만 하다 응답 길이 한도에 걸려 답을 만들지 못했습니다"), `오류 안내(${text.slice(-300)})`);
      expect(!text.includes("보내면 안 됨"), "셋째 요청 없음");
    },
  },
  {
    name: "글이 있는 채로 길이 한도에 걸리면 답을 두고 잘림 안내를 붙인다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.turn([{ lengthText: "앞부분까지 쓴 답" }, { text: "보내면 안 됨" }], { path: "/p" });
      const list = agentReqs(await reqs(h));
      expect(list.length === 1, `재시도하지 않음(${list.length})`);
      const text = await panelText(h);
      expect(text.includes("앞부분까지 쓴 답"), "받은 글은 보인다");
      expect(text.includes("답이 응답 길이 한도에서 잘렸습니다"), `잘림 안내(${text.slice(-300)})`);
    },
  },
  {
    name: "팝업 창을 따라가는 중이면 다음 요청의 머리말에 그 안내가 붙는다",
    pages: {
      "/pp": `<title>예매</title><main><button onclick="window.open('/cal','cal','popup,width=420,height=320')">달력 열기</button><p id=out></p></main>`,
      "/cal": `<title>달력</title><main><button>10월 25일</button></main>`,
    },
    async run(h) {
      await closeExtraTabs(h);
      await h.settings({ autoApprove: true });
      const NOTE = "[팝업 창을 따라가는 중";
      const userTexts = (q) => JSON.stringify((q?.body?.messages ?? []).filter((m) => m.role === "user"));
      try {
        const r = await h.turn([findC, { click: "달력 열기" }, { text: "열었습니다" }], { path: "/pp", text: "달력 열어 줘" });
        const click = okResult(r, "click_element");
        expect(click.effect?.popup?.opened?.followed, `팝업 창을 따라감(${JSON.stringify(click.effect?.popup)})`);
        const first = agentReqs(await reqs(h))[0];
        expect(first && !userTexts(first).includes(NOTE), "따라가기 전 요청에는 안내 없음");
        await h.sw.evaluate(() => {
          globalThis.__modelReqs = [];
        });
        await h.turn([{ text: "날짜 봤습니다" }], { noReload: true, text: "날짜 골라 줘" });
        // 둘째 요청의 사용자 글(현재 시각 안내 앞, 요청 글이 든 것)의 탭 머리말 — 앞 턴 글에는 안내가 없었다(위에서 확인).
        const second = agentReqs(await reqs(h))[0];
        const asked = (second?.body?.messages ?? []).filter((m) => m.role === "user" && JSON.stringify(m.content).includes("날짜 골라 줘"));
        const s = JSON.stringify(asked);
        expect(asked.length === 1 && s.includes(NOTE) && s.includes("제목: 달력"), `둘째 요청 머리말에 팝업 안내(${s.slice(0, 600)})`);
      } finally {
        await closeExtraTabs(h);
      }
    },
  },
];
