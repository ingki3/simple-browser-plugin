// 선택지 관계(#43 B·0.2.8), 입력값 보호(#43), 숨긴 select + 대리 콤보박스(#88).
import { expect, okResult } from "../lib.mjs";

const findC = (query) => ({ tool: "find_clickables", args: query ? { query } : {} });

const wrapped = `<title>W</title><main>
<input role=combobox aria-expanded=true aria-controls=w1 aria-label="출발지" value="서울">
<div id=w1><ul role=listbox><li role=option onclick="document.getElementById('out').textContent='김포'">김포국제공항</li></ul></div>
<input role=combobox aria-expanded=true aria-controls=w2 aria-label="도착지" value="부산">
<div id=w2><ul role=listbox><li role=option onclick="document.getElementById('out').textContent='김해'">김해국제공항</li></ul></div>
<p id=out></p></main>`;

const dialogMenu = `<title>D</title><main>
<button aria-haspopup=dialog aria-expanded=true aria-controls=d>관리</button>
<div id=d role=dialog><button aria-haspopup=menu aria-expanded=true>삭제</button>
<ul role=menu><li role=menuitem onclick="document.getElementById('out').textContent='눌림'">선택 항목</li></ul></div>
<p id=out></p></main>`;

const select2 = `<title>S</title><main><label for=y>연식</label>
<select id=y aria-hidden=true style="border:0;clip:rect(0 0 0 0);height:1px;margin:-1px;overflow:hidden;padding:0;position:absolute;width:1px;white-space:nowrap"><option value="">선택</option><option value=2022>2022년</option><option value=2023>2023년</option></select>
<span><span role=combobox aria-haspopup=listbox tabindex=0>선택</span></span><p id=out></p>
<script>document.getElementById('y').addEventListener('change',e=>{document.getElementById('out').textContent='연식 '+e.target.value;document.querySelector('[role=combobox]').textContent=e.target.selectedOptions[0].text})</script></main>`;

export default [
  {
    name: "aria-controls가 목록을 감싼 요소를 가리켜도 그 콤보박스의 선택지로 찾는다(0.2.8)",
    pages: { "/w": wrapped },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC("김해"), { click: "김해국제공항", role: "option" }], { path: "/w" });
      const found = okResult(r, "find_clickables");
      expect(found.some((c) => c.role === "option"), `선택지가 나와야 한다(${JSON.stringify(found)})`);
      expect(r.out === "김해", `눌러야 한다(out='${r.out}')`);
    },
  },
  {
    name: "대화상자 안 다른 메뉴 버튼이 연 메뉴의 항목은 바깥 버튼에 연결하지 않는다",
    pages: { "/d": dialogMenu },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC(), { text: "끝" }], { path: "/d" });
      const found = okResult(r, "find_clickables");
      expect(Array.isArray(found), `목록이어야 한다(${JSON.stringify(found)})`);
      expect(found.some((c) => c.text === "관리"), `같은 페이지의 버튼은 나와야 한다(${JSON.stringify(found)})`);
      expect(!found.some((c) => c.role === "menuitem"), `메뉴 항목이 나오면 안 된다(${JSON.stringify(found)})`);
    },
  },
  {
    name: "입력 칸의 값은 찾기 결과에 넣지 않는다(#43)",
    pages: { "/w": wrapped },
    async run(h) {
      const r = await h.turn([{ tool: "find_form_fields", args: {} }, findC(), { text: "끝" }], { path: "/w" });
      const fields = okResult(r, "find_form_fields");
      const clicks = okResult(r, "find_clickables");
      expect(fields.length === 2 && fields.every((f) => f.hasValue === true), `값이 있는 칸 2개(${JSON.stringify(fields)})`);
      expect(clicks.filter((c) => c.role === "option").length === 2, `선택지 2개가 나와야 한다(${JSON.stringify(clicks)})`);
      const json = JSON.stringify(r.tools);
      expect(!json.includes("서울") && !json.includes("부산"), `입력값이 결과에 있으면 안 된다(${json.slice(0, 300)})`);
    },
  },
  {
    name: "숨긴 select + 대리 콤보박스: 선택지를 보이고 값을 고른다(#88)",
    pages: { "/s": select2 },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([{ tool: "find_form_fields", args: {} }, { fillType: "select", value: "2023년" }], { path: "/s" });
      const fields = okResult(r, "find_form_fields");
      const sel = fields.find((f) => f.type === "select");
      expect(sel?.options?.some((o) => o.label === "2023년"), `선택지 전송(${JSON.stringify(fields)})`);
      const res = okResult(r, "fill_form_fields");
      expect(res?.filledCount === 1 && r.out === "연식 2023", `값 반영(${JSON.stringify(r.tools).slice(0, 600)}, card=${r.stoppedAtCard}, out='${r.out}')`);
    },
  },
  {
    name: "query_dom: 값에 기대는 선택자는 실행하지 않고, 구조 선택자는 그대로(#45)",
    pages: { "/q": `<title>Q</title><main><input id=e name=email value="me@example.com"><a href="/a" data-k="secret">링크</a><p id=out></p></main>` },
    async run(h) {
      const r = await h.turn(
        [
          { tool: "query_dom", args: { selector: "input[value^='me']" } },
          { tool: "query_dom", args: { selector: "a[data-k^='s']" } },
          { tool: "query_dom", args: { selector: "main a[href]", attr: "href" } },
          { text: "끝" },
        ],
        { path: "/q" },
      );
      const q = r.tools.filter((t) => t.name === "query_dom");
      expect(q.length === 3, `결과 3개(${JSON.stringify(q)})`);
      expect(q[0].error?.includes("value") && q[1].error?.includes("data-k"), `값 조건 거부(${JSON.stringify(q.slice(0, 2))})`);
      expect(Array.isArray(q[2].result) && q[2].result[0]?.text === "링크", `구조 선택자 실행(${JSON.stringify(q[2])})`);
    },
  },
];
