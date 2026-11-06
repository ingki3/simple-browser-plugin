// 실제 입력 클릭이 가드에 막혔을 때(#241): 그 사이 관측(effect)을 실패 결과와 함께 모델에 돌려주고, 디버그 로그 input:blocked가
// 막힘 형태를 구별하는지 본다. 자동완성 항목 클릭에서 늘 나는 두 형태(2026-11-06 로그):
//   (a) 항목 노드를 새 노드로 바꿔 그림 — a1: pointerdown 처리기, a2: 포인터가 닿을 때(hover) 처리기
//   (b) 입력 칸 blur로 목록이 닫힘 — b1: 항목이 mousedown에서 고름, b2: 항목이 click에서 고름
// 하네스 탐색으로 확인한 Chrome 동작: CDP mousePressed만으로도 pointerover·mouseover 등을 먼저 낸다.
// - a1: pointerdown 처리기가 대상을 떼면 mousedown은 연결된 조상(ul)으로 간다 → 첫 차단 mousedown(앞: pointerdown), 닿은 요소 ul.
// - a2: hover 처리기가 대상을 떼면 pointerdown·mousedown은 떨어진 대상 자신에게 가서(이벤트 경로에 window가 없음) 가드에 보이지
//   않고, 새 노드로 가는 pointerup에서 처음 막는다 → 첫 차단 pointerup(앞: 없음). 떨어진 대상의 처리기만 돌 수 있다(다른 요소 아님).
// - b: blur로 목록이 닫히면 떼기 단계(pointerup, 앞: pointerdown·mousedown), 대상은 붙어 있으나 숨겨짐, 아래 요소(div)에 닿음.
// 가드 완화·스크립트 대체는 없다.
import { expect, lastTool } from "../lib.mjs";

const SECRET = "비밀값-241";
const BTN = (id) => `<button id=${id} style="width:200px;height:40px" onclick="window.__clicks=(window.__clicks||0)+1">올림픽공원</button>`;
// 목록 아래 깔린 요소(#under): 목록이 닫히면 그 자리를 받는다. 칸 값은 스크립트가 넣는다(입력값 — 결과·로그에 나오면 안 됨).
const page = (script) => `<title>자동완성</title><main>
<input id=q aria-label="검색">
<div style="position:relative;height:60px"><div id=under style="position:absolute;inset:0;background:#eee"></div>
<ul id=sug style="position:relative;list-style:none;padding:0;margin:0;background:#fff"><li>${BTN("b1")}</li></ul></div>
<p id=out></p>
<script>q.value=${JSON.stringify(SECRET)};q.focus();
function rerender(){ const li=document.createElement('li'); const b=document.createElement('button'); b.id='b2'; b.style.cssText='width:200px;height:40px'; b.textContent='올림픽공원'; b.onclick=()=>{window.__clicks=(window.__clicks||0)+1}; li.append(b); sug.replaceChildren(li); }
${script}</script></main>`;

const A1 = page(`document.addEventListener('pointerdown',e=>{if(e.target.closest('#sug button')){rerender();out.textContent='선택됨';}});`);
const A2 = page(`let n=0;for(const t of ['pointerover','pointermove','mouseover'])document.addEventListener(t,e=>{if(e.target.id==='b1'&&n++<1)rerender();});`);
const B1 = page(`q.addEventListener('blur',()=>{sug.style.display='none'});document.addEventListener('mousedown',e=>{if(e.target.closest('#sug button'))out.textContent='선택됨';});`);
const B2 = page(`q.addEventListener('blur',()=>{sug.style.display='none'});document.addEventListener('click',e=>{if(e.target.closest('#sug button'))out.textContent='선택됨';});`);

const steps = [{ tool: "find_clickables", args: {} }, { click: "올림픽공원" }];

async function runBlocked(h, path) {
  await h.settings({ autoApprove: true, trustedInput: true });
  const r = await h.turn(steps, { path });
  const t = lastTool(r, "click_element");
  expect(t, "click_element 결과가 없다");
  // 던진 오류가 아니라 결과 객체(error + effect)여야 한다.
  expect(!t.error && t.result && typeof t.result.error === "string", `실패 결과 객체여야 한다(${JSON.stringify(t).slice(0, 300)})`);
  expect(t.result.effect && t.result.effect.dom && t.result.effect.dom.mutations > 0, `effect.dom.mutations > 0(${JSON.stringify(t.result.effect)})`);
  expect(/다시 누르지 마세요/.test(t.result.error), `결과 먼저 확인 안내(${t.result.error})`);
  const line = r.logs.find((l) => l.includes("input:blocked")) ?? "";
  expect(line, "디버그 로그 input:blocked가 없다");
  expect(line.includes("'올림픽공원'"), `진단 줄에 대상 이름(${line})`);
  const fail = r.logs.find((l) => l.includes("tool:result") && l.includes(" click_element fail")) ?? "";
  expect(fail.includes("그 사이 관측"), `결과 요약에 관측(${fail})`);
  const clicks = await h.tab.evaluate(() => window.__clicks ?? 0);
  expect(clicks === 0, `click은 막혀야 한다(스크립트 대체 없음, clicks=${clicks})`);
  const reqs = JSON.stringify(await h.sw.evaluate(() => globalThis.__modelReqs));
  expect(!reqs.includes(SECRET) && !r.logs.some((l) => l.includes(SECRET)), "입력 칸 값이 모델 요청·로그에 없어야 한다(#43)");
  return { r, t, line };
}

