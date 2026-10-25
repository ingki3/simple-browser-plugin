// 페이지 캡처(0.1.12, #65): 전체 캡처 뒤 페이지의 inline 스타일을 원래대로 되돌린다.
import { expect } from "../lib.mjs";

const tall = `<title>긴 페이지</title><body style="margin:0">
<div id=bar style="position: fixed; top: 0px; transition-duration: 1s; background: #eee;">고정 막대</div>
<div id=st style="position: sticky; top: 10px; transition-property: opacity;">붙는 제목</div>
<main style="height:3000px">본문</main><p id=out></p></body>`;

export default [
  {
    name: "전체 캡처 뒤 고정·sticky 요소의 inline 스타일(longhand 포함)을 그대로 되돌린다(#65)",
    pages: { "/tall": tall },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.tab.setViewportSize({ width: 800, height: 600 });
      await h.tab.goto(h.base + "/tall");
      const before = await h.tab.evaluate(() => ["bar", "st"].map((id) => document.getElementById(id).getAttribute("style")));
      const r = await h.turn([{ tool: "capture_page", args: { fullPage: true } }, { text: "끝" }], { noReload: true, approve: true, maxWaitMs: 40_000 });
      const after = await h.tab.evaluate(() => ["bar", "st"].map((id) => document.getElementById(id).getAttribute("style")));
      const res = r.tools.find((t) => t.name === "capture_page");
      expect(res && !res.error, `캡처 성공(${JSON.stringify(res ?? null)} card=${r.stoppedAtCard} ${r.logs.filter((l) => l.includes("capture")).slice(-3).join(" | ")})`);
      expect(JSON.stringify(after) === JSON.stringify(before), `style 되돌림: 전 ${JSON.stringify(before)} → 후 ${JSON.stringify(after)}`);
    },
  },
  {
    name: "캡처 중 페이지가 바꾼 inline 스타일은 남기고 확장이 바꾼 속성만 되돌린다",
    pages: {
      "/tall2": `<title>긴 페이지</title><body style="margin:0">
<div id=bar style="position: fixed; top: 0px; background: #eee;">고정 막대</div>
<main style="height:3000px">본문</main>
<script>addEventListener('scroll',()=>{document.getElementById('bar').style.color='red'})</script></body>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.tab.setViewportSize({ width: 800, height: 600 });
      await h.tab.goto(h.base + "/tall2");
      await h.turn([{ tool: "capture_page", args: { fullPage: true } }, { text: "끝" }], { noReload: true, approve: true, maxWaitMs: 40_000 });
      const st = await h.tab.evaluate(() => {
        const b = document.getElementById("bar").style;
        return { color: b.color, opacity: b.opacity, transition: b.transition, position: b.position };
      });
      expect(st.color === "red", `페이지 변경 유지(${JSON.stringify(st)})`);
      expect(st.opacity === "" && st.transition === "" && st.position === "fixed", `확장 변경 되돌림(${JSON.stringify(st)})`);
    },
  },
  {
    name: "캡처 중 페이지가 바꾼 뒤 확장이 다시 손댄 요소도 페이지 변경을 남긴다",
    // sticky 제목(시작 때 확장이 relative로 바꿈)을 스크롤 때 페이지가 fixed·빨강으로 바꾼다. 그 뒤 확장이 fixed 숨김으로
    // 다시 손대도, 되돌릴 때 페이지의 color 변경은 남아야 한다.
    pages: {
      "/tall3": `<title>긴 페이지</title><body style="margin:0">
<div id=hd style="position: sticky; top: 0px;">제목</div>
<main style="height:3000px">본문</main>
<script>setInterval(()=>{if(scrollY>0){const h=document.getElementById('hd');h.style.setProperty('position','fixed','important');h.style.color='red'}},20)</script></body>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.tab.setViewportSize({ width: 800, height: 600 });
      await h.tab.goto(h.base + "/tall3");
      await h.turn([{ tool: "capture_page", args: { fullPage: true } }, { text: "끝" }], { noReload: true, approve: true, maxWaitMs: 40_000 });
      const st = await h.tab.evaluate(() => {
        const b = document.getElementById("hd").style;
        return { color: b.color, opacity: b.opacity, transition: b.transition };
      });
      expect(st.color === "red", `페이지 변경 유지(${JSON.stringify(st)})`);
      expect(st.opacity === "" && st.transition === "", `확장 변경 되돌림(${JSON.stringify(st)})`);
    },
  },
];
