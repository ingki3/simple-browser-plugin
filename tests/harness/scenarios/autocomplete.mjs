// 자동완성 칸(네이버 지도 길찾기와 같은 구조): 칸마다 role=combobox(aria-controls 없음), 입력하면 그 칸 묶음 안에 목록을 그리고
// aria-expanded=true. 목록은 아래 버튼을 덮는다. 한 번에 하나씩 채우기, 칸별 선택지(listFor·nearest), 뺀 선택지 안내, 덮개 진단.
import { expect, lastTool, okResult } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };
const findF = { tool: "find_form_fields", args: {} };

// portal: 목록을 칸 묶음이 아니라 body 끝 div에 붙인다(구조로 주인을 정할 수 없는 변형).
export const routePage = ({ portal = false } = {}) => `<title>길찾기</title><main>
<div class=field><span>출발</span><input role=combobox aria-expanded=false aria-label="출발지" id=s><div class=pop></div></div>
<div class=field><span>도착</span><input role=combobox aria-expanded=false aria-label="도착지" id=g><div class=pop></div></div>
<button id=go style="margin-top:4px">길찾기</button><p id=out></p></main>
<div id=portal></div>
<style>.pop ul{position:absolute;left:8px;top:60px;width:300px;height:120px;margin:0;background:#fff;z-index:9;list-style:none}</style>
<script>
const PORTAL = ${portal};
function open(input) {
  const host = PORTAL ? document.getElementById("portal") : input.parentElement.querySelector(".pop");
  host.innerHTML = '<ul role=listbox><li role=option>강남역</li><li role=option>강남역 2번출구</li></ul>';
  input.setAttribute("aria-expanded", "true");
  for (const li of host.querySelectorAll("[role=option]")) li.addEventListener("click", () => {
    input.value = li.textContent;
    input.setAttribute("aria-expanded", "false");
    host.innerHTML = "";
  });
}
for (const i of document.querySelectorAll("input")) i.addEventListener("input", () => open(i));
window.__openBoth = () => { for (const i of document.querySelectorAll("input")) { i.value = "강남"; open(i); } };
document.getElementById("go").addEventListener("click", () => {
  document.getElementById("out").textContent = "경로 " + document.getElementById("s").value + "→" + document.getElementById("g").value;
});
</script>`;

const openBoth = (h) => h.tab.evaluate(() => window.__openBoth());

