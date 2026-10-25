// 실제 마우스 입력 클릭(0.2.0)과 덮인 대상(#89): 설정을 켜면 디버거로 누르고(isTrusted), 가운데가 덮이면 다른 점을,
// 모두 덮이면 스크립트 클릭으로 대체하고 이유를 남긴다.
import { expect, resultLog } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };
const rec = "document.getElementById('out').textContent='눌림 '+event.isTrusted";

export default [
  {
    name: "설정 켜짐: 실제 입력으로 누른다",
    pages: { "/t": `<title>T</title><main><button style="width:200px;height:60px" onclick="${rec}">확인</button><p id=out></p></main>` },
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      const r = await h.turn([findC, { click: "확인" }], { path: "/t" });
      expect(r.out === "눌림 true", `isTrusted=true여야 한다(out='${r.out}')`);
      const line = resultLog(r, "click_element");
      expect(line.includes("실제 입력"), `결과 요약에 '실제 입력'(${line})`);
    },
  },
  {
    name: "설정 꺼짐: 스크립트 클릭",
    pages: { "/t": `<title>T</title><main><button onclick="${rec}">확인</button><p id=out></p></main>` },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { click: "확인" }], { path: "/t" });
      expect(r.out === "눌림 false", `isTrusted=false(out='${r.out}')`);
    },
  },
  {
    name: "가운데가 덮이면 다른 점을 실제 입력으로(#89)",
    pages: {
      "/c": `<title>C</title><main style="position:relative"><button style="width:300px;height:80px" onclick="${rec}">확인</button>
<div style="position:absolute;left:120px;top:20px;width:60px;height:40px;background:#c00"></div><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      const r = await h.turn([findC, { click: "확인" }], { path: "/c" });
      expect(r.out === "눌림 true", `다른 점을 실제 입력으로 눌러야 한다(out='${r.out}')`);
    },
  },
  {
    name: "모두 덮이면 스크립트 클릭으로 대체하고 이유를 남긴다(#89)",
    pages: {
      "/c": `<title>C</title><main style="position:relative"><button style="width:200px;height:60px" onclick="${rec}">확인</button>
<div role=dialog style="position:absolute;left:0;top:0;width:220px;height:80px;background:rgba(0,0,0,.3)"></div><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      const r = await h.turn([findC, { click: "확인" }], { path: "/c" });
      expect(r.out === "눌림 false", `스크립트 클릭이어야 한다(out='${r.out}')`);
      const line = resultLog(r, "click_element");
      expect(/스크립트 클릭\(.*덮/.test(line), `결과 요약에 스크립트 클릭 이유(${line})`);
    },
  },
];
