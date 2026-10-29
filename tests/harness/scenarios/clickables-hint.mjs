// find_clickables가 찾기 조건 때문에 0개면 조건 없이 찾은 수를 알린다(#151). 조건에 맞으면 예전처럼 배열.
import { expect, okResult } from "../lib.mjs";

const PAGE = `<title>목록</title><main><button>낮은 가격순</button><a href="/item">상품 보기</a><p id=out></p></main>`;

export default [
  {
    name: "query에 맞는 요소가 없으면 조건 없이 찾은 수를 알린다",
    pages: { "/list": PAGE },
    async run(h) {
      const r = await h.turn([{ tool: "find_clickables", args: { query: "없는 낱말" } }], { path: "/list" });
      const res = okResult(r, "find_clickables");
      expect(!Array.isArray(res) && Array.isArray(res.items) && res.items.length === 0, `빈 items여야 한다(${JSON.stringify(res)})`);
      expect(String(res.note).includes("2개"), `조건 없이 찾은 수(${res.note})`);
      expect(r.logs.some((l) => l.includes("tool:find_clickables:args") && l.includes("query='없는 낱말'")), "디버그 로그에 찾기 조건");
    },
  },
  {
    name: "query에 맞으면 예전처럼 배열로 돌려준다",
    pages: { "/list": PAGE },
    async run(h) {
      const r = await h.turn([{ tool: "find_clickables", args: { query: "가격" } }], { path: "/list" });
      const res = okResult(r, "find_clickables");
      expect(Array.isArray(res) && res.length === 1 && res[0].text === "낮은 가격순", `배열(${JSON.stringify(res)})`);
    },
  },
  {
    name: "페이지에 클릭할 것이 없으면 조건이 있어도 빈 배열",
    pages: { "/empty": `<title>빈</title><main><p id=out>글만</p></main>` },
    async run(h) {
      const r = await h.turn([{ tool: "find_clickables", args: { region: "nav" } }], { path: "/empty" });
      const res = okResult(r, "find_clickables");
      expect(Array.isArray(res) && res.length === 0, `빈 배열(${JSON.stringify(res)})`);
    },
  },
];