export default [
  {
    name: "자동완성 칸 두 개를 한 번에 채우면 첫 칸만 쓰고(목록 열림 알림) 둘째는 한 번에 하나씩 안내",
    pages: { "/r": routePage() },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findF, { fillMany: [{ label: "출발지", value: "운중" }, { label: "도착지", value: "강남" }] }, { text: "끝" }], { path: "/r" });
      const res = okResult(r, "fill_form_fields");
      const [a, b] = res.results;
      expect(a.applied && a.listOpened && String(a.note).includes("자동완성 목록이 열렸습니다"), `첫 칸(${JSON.stringify(a)})`);
      expect(!b.applied && String(b.note).includes("한 번에 하나씩"), `둘째 칸(${JSON.stringify(b)})`);
      expect((await h.tab.evaluate(() => document.getElementById("g").value)) === "", "둘째 칸은 쓰지 않음");
    },
  },
  {
    name: "다른 칸의 목록이 열려 있으면 자동완성 칸을 채우지 않는다",
    pages: { "/r": routePage() },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const turn = h.turn([findF, { fill: "도착지", value: "강남", delayMs: 400 }, { text: "끝" }], { path: "/r" });
      for (let i = 0; i < 50 && !(await h.sw.evaluate(() => (globalThis.__toolLog ?? []).some((t) => t.name === "find_form_fields"))); i++) await h.tab.waitForTimeout(100);
      await h.tab.evaluate(() => { const s = document.getElementById("s"); s.value = "운중"; s.dispatchEvent(new Event("input")); });
      const r = await turn;
      const res = lastTool(r, "fill_form_fields");
      const note = String(res?.result?.results?.[0]?.note ?? res?.error ?? "");
      expect(note.includes("다른 칸의 목록"), `채우지 않음(${JSON.stringify(res)})`);
    },
  },
  {
    name: "목록 두 개가 열려도 칸 묶음 구조로 주인을 정해 listFor로 알리고, 고른 칸만 바뀐다(추정이라 자동 실행에서도 카드)",
    pages: { "/r": routePage() },
    async run(h) {
      await h.settings({ runMode: "auto" });
      await h.tab.goto(h.base + "/r");
      await openBoth(h);
      const seen = [];
      const r = await h.turn([findC, { clickOption: "강남역", listFor: "도착지" }, { text: "끝" }], {
        noReload: true,
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      const found = lastTool(r, "find_clickables").result;
      const opts = (Array.isArray(found) ? found : found.items).filter((c) => c.text === "강남역");
      expect(opts.length === 2 && opts.some((c) => c.listFor === "출발지") && opts.some((c) => c.listFor === "도착지"), `칸별 선택지(${JSON.stringify(opts)})`);
      expect(r.cards === 1 && seen[0].includes("구조로 추정"), `자동 실행에서도 카드(${r.cards}, ${seen[0]})`);
      okResult(r, "click_element");
      const v = await h.tab.evaluate(() => [document.getElementById("s").value, document.getElementById("g").value]);
      expect(v[0] === "강남" && v[1] === "강남역", `도착지만 바뀜(${v})`);
    },
  },
  {
    name: "맡긴 작업이어도 구조로 추정한 선택지는 카드로 묻는다",
    pages: { "/r": routePage() },
    async run(h) {
      await h.settings({ runMode: "task" });
      await h.tab.goto(h.base + "/r");
      await openBoth(h);
      const seen = [];
      const r = await h.turn([{ tool: "confirm_task", args: { summary: "길찾기 입력", risks: [] } }, findC, { clickOption: "강남역", listFor: "출발지" }], {
        noReload: true,
        onCard: async (card, n) => {
          if (n === 1) await card.locator(".btn-approve").click();
          else {
            seen.push(await card.innerText());
            await card.locator(".btn-cancel").click();
          }
        },
      });
      expect(r.cards === 2 && seen[0]?.includes("구조로 추정"), `맡긴 뒤에도 카드(${r.cards}, ${seen[0]})`);
    },
  },
  {
    name: "목록을 body 끝에 붙이면(포털) 주인을 정하지 않고 뺀 선택지 수를 알린다",
    pages: { "/p": routePage({ portal: true }) },
    async run(h) {
      await h.tab.goto(h.base + "/p");
      await openBoth(h);
      const r = await h.turn([findC, { text: "끝" }], { noReload: true });
      const res = okResult(r, "find_clickables");
      expect(!Array.isArray(res) && !res.items.some((c) => c.role === "option") && String(res.note).includes("선택지 2개"), `뺀 선택지(${JSON.stringify(res).slice(0, 400)})`);
    },
  },
  {
    name: "열린 목록이 버튼을 덮으면 클릭 결과에 알린다(스크립트 클릭 — 실제 입력은 trusted-input에서)",
    pages: { "/r": routePage() },
    async run(h) {
      await h.settings({ runMode: "auto" });
      await h.tab.goto(h.base + "/r");
      await h.tab.evaluate(() => { const s = document.getElementById("s"); s.value = "운중"; s.dispatchEvent(new Event("input")); });
      const r = await h.turn([findC, { click: "길찾기" }, { text: "끝" }], { noReload: true });
      const c = okResult(r, "click_element");
      expect(c.effect?.dom?.covered === "열린 목록(또는 대화상자)이 대상을 덮고 있음" && String(c.note).includes("열린 목록"), `덮개 진단(${JSON.stringify(c.effect?.dom)} ${c.note})`);
    },
  },
  {
    name: "버튼이 연 대화상자 안의 자동완성 칸은 그 버튼 때문에 막히지 않는다",
    pages: {
      "/dlg": `<title>주소</title><main><button aria-haspopup=dialog aria-expanded=true aria-controls=dd>주소 검색</button>
<div id=dd role=dialog><div class=field><span>검색</span><input role=combobox aria-expanded=false aria-label="장소 검색어" id=a><div class=pop></div></div></div><p id=out></p></main>
<script>document.getElementById("a").addEventListener("input", (e) => { e.target.setAttribute("aria-expanded", "true"); e.target.parentElement.querySelector(".pop").innerHTML = "<ul role=listbox><li role=option>판교역로</li></ul>"; });</script>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findF, { fill: "장소 검색어", value: "판교" }, { text: "끝" }], { path: "/dlg" });
      const res = lastTool(r, "fill_form_fields");
      const ff = lastTool(r, "find_form_fields");
      expect(res?.result?.results?.[0]?.applied && res.result.results[0].listOpened, `채움(${JSON.stringify(res)} / 찾기 ${JSON.stringify(ff)} / stopped=${r.stoppedAtCard})`);
    },
  },
];
