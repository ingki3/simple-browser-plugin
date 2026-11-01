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


// #164: 자기 상자가 없는(display:contents) 항목. 항목마다 400px 높이 블록이라 위쪽 몇 개만 화면 안.
const CONTENTS = `<title>컨텐츠</title><main><ul>${Array.from({ length: 12 }, (_, i) => `<li style="display:contents"><a href="/d/${i}" style="display:block;height:400px">상품${i}</a><span>${5000 + i}원</span></li>`).join("")}</ul><p id=out></p></main>`;
// 숨긴 자식(opacity:0 감싼 링크·visibility:hidden 글자)만 화면 위쪽에 있고 보이는 링크는 화면 밖.
const HIDDEN_KIDS = `<title>숨김</title><main><ul>${Array.from({ length: 3 }, (_, i) => `<li style="display:contents"><div style="opacity:0;position:absolute;top:${10 + i * 20}px"><a href="/h/${i}">숨은상품${i}</a></div><span style="visibility:hidden;position:absolute;top:${100 + i * 20}px">숨김글${i}</span><a href="/v/${i}" style="display:block;margin-top:3000px">상품${i}</a></li>`).join("")}</ul><p id=out></p></main>`;
// 직접 글자만 화면 안(링크는 화면 밖).
const DIRECT_TEXT = `<title>직접</title><main><ul>${Array.from({ length: 3 }, (_, i) => `<li style="display:contents">직접글자${i} <a href="/t/${i}" style="display:block;margin-top:3000px">상품${i}</a></li>`).join("")}</ul><p id=out></p></main>`;
// 긴 주소: data: 3,000자대, 긴 사용자 정의 scheme, 같은 출처 2,500자대 https(누를 수 있음).
const LONG_HREF = `<title>긴주소</title><main><ul>
  <li><a href="data:text/plain,${"x".repeat(3000)}">긴데이터</a><span>1원</span></li>
  <li><a href="${"a".repeat(20000)}:x">이상한</a><span>2원</span></li>
  <li><a id=go href="/go?q=${"y".repeat(2500)}">긴이동</a><span>3원</span></li>
  <li><a href="/short">짧은</a><span>4원</span></li>
</ul><p id=out></p></main>`;
// 첫 항목 예산: 주소가 정확히 2,000자인 대상 8개 + 긴 이름(항목 12개). 주소는 출처에 맞춰 스크립트로 만든다.
const BUDGET = `<title>예산</title><main><ul id=u></ul><p id=out></p></main><script>
  const u = document.getElementById("u");
  for (let i = 0; i < 12; i++) {
    const li = document.createElement("li");
    for (let k = 0; k < 8; k++) {
      const a = document.createElement("a");
      const head = location.origin + "/b" + i + "-" + k + "?q=";
      a.href = head + "z".repeat(2000 - head.length);
      a.textContent = "대상" + i + "-" + k + " " + "이름".repeat(90);
      li.append(a);
    }
    u.append(li);
  }
</script>`;

