// 손 넘기기(0.2.2): '직접 조작할 사이트'에서는 확장이 누르지 않고 대상을 표시해 사용자가 직접 하게 한다.
import { expect, lastTool, okResult } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };
const page = `<title>H</title><main><label>출발지 <input id=dep name=dep></label>
<button id=b style="width:160px;height:50px" onclick="document.getElementById('out').textContent='눌림 '+event.isTrusted">조회하기</button><p id=out></p></main>`;

export default [
  {
    name: "클릭: 확장은 누르지 않고, 사용자가 표시된 대상을 누르면 이어 간다",
    pages: { "/h": page },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      let outAtCard = null;
      const r = await h.turn([findC, { click: "조회하기" }], {
        path: "/h",
        onCard: async (_card, n) => {
          // 사용자가 누른 뒤 손 넘기기가 끝날 때까지 카드가 잠깐 남아 있다. 처음 뜬 카드에서만 확인하고 누른다.
          if (n > 1) return;
          await h.tab.waitForTimeout(400);
          outAtCard = await h.tab.locator("#out").innerText();
          await h.tab.locator("#b").click();
        },
      });
      expect(outAtCard === "", `카드가 뜬 동안 확장이 누르면 안 된다(out='${outAtCard}')`);
      expect(r.out === "눌림 true", `사용자 클릭(out='${r.out}')`);
      const res = okResult(r, "click_element");
      expect(res?.handedOff === true && res.outcome === "clicked", `결과 outcome=clicked(${JSON.stringify(res)})`);
    },
  },
  {
    name: "칸 채우기: 값을 넣지 않고 사용자가 '했어요'로 이어 간다",
    pages: { "/h": page },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      let valueAtCard = null;
      const r = await h.turn([{ tool: "find_form_fields", args: {} }, { fill: "출발지", value: "서울" }], {
        path: "/h",
        onCard: async (card, n) => {
          if (n > 1) return;
          await h.tab.waitForTimeout(300);
          valueAtCard = await h.tab.locator("#dep").inputValue();
          await h.tab.locator("#dep").fill("서울");
          await card.locator(".btn-approve").click();
        },
      });
      expect(valueAtCard === "", `확장이 값을 넣으면 안 된다('${valueAtCard}')`);
      const res = okResult(r, "fill_form_fields");
      expect(res?.handedOff === true && res.outcome === "confirmed", `결과 outcome=confirmed(${JSON.stringify(res)})`);
    },
  },
  {
    name: "취소하면 실행하지 않는다",
    pages: { "/h": page },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      let cancelled = false;
      const r = await h.turn([findC, { click: "조회하기" }], {
        path: "/h",
        onCard: async (card, n) => {
          if (n > 1) return;
          await card.locator(".btn-cancel").click();
          cancelled = true;
        },
      });
      expect(cancelled, "손 넘기기 카드가 떠서 취소를 눌러야 한다");
      expect(r.out === "", `눌리면 안 된다(out='${r.out}')`);
      const t = lastTool(r, "click_element");
      expect(!t?.result && t?.error === "user_cancelled", `취소 오류 결과(${JSON.stringify(t)})`);
    },
  },
  {
    name: "사용자가 누른 대상이 팝업 창을 열면 그 창을 따라간다(#81)",
    pages: {
      "/hp": `<title>예매</title><main><button id=open style="width:160px;height:50px" onclick="window.open('/cal','cal','popup,width=420,height=320')">달력 열기</button><p id=out></p></main>`,
      "/cal": `<title>달력</title><main><button>10월 25일</button></main>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      const r = await h.turn([findC, { click: "달력 열기" }, findC, { text: "끝" }], {
        path: "/hp",
        onCard: async (_card, n) => {
          if (n > 1) return;
          await h.tab.waitForTimeout(300);
          await h.tab.locator("#open").click();
        },
      });
      const res = lastTool(r, "click_element")?.result;
      expect(res?.outcome === "clicked" && /팝업/.test(res.note ?? ""), `결과에 팝업 안내(${JSON.stringify(res)})`);
      const found = okResult(r, "find_clickables");
      expect(found.some((c) => c.text === "10월 25일"), `다음 도구는 팝업 창에서(${JSON.stringify(found)})`);
    },
  },
  {
    name: "팝업 없이 끝난 손 넘기기는 원래 탭에 그대로",
    pages: { "/h": page },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      const r = await h.turn([findC, { click: "조회하기" }, findC, { text: "끝" }], {
        path: "/h",
        onCard: async (_card, n) => {
          if (n > 1) return;
          await h.tab.waitForTimeout(300);
          await h.tab.locator("#b").click();
        },
      });
      const res = lastTool(r, "click_element")?.result;
      expect(res?.outcome === "clicked" && !/팝업/.test(res.note ?? ""), `팝업 안내 없음(${JSON.stringify(res)})`);
      const found = okResult(r, "find_clickables");
      expect(found.some((c) => c.text === "조회하기"), `원래 탭(${JSON.stringify(found)})`);
    },
  },
];
