// 디버그 로그(#156): query_dom 선택자, 레시피 제안(도구·인자), 제안한 레시피를 그대로 다시 쓴 것.
import { expect } from "../lib.mjs";

const PAGE = `<title>목록</title><main><ul><li class=price>1,000원</li><li class=price>2,000원</li></ul><p id=out></p></main>`;
const query = { tool: "query_dom", args: { selector: "li.price" } };

export default [
  {
    name: "query_dom 선택자와 레시피 제안·사용을 디버그 로그에 남긴다",
    pages: { "/list": PAGE },
    async run(h) {
      const r1 = await h.turn([query, { text: "읽었습니다" }], { path: "/list" });
      expect(r1.logs.some((l) => l.includes("tool:query_dom:args") && l.includes("selector='li.price'")), "선택자 로그");
      const r2 = await h.turn([{ tool: "describe_page", args: {} }, query, { text: "끝" }], { path: "/list" });
      expect(r2.logs.some((l) => l.includes("read_recipe:offered") && l.includes("query_dom selector='li.price'")), `제안 로그(${r2.logs.filter((l) => l.includes("read_recipe")).join(" | ")})`);
      expect(r2.logs.some((l) => l.includes("read_recipe:used") && l.includes("결과 있음")), "사용 로그");
    },
  },
];
