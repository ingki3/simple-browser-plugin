// 클릭으로 열린 대화상자의 화면 글자를 결과에 싣는다(#158). 입력 칸 값·편집 영역 글자는 빼고(#43), 긴 main 바깥이어도 싣는다.
import { expect, okResult } from "../lib.mjs";

const filler = "<p>" + "상품 설명 ".repeat(400) + "</p>";
const PAGE = `<title>상품</title>
<main>${filler}<button id=add>장바구니</button><button id=filter>필터</button><p id=out></p></main>
<div id=dlg role=dialog hidden><p>장바구니에 담았습니다</p><textarea id=memo></textarea><div contenteditable=true id=ed></div><button>장바구니 보기</button></div>
<script>
  document.getElementById("memo").value = "비밀값";
  document.getElementById("ed").textContent = "편집글";
  document.getElementById("add").addEventListener("click", () => { document.getElementById("dlg").hidden = false; });
  document.getElementById("filter").addEventListener("click", () => { history.pushState({}, "", "?sort=low"); document.getElementById("dlg").hidden = false; });
</script>`;

export default [
  {
    name: "클릭으로 열린 대화상자 글자를 effect.dom.dialog로, 입력값·편집 글자는 빼고",
    pages: { "/item": PAGE },
    async run(h) {
      await h.settings({ runMode: "auto" });
      await h.sw.evaluate(() => { globalThis.__modelReqs = []; });
      const r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "장바구니" }, { text: "끝" }], { path: "/item" });
      const click = okResult(r, "click_element");
      const dom = click.effect?.dom;
      expect(dom?.dialogOpened && dom.dialog?.text?.includes("장바구니에 담았습니다"), `대화상자 글자(${JSON.stringify(dom)})`);
      expect(!dom.dialog.text.includes("비밀값") && !dom.dialog.text.includes("편집글"), "입력값·편집 글자 없음");
      expect(String(click.note ?? "").includes("대화상자가 열렸습니다"), `문구(${click.note})`);
      const all = JSON.stringify(await h.sw.evaluate(() => globalThis.__modelReqs));
      expect(!all.includes("비밀값") && !all.includes("편집글"), "모델 요청 어디에도 입력값·편집 글자 없음");
    },
  },
  {
    name: "같은 문서 주소 변경과 대화상자가 함께 오면 둘 다 알리고 목록 다시 찾기 안내",
    pages: { "/item": PAGE },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "필터" }, { text: "끝" }], { path: "/item" });
      const click = okResult(r, "click_element");
      const note = String(click.note ?? "");
      expect(note.includes("페이지 안에서 주소만 바뀌었습니다") && note.includes("대화상자가 열렸습니다") && note.includes("목록이 다시 그려졌을 수 있습니다"), `문구(${note})`);
      expect(click.effect?.dom?.dialog?.text?.includes("장바구니에 담았습니다"), "대화상자 글자");
    },
  },
];
