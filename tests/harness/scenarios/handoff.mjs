// 손 넘기기(0.2.2): '직접 조작할 사이트'에서는 확장이 누르지 않고 대상을 표시해 사용자가 직접 하게 한다.
import { expect, findC, lastTool, okResult } from "../lib.mjs";
import { checkHandoffReleased, handoffBoxes, installHandoffObserver, markTurnStart, restoreHandoffObserver } from "../handoffObserve.mjs";

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
      // 패널 취소도 원격 거절과 같은 해제 경로를 지난다(#263 단계 5 — 표시·폴링·팝업 감시를 거둔다).
      await installHandoffObserver(h);
      try {
        await markTurnStart(h);
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
        // 카드가 떠 있는 동안에는 폴링이 돌았을 수 있다 — 해제 뒤로 더 돌지 않는지만 본다.
        await checkHandoffReleased(h, { statusFree: false, noStatusAfterEnd: true });
        expect((await handoffBoxes(h.tab)) === 0, "페이지에 표시가 남지 않음");
      } finally {
        await restoreHandoffObserver(h);
      }
    },
  },
  {
    name: "손 넘기기 중 중단하면 표시를 거두고 기록에 남기지 않는다(#263 단계 5)",
    pages: { "/h": page },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      let stopped = false;
      let boxesAtCard = -1;
      await installHandoffObserver(h);
      try {
        await markTurnStart(h);
        const r = await h.turn([findC, { click: "조회하기" }], {
          path: "/h",
          onCard: async (_card, n) => {
            if (n > 1) return;
            await h.tab.waitForTimeout(300);
            boxesAtCard = await handoffBoxes(h.tab);
            await h.panel.click("button.composer-btn.danger");
            stopped = true;
          },
        });
        expect(stopped && boxesAtCard >= 1, `손 넘기기 표시가 뜬 뒤 중단(표시 ${boxesAtCard})`);
        expect(r.out === "", `눌리면 안 된다(out='${r.out}')`);
        expect(!lastTool(r, "click_element"), `중단한 턴은 손 넘기기 결과를 모델에 보내지 않음(${JSON.stringify(lastTool(r, "click_element"))})`);
        await checkHandoffReleased(h, { statusFree: false, noStatusAfterEnd: true });
        expect((await handoffBoxes(h.tab)) === 0, "페이지에 표시가 남지 않음");
      } finally {
        await restoreHandoffObserver(h);
      }
      // 다음 요청의 기록: 중단한 호출은 끊긴 호출(interrupted)로만 채워지고 손 넘기기 결과·취소 결과가 없다.
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.turn([{ text: "다음" }], { path: "/h", noReload: true, text: "다음" });
      const tools = await h.sw.evaluate(() => (globalThis.__modelReqs[0]?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content)));
      expect(tools.length === 2, `기록의 도구 결과 2개(찾기·끊긴 클릭)(${tools.length})`);
      expect(JSON.parse(tools[1]).error === "interrupted", `끊긴 호출로만 남음(${tools[1]})`);
      expect(!tools.some((c) => c.includes("handedOff") || c.includes("user_cancelled")), `손 넘기기·취소 결과 없음(${tools.join(" | ").slice(0, 300)})`);
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
  {
    name: "기다리는 동안 다른 버튼으로 연 팝업은 따라가지 않는다(#81)",
    pages: {
      "/hp2": `<title>예매</title><main><button id=other onclick="window.open('/ad','ad','popup,width=300,height=200')">광고 보기</button>
<button id=go style="width:160px;height:50px" onclick="document.getElementById('out').textContent='조회됨'">조회하기</button><p id=out></p></main>`,
      "/ad": `<title>광고</title><main><button>광고 닫기</button></main>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true, manualSites: [h.base] });
      const r = await h.turn([findC, { click: "조회하기" }, findC, { text: "끝" }], {
        path: "/hp2",
        onCard: async (_card, n) => {
          if (n > 1) return;
          await h.tab.waitForTimeout(300);
          await h.tab.locator("#other").click();
          await h.tab.bringToFront();
          await h.tab.waitForTimeout(500);
          await h.tab.locator("#go").click();
        },
      });
      const res = lastTool(r, "click_element")?.result;
      expect(res?.outcome === "clicked" && !/팝업/.test(res.note ?? ""), `무관한 팝업 안내 없음(${JSON.stringify(res)})`);
      const found = okResult(r, "find_clickables");
      expect(found.some((c) => c.text === "조회하기"), `원래 탭에서(${JSON.stringify(found)})`);
    },
  },
];
