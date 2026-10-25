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
  {
    name: "클릭 도중 직전 라디오의 그룹이 바뀌어도 다른 그룹의 체크를 풀지 않는다(#83)",
    // 누르기를 뗄 때(mouseup) 페이지가 직전 체크(a1)를 그룹 b로 옮긴다(브라우저가 b1을 해제, a1은 체크 유지). 그 뒤 click
    // 단계 확인에서 확장이 체크 상태를 되돌렸다 되살릴 때, 이미 다른 그룹이 된 a1을 건드리면 a1의 체크가 풀린다.
    pages: {
      "/r": `<title>R</title><main><form>
<label><input type=radio name=a id=a1 checked>A1</label><label><input type=radio name=a id=a2>A2</label>
<label><input type=radio name=b id=b1 checked>B1</label><label><input type=radio name=b id=b2>B2</label></form>
<script>document.getElementById('a2').addEventListener('mouseup',()=>{document.getElementById('a1').name='b'})</script><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      await h.turn([findC, { click: "A2" }], { path: "/r" });
      const state = await h.tab.evaluate(() => ["a1", "b1", "b2"].map((id) => `${id}=${document.getElementById(id).checked}`).join(" "));
      // 사람이 같은 클릭을 했을 때의 그룹 b(a1 체크 유지, b1 해제)와 같아야 한다. 클릭 자체는 양식이 바뀌어 막힐 수 있다.
      expect(state === "a1=true b1=false b2=false", `그룹 b 상태(${state})`);
  },
  },
  {
    name: "누르는 사이 페이지가 같은 그룹의 다른 라디오를 체크해도 그 체크를 되살린다(#83 회귀 방지)",
    // 이미 체크된 A를 누르는데 페이지의 window 캡처 리스너가 click 때 같은 그룹 B를 체크한다. 확장이 확인을 위해 A를
    // 승인 때(체크)로 되돌리면 B가 풀리므로, 되살릴 때 B를 다시 체크해야 사람이 누른 것과 같다.
    pages: {
      "/r2": `<title>R2</title><main><form>
<label><input type=radio name=g id=ra checked>RA</label><label><input type=radio name=g id=rb>RB</label></form>
<script>window.addEventListener('click',(e)=>{if(e.target.id==='ra')document.getElementById('rb').checked=true},true)</script><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      await h.turn([findC, { click: "RA" }], { path: "/r2" });
      const state = await h.tab.evaluate(() => ["ra", "rb"].map((id) => `${id}=${document.getElementById(id).checked}`).join(" "));
      expect(state === "ra=false rb=true", `그룹 상태(${state})`);
    },
  },
];
