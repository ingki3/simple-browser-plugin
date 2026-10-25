// 손 넘기기(0.2.2): '직접 조작할 사이트'에서는 확장이 누르지 않고 대상을 표시해 사용자가 직접 하게 한다.
import { expect, lastTool } from "../lib.mjs";

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
        onCard: async () => {
          await h.tab.waitForTimeout(400);
          outAtCard = await h.tab.locator("#out").innerText();
          await h.tab.locator("#b").click();
        },
      });
      expect(outAtCard === "", `카드가 뜬 동안 확장이 누르면 안 된다(out='${outAtCard}')`);
      expect(r.out === "눌림 true", `사용자 클릭(out='${r.out}')`);
      const res = lastTool(r, "click_element")?.result;
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
        onCard: async (card) => {
          await h.tab.waitForTimeout(300);
          valueAtCard = await h.tab.locator("#dep").inputValue();
          await h.tab.locator("#dep").fill("서울");
          await card.locator(".btn-approve").click();
        },
      });
      expect(valueAtCard === "", `확장이 값을 넣으면 안 된다('${valueAtCard}')`);
      const res = lastTool(r, "fill_form_fields")?.result;
      expect(res?.handedOff === true && res.outcome === "confirmed", `결과 outcome=confirmed(${JSON.stringify(res)})`);
    },
  },
  {
    name: "취소하면 실행하지 않는다",
    pages: { "/h": page },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      const r = await h.turn([findC, { click: "조회하기" }], {
        path: "/h",
        onCard: async (card) => {
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.out === "", `눌리면 안 된다(out='${r.out}')`);
      const t = lastTool(r, "click_element");
      expect(t && !t.result?.handedOff, `취소 결과(${JSON.stringify(t)})`);
    },
  },
];
