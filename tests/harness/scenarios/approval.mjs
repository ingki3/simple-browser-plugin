// 승인 규칙: 자동 실행 꺼짐·켜짐, 결제 단서, 요청한 사이트 밖 이동, 늘 묻는 동작(삭제).
import { expect, lastTool } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };

export default [
  {
    name: "자동 실행 꺼짐: 클릭은 카드로 묻는다",
    async run(h) {
      const r = await h.turn([findC, { click: "적용" }]);
      expect(r.stoppedAtCard, "승인 카드가 떠야 한다");
      expect(r.out === "", `카드 전에 실행되면 안 된다(out='${r.out}')`);
    },
  },
  {
    name: "자동 실행 꺼짐: 카드에서 승인하면 실행",
    async run(h) {
      const r = await h.turn([findC, { click: "적용" }], { approve: true });
      expect(r.cards === 1, `카드 1개(실제 ${r.cards})`);
      expect(r.out?.startsWith("필터됨"), `실행돼야 한다(out='${r.out}')`);
    },
  },
  {
    name: "자동 실행 켜짐: 같은 사이트의 일반 버튼은 카드 없이 실행",
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { click: "적용" }]);
      expect(!r.stoppedAtCard, "카드가 뜨면 안 된다");
      expect(r.out?.startsWith("필터됨"), `실행돼야 한다(out='${r.out}')`);
    },
  },
  {
    name: "자동 실행 켜짐: 결제 단서가 있는 버튼은 카드로 묻는다",
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { click: "결제하기" }]);
      expect(r.stoppedAtCard, "결제 버튼은 카드가 떠야 한다");
      expect(r.out === "", `실행되면 안 된다(out='${r.out}')`);
    },
  },
  {
    name: "자동 실행 켜짐: 요청한 사이트 밖으로 이동은 카드로 묻는다",
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([{ tool: "navigate_to_url", args: { url: h.base2 + "/x" } }]);
      expect(r.stoppedAtCard, "다른 사이트 이동은 카드가 떠야 한다");
    },
  },
  {
    name: "자동 실행 켜짐: 같은 사이트 안 칸 채우기는 카드 없이",
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([{ tool: "find_form_fields", args: {} }, { fill: "검색어", value: "노트북" }]);
      expect(!r.stoppedAtCard, "카드가 뜨면 안 된다");
      const res = lastTool(r, "fill_form_fields")?.result;
      expect(res?.filledCount === 1, `1칸 반영(${JSON.stringify(res)})`);
    },
  },
  {
    name: "자동 실행 켜짐: 삭제 버튼은 늘 카드로 묻는다(#62)",
    pages: { "/del": `<title>메일</title><main><button onclick="document.getElementById('out').textContent='삭제됨'">삭제</button><p id=out></p></main>` },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { click: "삭제" }], { path: "/del" });
      expect(r.stoppedAtCard, "삭제는 카드가 떠야 한다");
      expect(r.out === "", `실행되면 안 된다(out='${r.out}')`);
    },
  },
];