// 같은 출처 iframe 안의 display:contents 항목(제목 span만 화면 안, 링크는 화면 밖).
const IFRAME_CONTENTS = `<title>프레임</title><main><iframe style="width:600px;height:300px" srcdoc='<ul>${Array.from({ length: 3 }, (_, i) => `<li style="display:contents"><span>제목${i}</span><a href="/f/${i}" style="display:block;margin-top:3000px">상품${i}</a></li>`).join("")}</ul>'></iframe><p id=out></p></main>`;
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
  {
    name: "열린 shadow root 바로 아래의 반복 카드도 항목으로 묶는다",
    pages: {
      "/sh": `<title>섀도</title><main><shop-list></shop-list><p id=out></p></main><script>
        const host = document.querySelector("shop-list");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = [0, 1, 2, 3].map((i) => '<article><a href="/sh/' + i + '">상품' + i + '</a><span>' + (3000 + i) + '원</span></article>').join("");
      </script>`,
    },
    async run(h) {
      const res = okResult(await h.turn([items(), { text: "끝" }], { path: "/sh" }), "find_clickables");
      expect(res.items.length === 4 && res.items[2].text.includes("3002원"), `섀도 항목(${JSON.stringify(res).slice(0, 300)})`);
    },
  },
  {
    name: "#164 display:contents 항목: 화면 위쪽 항목만 onlyViewport로 찾고 inViewport가 맞다",
    pages: { "/dc": CONTENTS },
    async run(h) {
      const all = okResult(await h.turn([items({ limit: 60 }), { text: "끝" }], { path: "/dc" }), "find_clickables");
      expect(all.items.length === 12, `항목 12(${all.items.length})`);
      expect(all.items[0].inViewport === true && all.items[11].inViewport === false, `첫 항목만 화면 안(${all.items.map((x) => x.inViewport).join(",")})`);
      const vis = okResult(await h.turn([items({ onlyViewport: true }), { text: "끝" }], { path: "/dc" }), "find_clickables");
      expect(vis.items.length > 0 && vis.items.length < 12 && vis.items[0].text.includes("5000원"), `화면 안만(${vis.items.length})`);
    },
  },
  {
    name: "#164 display:contents 항목: 숨긴 자식만 화면 안이면 화면 밖, 직접 글자가 화면 안이면 화면 안",
    pages: { "/hk": HIDDEN_KIDS, "/dt": DIRECT_TEXT },
    async run(h) {
      const hk = okResult(await h.turn([items({ limit: 60 }), { text: "끝" }], { path: "/hk" }), "find_clickables");
      const prods = hk.items.filter((x) => x.targets.some((t) => t.text.startsWith("상품")));
      expect(prods.length === 3 && prods.every((x) => x.inViewport === false), `숨긴 자식은 세지 않음(${JSON.stringify(hk.items.map((x) => [x.text, x.inViewport]))})`);
      const hv = okResult(await h.turn([items({ onlyViewport: true }), { text: "끝" }], { path: "/hk" }), "find_clickables");
      expect(hv.items.length === 0, `onlyViewport 0(${hv.items.length})`);
      const dt = okResult(await h.turn([items({ onlyViewport: true }), { text: "끝" }], { path: "/dt" }), "find_clickables");
      expect(dt.items.length >= 1 && dt.items[0].text.includes("직접글자0"), `직접 글자 항목(${JSON.stringify(dt.items.map((x) => x.text))})`);
    },
  },
  {
    name: "#164 긴 주소: list·items 모두 href를 비우고 hrefTooLong(길이·짧은 scheme만)과 안내, 그 대상은 id로 누른다",
    pages: { "/lh": LONG_HREF, "/go": "<title>도착</title><p>도착</p>" },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "긴이동" }, { text: "끝" }], { path: "/lh" });
      const res = lastTool(r, "find_clickables").result;
      const list = res.items;
      const by = (t) => list.find((x) => x.text === t);
      expect(by("긴데이터")?.href === "" && by("긴데이터").hrefTooLong?.scheme === "data:" && by("긴데이터").hrefTooLong.length > 3000, `data(${JSON.stringify(by("긴데이터")?.hrefTooLong)})`);
      expect(by("이상한")?.href === "" && by("이상한").hrefTooLong && !("scheme" in by("이상한").hrefTooLong), `긴 scheme 생략(${JSON.stringify(by("이상한")?.hrefTooLong)})`);
      expect(by("짧은")?.href.endsWith("/short") && !by("짧은").hrefTooLong, "짧은 주소는 그대로");
      expect(String(res.note ?? "").includes("주소가 너무 긴") && res.note.includes("3개"), `안내(${res.note})`);
      expect(JSON.stringify(res).length < 4000, `결과가 작다(${JSON.stringify(res).length})`);
      okResult(r, "click_element");
      expect(r.url.includes("/go?q=yyy"), `원래 주소로 이동(${r.url.slice(0, 80)})`);
      const it = okResult(await h.turn([items(), { text: "끝" }], { path: "/lh" }), "find_clickables");
      const ts = it.items.flatMap((x) => x.targets);
      expect(ts.filter((t) => t.hrefTooLong).length === 3 && ts.every((t) => t.href.length <= 2000), `items도(${JSON.stringify(ts.map((t) => t.hrefTooLong ?? t.href.length))})`);
      expect(String(it.note ?? "").includes("주소가 너무 긴"), `items 안내(${it.note})`);
    },
  },
  {
    name: "#164 첫 항목이 예산을 넘으면 대상을 줄이고 moreTargets에 더하며, 다음 항목은 누적 예산으로",
    pages: { "/bg": BUDGET },
    async run(h) {
      const res = okResult(await h.turn([items({ limit: 60 }), { text: "끝" }], { path: "/bg" }), "find_clickables");
      const first = res.items[0];
      expect(first && first.targets.length >= 1 && first.targets.length < 8, `첫 항목 대상 축소(${first?.targets.length})`);
      expect(first.moreTargets === 8 - first.targets.length, `moreTargets(${first.moreTargets})`);
      expect(first.targets.every((t) => t.href.length === 2000 && !t.hrefTooLong), "정확히 2,000자는 그대로");
      const size = (it) => it.text.length + it.targets.reduce((n, t) => n + t.text.length + t.href.length + t.role.length, 0);
      expect(size(first) <= 16000, `첫 항목 예산 안(${size(first)})`);
      expect(res.items.length === 1 && res.omittedItems === 11, `다음 항목은 누적 예산으로 뺌(${res.items.length}/${res.omittedItems})`);
    },
  },
  {
    name: "#164 긴 주소 대상: 찾은 뒤·카드가 뜬 뒤 같은 길이의 다른 주소로 바뀌면 누르지 않는다",
    pages: { "/lh": LONG_HREF, "/go": "<title>도착</title><p>도착</p>" },
    async run(h) {
      const swap = () =>
        h.tab.evaluate(() => {
          const a = document.getElementById("go");
          a.href = a.getAttribute("href").replace(/y/g, "w");
        });
      await h.settings({ runMode: "auto" });
      const turn = h.turn([{ tool: "find_clickables", args: {} }, { click: "긴이동", delayMs: 600 }, { text: "끝" }], { path: "/lh" });
      for (let i = 0; i < 50 && !(await h.sw.evaluate(() => (globalThis.__toolLog ?? []).some((t) => t.name === "find_clickables"))); i++) await h.tab.waitForTimeout(100);
      await swap();
      let r = await turn;
      let c = lastTool(r, "click_element");
      expect(c && c.error && !r.url.includes("/go"), `찾은 뒤 바뀜(${JSON.stringify(c?.error)})`);
      await h.settings({ runMode: "ask" });
      r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "긴이동" }, { text: "끝" }], {
        path: "/lh",
        onCard: async (card) => {
          await swap();
          await card.locator(".btn-approve").click();
        },
      });
      c = lastTool(r, "click_element");
      expect(c && c.error && !r.url.includes("/go"), `카드 뒤 바뀜(${JSON.stringify(c?.error)})`);
    },
  },
  {
    name: "#164 같은 출처 iframe 안의 display:contents 항목도 자식 상자로 화면 판정",
    pages: { "/if": IFRAME_CONTENTS },
    async run(h) {
      await h.tab.waitForTimeout(300);
      const res = okResult(await h.turn([items({ onlyViewport: true }), { text: "끝" }], { path: "/if" }), "find_clickables");
      // 첫 항목의 제목만 화면 안(뒤 항목은 앞 링크의 margin 아래). instanceof로 판정하면 0개였다.
      expect(res.items.length === 1 && res.items[0].text.includes("제목0") && res.items[0].inViewport, `iframe 항목(${JSON.stringify(res.items.map((x) => [x.text, x.inViewport]))})`);
    },
  },
];
