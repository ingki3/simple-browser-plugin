// find_clickables 항목 모드(#161)·문맥 검색(#159): 반복 항목마다 화면 글자와 그 안의 대상 id, 항목 결합 검사, 입력값 보호(#43).
import { expect, lastTool, okResult } from "../lib.mjs";

const items = (args = {}) => ({ tool: "find_clickables", args: { mode: "items", ...args } });
const product = (i, extra = "") =>
  `<li><a href="/p/${i}">맥북 에어</a><span>${1000 + i}원</span><button>찜</button>${extra}</li>`;
const section = (name, from) =>
  `<section><h2><a href="/cat/${name}">카테고리 ${name}</a></h2><ul>${Array.from({ length: 12 }, (_, k) => product(from + k)).join("")}</ul><p id=total-${name}>합계 12000원</p></section>`;

// 섹션 2개 × (제목 링크 + 상품 12개) + 항목 밖 필터 버튼.
const SECTIONS = `<title>목록</title><main><button>필터</button>${section("A", 0)}${section("B", 12)}<p id=out></p></main>`;
// 카드 40개 × 버튼 3개.
const card = (i) => `<div><a href="/c/${i}">상품 ${i}</a><div><button>찜</button><button>비교</button><button>공유</button></div></div>`;
const CARDS40 = `<title>카드</title><main>${Array.from({ length: 40 }, (_, i) => card(i)).join("")}<p id=out></p></main>`;
const CARDS2 = `<title>카드</title><main>${card(0)}${card(1)}<p id=out></p></main>`;
const WHOLE = `<title>통째</title><main><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/w/${i}">이름${i} ${2000 + i}원</a></li>`).join("")}</ul><p id=out></p></main>`;
const NAV = `<title>내비</title><nav><ul>${Array.from({ length: 5 }, (_, i) => `<li><a href="/m/${i}">메뉴${i}</a></li>`).join("")}</ul></nav><main><ul>${Array.from({ length: 12 }, (_, i) => product(i)).join("")}</ul><p id=out></p></main>`;
// 입력값 보호: 카드 안 textarea 값·편집 영역·숨은 글자.
const SECRET = `<title>보호</title><main><ul>${Array.from({ length: 3 }, (_, i) => product(i, `<textarea class=memo></textarea><div contenteditable=true class=ed></div><span hidden>숨은글</span>`)).join("")}</ul><p id=out></p></main>
<script>for (const t of document.querySelectorAll(".memo")) t.value = "비밀값"; for (const e of document.querySelectorAll(".ed")) e.textContent = "편집글";</script>`;
const LONG = `<title>긴</title><main><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/l/${i}">긴 상품 ${i}</a><p>${"설명 ".repeat(300)}</p>${Array.from({ length: 9 }, (_, k) => `<button>옵션${k}</button>`).join("")}</li>`).join("")}</ul><p id=out></p></main>`;
const BIG = `<title>큰</title><nav>${Array.from({ length: 3100 }, (_, i) => `<a href="/n/${i}">링크${i}</a>`).join(" ")}</nav><main><ul>${Array.from({ length: 3 }, (_, i) => product(i)).join("")}</ul><p id=out></p></main>`;
const OPTIONS = `<title>옵션</title><main><button aria-haspopup=listbox aria-expanded=true aria-controls=lb>색상</button><ul role=listbox id=lb>${["빨강", "파랑", "검정"].map((c) => `<li role=option>${c}</li>`).join("")}</ul><p id=out></p></main>`;

const clear = (h) => h.sw.evaluate(() => { globalThis.__modelReqs = []; });
const modelReqText = (h) => h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs ?? []));