export default [
  {
    name: "a1 누르기(pointerdown) 때 항목을 새 노드로 다시 그리면: mousedown에서 막고, 대상 떨어짐과 그 사이 변화를 실패로 알린다",
    pages: { "/a1": A1 },
    async run(h) {
      const { r, t, line } = await runBlocked(h, "/a1");
      expect(r.out === "선택됨", `누르기 처리는 일어남(out='${r.out}')`);
      expect(/문서에서 떨어졌습니다/.test(t.result.error), `대상 떨어짐 문장(${t.result.error})`);
      expect(line.includes("첫 차단 mousedown(앞: pointerdown)"), `첫 차단 mousedown(${line})`);
      expect(line.includes("대상 연결 끊김"), `대상 연결 끊김(${line})`);
      expect(line.includes("닿은 요소 ul"), `mousedown은 연결된 조상 ul로(${line})`);
    },
  },
  {
    name: "a2 포인터가 닿을 때(hover) 다시 그리면: 가드가 처음 보는 pointerup에서 막고(앞 이벤트 없음) 대상 떨어짐",
    pages: { "/a2": A2 },
    async run(h) {
      const { r, t, line } = await runBlocked(h, "/a2");
      expect(r.out === "", `선택은 일어나지 않음(out='${r.out}')`);
      expect(/떼기\(pointerup\) 단계/.test(t.result.error) && /문서에서 떨어졌습니다/.test(t.result.error), `pointerup 단계·떨어짐(${t.result.error})`);
      expect(line.includes("첫 차단 pointerup(앞: 없음)"), `첫 차단 pointerup, 앞 없음(${line})`);
      expect(line.includes("닿은 요소 button"), `새 노드(button)에 닿음(${line})`);
      expect(line.includes("대상 연결 끊김"), `대상 연결 끊김(${line})`);
    },
  },
  {
    name: "b1 입력 칸 blur로 목록이 닫히고 mousedown에서 고르는 자동완성: 떼기에서 막고 대상은 붙어 있으나 숨겨짐(선택은 일어남)",
    pages: { "/b1": B1 },
    async run(h) {
      const { r, t, line } = await runBlocked(h, "/b1");
      expect(r.out === "선택됨", `mousedown 선택은 일어남(out='${r.out}')`);
      expect(/화면에서 사라졌습니다\(숨겨짐\)/.test(t.result.error), `숨겨짐 문장(${t.result.error})`);
      expect(line.includes("첫 차단 pointerup(앞: pointerdown,mousedown)"), `첫 차단 pointerup(${line})`);
      expect(line.includes("대상 연결됨·숨겨짐"), `대상 연결됨·숨겨짐(${line})`);
      expect(line.includes("닿은 요소 div"), `아래 요소에 닿음(${line})`);
    },
  },
  {
    name: "b2 같은 blur 닫힘, click에서 고르는 자동완성: 진단은 b1과 같고 선택은 일어나지 않음",
    pages: { "/b2": B2 },
    async run(h) {
      const { r, line } = await runBlocked(h, "/b2");
      expect(r.out === "", `click 선택은 막혀 일어나지 않음(out='${r.out}')`);
      expect(line.includes("첫 차단 pointerup(앞: pointerdown,mousedown)") && line.includes("대상 연결됨·숨겨짐"), `b1과 같은 진단(${line})`);
    },
  },
  {
    name: "막힌 클릭을 되풀이하면 화면이 바뀌어도 연속 실패로 멈춘다",
    pages: { "/a1": A1 },
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      const r = await h.turn([...steps, ...steps, ...steps], { path: "/a1" });
      const fails = r.logs.filter((l) => l.includes("tool:result") && l.includes(" click_element fail")).length;
      expect(fails === 3, `막힌 클릭 3번(${fails})`);
      expect(r.logs.some((l) => l.includes("hop:spin") && l.includes("failure · click_element")), "연속 실패 헛돌기 감지");
    },
  },
];