export default [
  {
    name: "섹션 안 상품: 상품 항목 24개(가격 포함), 섹션 항목은 안쪽 상품 글자 없이, 가격으로 고른 상품을 누른다",
    pages: { "/s": SECTIONS },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([items({ limit: 60 }), { clickItem: "1007원", target: "맥북" }, { text: "끝" }], { path: "/s" });
      const res = lastTool(r, "find_clickables").result;
      const prods = res.items.filter((x) => x.text.includes("원") && x.text.includes("맥북"));
      expect(prods.length === 24, `상품 항목 24개(${prods.length})`);
      expect(prods.every((x) => x.targets.length === 2 && x.targets.some((t) => t.text === "찜")), "상품 항목마다 제목 링크·찜");
      const secs = res.items.filter((x) => x.text.includes("카테고리"));
      expect(secs.length === 2 && secs.every((x) => !x.text.includes("맥북") && x.text.includes("합계")), `섹션 항목(${JSON.stringify(secs.map((x) => x.text))})`);
      expect(res.outside === 1, `항목 밖 필터 버튼(${res.outside})`);
      okResult(r, "click_element");
      expect(r.url.endsWith("/p/7"), `고른 상품으로 이동(${r.url})`);
    },
  },
  {
    name: "query는 항목 글자(가격)에 맞고 limit 뒤쪽 항목도 찾는다",
    pages: { "/s": SECTIONS },
    async run(h) {
      const r = await h.turn([items({ query: "1020원", limit: 3 }), { text: "끝" }], { path: "/s" });
      const res = okResult(r, "find_clickables");
      expect(res.items[0]?.text.includes("1020원"), `맞는 항목이 앞(${JSON.stringify(res.items.map((x) => x.text))})`);
    },
  },
  {
    name: "카드 40개 × 버튼 3개 → 항목 40개(제목+버튼 3), 카드 2개 × 버튼 3개 → 카드 2 + 버튼 6(한계 고정), 통째 링크 li 12개",
    pages: { "/c40": CARDS40, "/c2": CARDS2, "/w": WHOLE },
    async run(h) {
      let res = okResult(await h.turn([items({ limit: 60 }), { text: "끝" }], { path: "/c40" }), "find_clickables");
      expect(res.items.length === 40 && res.items.every((x) => x.targets.length === 4), `카드 40(${res.items.length}, ${res.items[0]?.targets.length})`);
      res = okResult(await h.turn([items(), { text: "끝" }], { path: "/c2" }), "find_clickables");
      const cards = res.items.filter((x) => x.targets.some((t) => t.text.startsWith("상품")));
      expect(cards.length === 2 && res.items.length === 8, `카드 2 + 버튼 6(${res.items.length})`);
      res = okResult(await h.turn([items(), { text: "끝" }], { path: "/w" }), "find_clickables");
      expect(res.items.length === 12 && res.items[3].text.includes("2003원"), `통째 링크(${res.items.length})`);
    },
  },
  {
    name: "region=main이면 내비 메뉴 항목은 빼고 상품만",
    pages: { "/n": NAV },
    async run(h) {
      const res = okResult(await h.turn([items({ region: "main" }), { text: "끝" }], { path: "/n" }), "find_clickables");
      expect(res.items.length === 12 && res.items.every((x) => x.region === "main" && !x.text.includes("메뉴")), `상품만(${res.items.length})`);
    },
  },
  {
    name: "입력값 보호: 항목 글자·결과·모델 요청에 textarea 값·편집 글자·숨은 글자가 없고, 그 낱말로 찾아도 맞지 않는다",
    pages: { "/x": SECRET },
    async run(h) {
      await clear(h);
      const r = await h.turn([items(), { tool: "find_clickables", args: {} }, { text: "끝" }], { path: "/x" });
      const res = okResult(r, "find_clickables");
      expect(Array.isArray(res), "두 번째(list) 결과");
      const all = await modelReqText(h);
      expect(!/비밀값|편집글|숨은글/.test(all), "모델 요청 전체에 보호 글자 없음");
      // 보호 글자로 찾기: 결과·note에 추출된 보호 글자가 없고 0개(모델 인자로 보낸 낱말은 기록에 남는 것이 정상).
      const r2 = await h.turn([items({ query: "비밀값" }), { tool: "find_clickables", args: { query: "편집글", matchContext: true } }, { text: "끝" }], { path: "/x" });
      const a = r2.tools.filter((t) => t.name === "find_clickables").slice(-2).map((t) => t.result);
      expect(a.length === 2 && a[0].items.length === 0 && a[1].items?.length === 0, `0개(${JSON.stringify(a).slice(0, 300)})`);
      expect(!JSON.stringify(a).includes("비밀값") && !JSON.stringify(a).includes("편집글"), "결과·note에 보호 글자 없음");
    },
  },
  {
    name: "긴 항목은 textTruncated, 대상 9개는 8개 + moreTargets",
    pages: { "/l": LONG },
    async run(h) {
      const res = okResult(await h.turn([items(), { text: "끝" }], { path: "/l" }), "find_clickables");
      const it = res.items[0];
      expect(it.textTruncated === true && it.text.length <= 400, `잘림(${it.text.length})`);
      expect(it.targets.length === 8 && it.moreTargets === 2, `대상 제한(${it.targets.length}, ${it.moreTargets})`);
    },
  },
  {
    name: "대상이 많으면 앞쪽 3,000개까지만 보고 알리고, region으로 좁히면 찾는다",
    pages: { "/b": BIG },
    async run(h) {
      let res = okResult(await h.turn([items(), { text: "끝" }], { path: "/b" }), "find_clickables");
      expect(res.scanLimited === true && String(res.note).includes("3,000"), `상한 안내(${res.note})`);
      res = okResult(await h.turn([items({ region: "main" }), { text: "끝" }], { path: "/b" }), "find_clickables");
      expect(res.items.length === 3 && !res.scanLimited, `main 상품(${res.items.length})`);
    },
  },
  {
    name: "찾은 뒤 그 항목의 가격만 바뀌면(버튼 노드는 그대로) 누르지 않는다 — 자동 실행",
    pages: { "/s": SECTIONS },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const turn = h.turn([items({ limit: 60 }), { clickItem: "1005원", target: "찜", delayMs: 600 }, { repeatLastClick: true }, { text: "끝" }], { path: "/s" });
      for (let i = 0; i < 50 && !(await h.sw.evaluate(() => (globalThis.__toolLog ?? []).some((t) => t.name === "find_clickables"))); i++) await h.tab.waitForTimeout(100);
      await h.tab.evaluate(() => {
        for (const s of document.querySelectorAll("li span")) if (s.textContent === "1005원") s.textContent = "9999원";
      });
      const r = await turn;
      // 첫 클릭은 기존 행 문맥 검사(행 내용 바뀜 — 같은 id 재호출 안내), 같은 id로 다시 불러도 항목 검사가 막는다.
      const clicks = r.tools.filter((t) => t.name === "click_element").slice(-2);
      expect(clicks.length === 2 && clicks.every((c) => String(c.error ?? "").includes("다시 찾으세요")), `둘 다 막힘(${JSON.stringify(clicks)})`);
      expect(String(clicks[1].error).includes("목록 항목"), `재호출은 항목 검사(${clicks[1].error})`);
    },
  },
  {
    name: "묻기 모드: 카드가 뜬 뒤 항목 가격이 바뀌면 승인해도 누르지 않는다",
    pages: { "/s": SECTIONS },
    async run(h) {
      await h.settings({ runMode: "ask" });
      const r = await h.turn([items({ limit: 60 }), { clickItem: "1006원", target: "찜" }, { text: "끝" }], {
        path: "/s",
        onCard: async (card) => {
          await h.tab.evaluate(() => {
            for (const s of document.querySelectorAll("li span")) if (s.textContent === "1006원") s.textContent = "8888원";
          });
          await card.locator(".btn-approve").click();
        },
      });
      const c = lastTool(r, "click_element");
      expect(c && String(c.error ?? "").includes("다시 찾으세요"), `막힘(${JSON.stringify(c)})`);
    },
  },
  {
    name: "실제 입력 켠 자동 실행에서도 항목이 바뀌면 누르지 않는다",
    pages: { "/s": SECTIONS },
    async run(h) {
      await h.settings({ runMode: "auto", trustedInput: true });
      const turn = h.turn([items({ limit: 60 }), { clickItem: "1004원", target: "찜", delayMs: 600 }, { text: "끝" }], { path: "/s" });
      for (let i = 0; i < 50 && !(await h.sw.evaluate(() => (globalThis.__toolLog ?? []).some((t) => t.name === "find_clickables"))); i++) await h.tab.waitForTimeout(100);
      await h.tab.evaluate(() => {
        for (const s of document.querySelectorAll("li span")) if (s.textContent === "1004원") s.textContent = "7777원";
      });
      const r = await turn;
      const c = lastTool(r, "click_element");
      expect(c && String(c.error ?? "").includes("다시 찾으세요"), `막힘(${JSON.stringify(c)})`);
    },
  },
  {
    name: "섹션 항목: 안쪽 상품 뒤의 합계만 바뀌어도 섹션 제목 링크를 누르지 않고, 그대로면 누른다",
    pages: { "/s": SECTIONS },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const turn = h.turn([items({ limit: 60 }), { clickItem: "카테고리 A", delayMs: 600 }, { text: "끝" }], { path: "/s" });
      for (let i = 0; i < 50 && !(await h.sw.evaluate(() => (globalThis.__toolLog ?? []).some((t) => t.name === "find_clickables"))); i++) await h.tab.waitForTimeout(100);
      await h.tab.evaluate(() => { document.getElementById("total-A").textContent = "합계 24000원"; });
      const r = await turn;
      const c = lastTool(r, "click_element");
      expect(c && String(c.error ?? "").includes("다시 찾으세요"), `막힘(${JSON.stringify(c)})`);
      const ok = await h.turn([items({ limit: 60 }), { clickItem: "카테고리 B" }, { text: "끝" }], { path: "/s" });
      okResult(ok, "click_element");
      expect(ok.url.endsWith("/cat/B"), `그대로면 누름(${ok.url})`);
    },
  },
  {
    name: "선택지 항목: 펼친 트리거가 정해진 선택지는 항목으로 나오고 누를 수 있다",
    pages: { "/o": OPTIONS },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([items(), { clickItem: "파랑" }, { text: "끝" }], { path: "/o" });
      const res = lastTool(r, "find_clickables").result;
      expect(res.items.length === 3 && res.items.every((x) => x.targets[0].role === "option"), `선택지 항목(${JSON.stringify(res.items.map((x) => x.text))})`);
      okResult(r, "click_element");
    },
  },
  {
    name: "list 모드 matchContext: 문맥(가격)에만 있는 낱말로 상품 링크를 찾고, 없으면 0개",
    pages: { "/s": SECTIONS },
    async run(h) {
      const r = await h.turn(
        [{ tool: "find_clickables", args: { query: "1003원" } }, { tool: "find_clickables", args: { query: "1003원", matchContext: true } }, { text: "끝" }],
        { path: "/s" },
      );
      const [a, b] = r.tools.filter((t) => t.name === "find_clickables").map((t) => t.result);
      expect(a.items?.length === 0, "matchContext 없으면 0개");
      expect(Array.isArray(b) && b.some((x) => x.text === "맥북 에어" && (x.context ?? "").includes("1003원")), `문맥으로 찾음(${JSON.stringify(b).slice(0, 200)})`);
    },
  },
  {
    name: "list 모드: 긴 묶음 문맥은 contextTruncated",
    pages: { "/l": LONG },
    async run(h) {
      const res = okResult(await h.turn([{ tool: "find_clickables", args: { query: "긴 상품" } }, { text: "끝" }], { path: "/l" }), "find_clickables");
      expect(res[0]?.contextTruncated === true, `잘림 표시(${JSON.stringify(res[0])})`);
    },
  },
  {
    name: "항목 모드 호출은 레시피로 기억되고 다음에 같은 인자로 다시 쓰면 read_recipe:used",
    pages: { "/s": SECTIONS },
    async run(h) {
      await h.turn([items({ query: "맥북" }), { text: "끝" }], { path: "/s" });
      const r = await h.turn([{ tool: "describe_page", args: {} }, items({ query: "맥북" }), { text: "끝" }], { path: "/s" });
      expect(r.logs.some((l) => l.includes("read_recipe:offered") && l.includes("mode='items'")), `제안(${r.logs.filter((l) => l.includes("read_recipe")).join(" | ")})`);
      expect(r.logs.some((l) => l.includes("read_recipe:used") && l.includes("결과 있음")), "사용");
    },
  },
];
