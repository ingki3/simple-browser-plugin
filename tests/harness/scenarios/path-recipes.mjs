// 경로 레시피(#297 2단계): 같은 출처 안에서 답을 마친 이동 경로를 주소 틀로 기억했다가 describe_page의 pathHints로 낸다.
// 성공 예시는 신호에 걸리지 않는 주소(/help/notice/list)로, 주문·삭제 주소는 저장되지 않는 쪽으로 본다.
// 경로는 턴이 끝난 뒤(원래 탭이 다 뜨기·요청 대응을 기다려) 저장되므로, 결과 로그(path_recipe:result·skip)를 기다린 뒤 확인한다.
// 이벤트 지연·순서 뒤바뀜처럼 실제 Chrome으로 만들 수 없는 것은 단위 시험(tests/pathRecipes.test.mjs)이 본다.
import { ask, duringTurn, expect, findC, okResult, waitUntil } from "../lib.mjs";

const describe = { tool: "describe_page", args: {} };
const go = (h, path) => ({ tool: "navigate_to_url", args: { url: h.base + path } });

const HOME = `<title>홈</title><main>
<a href="/help">도움말</a> <a href="/mypage/order/list">주문 내역</a> <a href="/item/delete">항목 지우기</a>
<a href="/tobase2">다른 사이트</a> <a href="/bounce">돌아오기</a><p id=out></p></main>`;
const HELP = `<title>도움말</title><main>
<a href="/help/notice/list">공지</a> <a href="/help/dead">막다른 길</a> <a href="/help/faq">자주 묻는 질문</a>
<a href="/help/faq" target="_blank">새 창</a>
<button onclick="location.href='/help/notice/list'">삭제</button><p id=out></p></main>`;
const DEAD = `<title>막다른 길</title><main><a href="/help">도움말로</a><p id=out></p></main>`;
const NOTICE = `<title>공지</title><main><h1>공지 목록</h1><a href="/help/faq">자주 묻는 질문</a><p id=out></p></main>`;
const FAQ = `<title>FAQ</title><main><h1>자주 묻는 질문</h1><p id=out></p></main>`;
const BACK_HOME = (t) => `<title>${t}</title><main><a href="/help">도움말</a><p id=out></p></main>`;
const APP = `<title>앱</title><main><button onclick="history.pushState({}, '', '/app/inbox');document.getElementById('out').textContent='받음'">받은 편지</button><p id=out></p></main>`;
const FORM = `<title>찾기</title><main><form onsubmit="event.preventDefault()">
<label>검색어 <input name=q></label><label>메모 <input name=memo></label></form>
<a href="/help">도움말</a><p id=out></p></main>`;
const PAGES = {
  "/": HOME,
  "/help": HELP,
  "/help/dead": DEAD,
  "/help/notice/list": NOTICE,
  "/help/faq": FAQ,
  "/mypage/order/list": BACK_HOME("주문 내역"),
  "/item/delete": BACK_HOME("지움"),
  "/app": APP,
  "/form": FORM,
  "/slow2/notice": NOTICE,
  "/slow4/notice": NOTICE,
};
const PAGES2 = { "/x": `<title>다른 곳</title><main><p id=out></p></main>`, "/relay": "<p>relay</p>" };

// /tobase2: 다른 출처로, /bounce: 다른 출처를 거쳐 같은 출처의 /help로 돌아오는 리다이렉트(A→B→A).
function routes(h) {
  h.routes.set("1/tobase2", (q, r, { base2 }) => {
    r.writeHead(302, { location: `${base2}/x` });
    r.end();
  });
  h.routes.set("1/bounce", (q, r, { base2 }) => {
    r.writeHead(302, { location: `${base2}/relay` });
    r.end();
  });
  h.routes.set("2/relay", (q, r, { base }) => {
    r.writeHead(302, { location: `${base}/help` });
    r.end();
  });
}

const stored = (h) =>
  h.sw.evaluate(async () => ((await chrome.storage.local.get("pathRecipes")).pathRecipes ?? []).map((r) => r.steps.join(" ")).sort());
const records = (h) => h.sw.evaluate(async () => (await chrome.storage.local.get("pathRecipes")).pathRecipes ?? []);

// mark 뒤에 남은 경로 기록 결과 로그 하나(성공 또는 건너뜀 사유).
async function outcome(h, mark, label = "경로 기록 결과") {
  const line = await waitUntil(() => h.logs.slice(mark).find((l) => l.includes("[SBP path_recipe:result]") || l.includes("[SBP path_recipe:skip]")), {
    timeoutMs: 10_000,
    label,
    detail: () => h.logs.slice(mark).filter((l) => l.includes("path_recipe")).join(" | ") || "경로 로그 없음",
  });
  return line;
}
// 한 턴을 돌리고 경로 기록 결과까지 기다린다.
async function walk(h, steps, opts = {}) {
  const mark = h.logs.length;
  const r = await h.turn(steps, { approve: true, ...opts });
  const out = await outcome(h, mark);
  return { r, out, mark };
}
const skipped = (out, code) => out.includes("[SBP path_recipe:skip]") && (!code || out.includes(code));

// 기록을 지우지 않고 새 대화로(패널을 다시 연다).
async function newChat(h) {
  await h.panel.goto(`chrome-extension://${h.extId}/src/sidepanel/index.html`);
  await h.panel.waitForTimeout(500);
  await h.tab.bringToFront();
}

async function closeExtraTabs(h) {
  for (const p of h.ctx.pages()) if (p !== h.tab && p !== h.panel && !p.url().startsWith(h.optionsUrl)) await p.close().catch(() => {});
  await h.tab.bringToFront();
}

const HOME_TO_NOTICE = [findC, { click: "도움말" }, findC, { click: "공지" }, { text: "공지 목록입니다" }];

async function seed(h) {
  const { out } = await walk(h, HOME_TO_NOTICE, { path: "/" });
  expect(out.includes("path_recipe:result"), `경로 저장(${out})`);
  expect(JSON.stringify(await stored(h)) === JSON.stringify(["/ /help /help/notice/list"]), `저장된 경로(${JSON.stringify(await stored(h))})`);
}

const base = { pages: PAGES, pages2: PAGES2 };

export default [
  {
    name: "1. 홈 → 도움말 → 공지 목록(묻기 방식에서 카드로 승인)으로 답을 마친 뒤 새 대화에서 홈을 관측하면 pathHints가 붙고 direct가 맞다. 중간 페이지에서는 남은 구간만",
    ...base,
    async run(h) {
      routes(h);
      await seed(h);
      await newChat(h);
      const r = await h.turn([describe, { text: "봤음" }], { path: "/" });
      const hints = okResult(r, "describe_page").pathHints;
      expect(
        JSON.stringify(hints) === JSON.stringify([{ steps: [{ pattern: "/help", direct: true }, { pattern: "/help/notice/list", direct: true }], uses: 1 }]),
        `홈에서 낸 후보(${JSON.stringify(hints)})`,
      );
      expect(h.logs.some((l) => l.includes("[SBP path_recipe:offered]") && !l.includes(h.base)), "제시 로그는 틀만(원본 주소 없음)");
      const mid = await h.turn([describe, { text: "봤음" }], { path: "/help" });
      const midHints = okResult(mid, "describe_page").pathHints;
      expect(JSON.stringify(midHints) === JSON.stringify([{ steps: [{ pattern: "/help/notice/list", direct: true }], uses: 1 }]), `중간 페이지는 남은 구간만(${JSON.stringify(midHints)})`);
      const end = await h.turn([describe, { text: "봤음" }], { path: "/help/notice/list" });
      expect(okResult(end, "describe_page").pathHints === undefined, "도착 페이지에는 후보가 없음");
    },
  },
  {
    name: "2. 막다른 길을 거친 턴은 되감긴 경로로 저장한다",
    ...base,
    async run(h) {
      await h.settings({ autoApprove: true });
      const { out } = await walk(h, [findC, { click: "도움말" }, findC, { click: "막다른 길" }, findC, { click: "도움말로" }, findC, { click: "공지" }, { text: "끝" }], { path: "/" });
      expect(out.includes("path_recipe:result"), out);
      expect(JSON.stringify(await stored(h)) === JSON.stringify(["/ /help /help/notice/list"]), `되감긴 경로(${JSON.stringify(await stored(h))})`);
    },
  },
  {
    name: "3. 저장되지 않는 턴: 다른 출처, 출처 왕복 리다이렉트, 주문 주소, 삭제 주소, 일반 주소의 삭제 버튼 승인, 외부 본문 보호, 중단, 새 탭 따라감",
    ...base,
    async run(h) {
      routes(h);
      await h.settings({ autoApprove: true });
      const cases = [
        ["다른 출처", [findC, { click: "다른 사이트" }, { text: "끝" }], "/", "cross_origin"],
        ["출처 왕복 리다이렉트", [findC, { click: "돌아오기" }, findC, { click: "공지" }, { text: "끝" }], "/", "cross_origin"],
        ["주문 주소", [findC, { click: "주문 내역" }, findC, { click: "도움말" }, { text: "끝" }], "/", "sensitive"],
        ["삭제 주소", [findC, { click: "항목 지우기" }, findC, { click: "도움말" }, { text: "끝" }], "/", null],
        ["일반 주소의 삭제 버튼", [findC, { click: "도움말" }, findC, { click: "삭제" }, { text: "끝" }], "/", "shadow_card"],
      ];
      for (const [name, steps, path, code] of cases) {
        const { out } = await walk(h, steps, { path });
        expect(skipped(out, code), `${name}: 저장 안 함(${out})`);
        expect((await stored(h)).length === 0, `${name}: 저장소 비어 있음(${JSON.stringify(await stored(h))})`);
      }
      // 외부 본문 보호: 링크한 페이지를 읽은 대화(보호 켜짐)의 이동은 저장하지 않는다.
      await newChat(h);
      const mark = h.logs.length;
      await h.turn([{ tool: "read_linked_pages", args: { urls: [`${h.base}/help/faq`] } }, findC, { click: "도움말" }, { text: "끝" }], { path: "/", approve: true });
      await h.tab.waitForTimeout(1500);
      expect(!h.logs.slice(mark).some((l) => l.includes("[SBP path_recipe:result]")), "외부 본문 보호 중에는 저장 안 함");
      expect((await stored(h)).length === 0, "외부 본문 보호: 저장소 비어 있음");
      // 중단: 이동한 뒤 답 스트림을 붙잡고 중단한다.
      await newChat(h);
      const m2 = h.logs.length;
      const turn = h.turn([findC, { click: "도움말" }, { textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }], { path: "/", keepRunning: true });
      await duringTurn(turn, async () => {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), { label: "답 스트림 붙잡힘" });
        await h.panel.click("button.composer-btn.danger");
        await h.sw.evaluate(() => globalThis.__releaseStream());
      });
      await turn;
      await h.tab.waitForTimeout(1500);
      expect(!h.logs.slice(m2).some((l) => l.includes("[SBP path_recipe:result]")), "중단한 턴은 저장 안 함");
      expect((await stored(h)).length === 0, "중단: 저장소 비어 있음");
      // 새 탭 따라감.
      await closeExtraTabs(h);
      try {
        await newChat(h);
        const { out } = await walk(h, [findC, { click: "도움말" }, findC, { click: "새 창" }, { text: "끝" }], { path: "/" });
        expect(skipped(out, "popup"), `새 탭 따라감: 저장 안 함(${out})`);
        expect((await stored(h)).length === 0, "새 탭: 저장소 비어 있음");
      } finally {
        await closeExtraTabs(h);
      }
      // 대조: 같은 출처의 일반 이동은 저장된다(위 거부가 시나리오 탓이 아님).
      await newChat(h);
      const ok = await walk(h, HOME_TO_NOTICE, { path: "/" });
      expect(ok.out.includes("path_recipe:result"), `대조 저장(${ok.out})`);
    },
  },
  {
    name: "4. 이동 직후 답을 마친 턴(느린 페이지)은 다 뜬 최종 주소로 저장되거나 제때 안 뜨면 저장 안 함. SPA(pushState) 이동도 걸음으로 잡힌다",
    ...base,
    async run(h) {
      await h.settings({ autoApprove: true });
      const slow = await walk(h, [go(h, "/slow2/notice"), { text: "갔음" }], { path: "/" });
      expect(slow.out.includes("path_recipe:result"), `느린 페이지(2초)는 다 뜬 뒤 저장(${slow.out})`);
      const s = await stored(h);
      expect(s.length === 1 && s[0].startsWith("/ ") && s[0].endsWith("/notice"), `최종 주소로(${JSON.stringify(s)})`);
      await newChat(h);
      const slower = await walk(h, [go(h, "/slow4/notice"), { text: "갔음" }], { path: "/" });
      expect(skipped(slower.out, "not_loaded") || skipped(slower.out, "final_mismatch"), `제때 안 뜨면 저장 안 함(${slower.out})`);
      expect((await stored(h)).length === 1, "느린 페이지(4초)는 저장되지 않음");
      await newChat(h);
      const spa = await walk(h, [findC, { click: "받은 편지" }, { text: "열었음" }], { path: "/app" });
      expect(spa.out.includes("path_recipe:result"), `SPA 이동 저장(${spa.out})`);
      expect((await stored(h)).includes("/app /app/inbox"), `SPA 걸음(${JSON.stringify(await stored(h))})`);
    },
  },
  {
    name: "5. 후보가 있어도 묻기 방식에서 navigate_to_url은 카드가 뜬다",
    ...base,
    async run(h) {
      await seed(h);
      await newChat(h);
      await h.settings({ runMode: "ask" });
      const r = await h.turn([describe, go(h, "/help/notice/list")], { path: "/" });
      expect(okResult(r, "describe_page").pathHints?.length === 1, "후보가 붙음");
      expect(r.stoppedAtCard, "이동은 카드로 묻는다");
    },
  },
  {
    name: "6. 중간 페이지에서 후보를 따라 도착하면 원래 경로의 쓴 횟수가 오르고 새 경로는 안 생긴다. 도착 틀에 닿고 다른 곳에서 답을 마치기를 3번 하면 후보가 사라진다",
    ...base,
    async run(h) {
      await seed(h);
      await h.settings({ autoApprove: true });
      await newChat(h);
      const follow = await walk(h, [describe, findC, { click: "공지" }, { text: "끝" }], { path: "/help" });
      expect(follow.out.includes("path_recipe:result"), follow.out);
      const recs = await records(h);
      expect(recs.length === 1 && recs[0].uses === 2, `원래 경로 uses 2, 새 경로 없음(${JSON.stringify(recs.map((r) => [r.steps, r.uses]))})`);
      for (let i = 1; i <= 3; i++) {
        await newChat(h);
        await walk(h, [describe, findC, { click: "공지" }, findC, { click: "자주 묻는 질문" }, { text: "끝" }], { path: "/help" });
        const main = (await records(h)).find((r) => r.steps.join(" ") === "/ /help /help/notice/list");
        if (i < 3) expect(main?.misses === i, `빗나감 ${i}(${JSON.stringify(main)})`);
        else expect(!main, "3번 빗나가면 버림");
      }
      await newChat(h);
      const r = await h.turn([describe, { text: "봤음" }], { path: "/" });
      const hints = okResult(r, "describe_page").pathHints ?? [];
      expect(!hints.some((x) => x.steps.at(-1)?.pattern === "/help/notice/list"), `사라진 후보(${JSON.stringify(hints)})`);
    },
  },
  {
    name: "7. 설정 화면에 경로가 보이고 지우면 다음 관측에서 빠진다. 턴 도중 지우면 되살아나지 않는다. 기록을 끄면 저장·제시 없음",
    ...base,
    async run(h) {
      await seed(h);
      const opt = await h.openOptions("records");
      await waitUntil(async () => (await opt.locator(".field-help", { hasText: "이동 경로 1개" }).count()) > 0, { label: "개수 줄" });
      await opt.locator(".recipe-view > summary").click();
      const row = opt.locator(".recipe-path-row");
      await waitUntil(async () => (await row.count()) === 1, { label: "경로 행" });
      const text = await row.innerText();
      expect(text.includes("/ → /help → /help/notice/list") && text.includes("쓴 횟수 1번"), `행 글자(${text})`);
      await row.locator(".recipe-delete").click();
      await waitUntil(async () => (await stored(h)).length === 0, { label: "지움" });
      await newChat(h);
      const r = await h.turn([describe, { text: "봤음" }], { path: "/" });
      expect(okResult(r, "describe_page").pathHints === undefined, "지운 경로는 제시 안 함");

      // 턴 도중(답 스트림을 붙잡은 사이) 같은 출처의 경로를 지우면 그 턴은 저장하지 않는다.
      await seed(h);
      await h.settings({ autoApprove: true });
      await newChat(h);
      await waitUntil(async () => (await opt.locator(".recipe-path-row").count()) === 1, { label: "다시 생긴 행" });
      const mark = h.logs.length;
      const turn = h.turn([findC, { click: "도움말" }, findC, { click: "자주 묻는 질문" }, { textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }], { path: "/" });
      await duringTurn(turn, async () => {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), { label: "답 스트림 붙잡힘" });
        await opt.locator(".recipe-path-row .recipe-delete").click();
        await waitUntil(async () => (await stored(h)).length === 0, { label: "턴 도중 지움" });
        await h.sw.evaluate(() => globalThis.__releaseStream());
      });
      await turn;
      const out = await outcome(h, mark);
      expect(skipped(out, "deleted"), `지운 뒤 끝난 턴은 저장 안 함(${out})`);
      expect((await stored(h)).length === 0, `되살아나지 않음(${JSON.stringify(await stored(h))})`);
      await opt.close();

      // 기록을 끄면 저장하지도 내지도 않는다.
      await seed(h);
      await h.settings({ actionLogEnabled: false });
      await newChat(h);
      const off = await h.turn([describe, { text: "봤음" }], { path: "/" });
      expect(okResult(off, "describe_page").pathHints === undefined, "기록 끔: 제시 없음");
      const m2 = h.logs.length;
      await h.turn([findC, { click: "도움말" }, findC, { click: "자주 묻는 질문" }, { text: "끝" }], { path: "/", approve: true });
      await outcome(h, m2);
      expect(JSON.stringify(await stored(h)) === JSON.stringify(["/ /help /help/notice/list"]), "기록 끔: 새 경로 없음");
    },
  },
  {
    name: "8. 두 패널 대화가 이어서 돌면 각각 저장되고, 다른 탭이어도 두 턴이 겹치면 둘 다 저장 안 함",
    ...base,
    pages2: { ...PAGES2, "/": HOME.replaceAll('href="/tobase2"', 'href="/x"'), "/help": HELP, "/help/notice/list": NOTICE, "/help/faq": FAQ },
    async run(h) {
      await h.settings({ autoApprove: true });
      const tab2 = await h.ctx.newPage();
      const panel2 = await h.ctx.newPage();
      // 활성 탭 조회를 표시한 출처의 탭으로 고른다(대화마다 다른 탭).
      await h.sw.evaluate(() => {
        if (globalThis.__pickWrapped) return;
        globalThis.__pickWrapped = true;
        const prev = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (q) => {
          const all = await prev(q);
          if (q && q.active && q.lastFocusedWindow && globalThis.__activeOrigin) return all.filter((t) => (t.url ?? "").startsWith(globalThis.__activeOrigin));
          return all;
        };
      });
      const pick = (origin) => h.sw.evaluate((o) => (globalThis.__activeOrigin = o), origin);
      const send = async (panel, text) => {
        await panel.fill("textarea.composer-input", text);
        await panel.click("button.composer-btn.primary");
      };
      const idle = (panel) => waitUntil(async () => !(await panel.locator("button.composer-btn.danger").count()), { timeoutMs: 20_000, label: "턴 끝" });
      const steps = (s) => h.sw.evaluate((x) => globalThis.__steps.push(...x), s);
      try {
        await panel2.goto(`chrome-extension://${h.extId}/src/sidepanel/index.html`);
        await tab2.goto(h.base2 + "/");
        await h.tab.goto(h.base + "/");
        // 이어서(겹치지 않게): 패널 1은 탭 1(서버 1), 패널 2는 탭 2(서버 2).
        await pick(h.base);
        let mark = h.logs.length;
        await steps(HOME_TO_NOTICE);
        await send(h.panel, "공지 찾아 줘");
        await idle(h.panel);
        await outcome(h, mark);
        await pick(h.base2);
        mark = h.logs.length;
        await steps([findC, { click: "도움말" }, findC, { click: "자주 묻는 질문" }, { text: "끝" }]);
        await send(panel2, "FAQ 찾아 줘");
        await idle(panel2);
        await outcome(h, mark);
        const both = (await records(h)).map((r) => `${r.origin === h.base ? 1 : 2} ${r.steps.join(" ")}`).sort();
        expect(JSON.stringify(both) === JSON.stringify(["1 / /help /help/notice/list", "2 / /help /help/faq"]), `각각 저장, 섞이지 않음(${JSON.stringify(both)})`);

        // 겹침: 패널 1의 턴을 답 스트림에서 붙잡은 사이 패널 2의 턴이 다른 탭에서 시작해 끝난다.
        await h.sw.evaluate(() => chrome.storage.local.remove("pathRecipes"));
        await h.tab.goto(h.base + "/");
        await tab2.goto(h.base2 + "/");
        await pick(h.base);
        mark = h.logs.length;
        await steps([findC, { click: "도움말" }, findC, { click: "공지" }, { textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }]);
        await send(h.panel, "공지 찾아 줘");
        await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), { label: "패널 1 붙잡힘" });
        await pick(h.base2);
        await steps([findC, { click: "도움말" }, findC, { click: "자주 묻는 질문" }, { text: "끝" }]);
        await send(panel2, "FAQ 찾아 줘");
        await idle(panel2);
        await h.sw.evaluate(() => globalThis.__releaseStream());
        await idle(h.panel);
        await waitUntil(() => h.logs.slice(mark).filter((l) => l.includes("[SBP path_recipe:")).filter((l) => /path_recipe:(result|skip)/.test(l)).length >= 2, { label: "두 턴의 결과" });
        const lines = h.logs.slice(mark).filter((l) => /path_recipe:(result|skip)/.test(l));
        expect(lines.every((l) => l.includes("overlap")), `둘 다 겹침으로 저장 안 함(${lines.join(" | ")})`);
        expect((await stored(h)).length === 0, `저장소 비어 있음(${JSON.stringify(await stored(h))})`);
      } finally {
        await pick(null);
        await panel2.close().catch(() => {});
        await tab2.close().catch(() => {});
        await h.tab.bringToFront();
      }
    },
  },
  {
    name: "9. 그림자 판정: 일반 글자 칸에 전화번호 모양 값을 넣은 턴은 묻기·자동·맡기기 어느 방식에서도 저장 안 함, 여러 칸 중 하나만 신호가 있어도 같음",
    ...base,
    async run(h) {
      const findF = { tool: "find_form_fields", args: {} };
      const approveAll = async (card) => card.locator(".btn-approve").click();
      // 대조: 평범한 값이면 저장된다.
      await h.settings({ autoApprove: true });
      const ok = await walk(h, [findF, { fill: "검색어", value: "노트북" }, findC, { click: "도움말" }, { text: "끝" }], { path: "/form" });
      expect(ok.out.includes("path_recipe:result"), `평범한 값은 저장(${ok.out})`);
      await h.sw.evaluate(() => chrome.storage.local.remove("pathRecipes"));
      for (const runMode of ["ask", "auto", "task"]) {
        await h.settings({ runMode });
        await newChat(h);
        const { out } = await walk(h, [findF, { fill: "검색어", value: "010-1234-5678" }, findC, { click: "도움말" }, { text: "끝" }], { path: "/form", onCard: approveAll });
        expect(skipped(out, "shadow_card"), `${runMode}: 저장 안 함(${out})`);
        expect((await stored(h)).length === 0, `${runMode}: 저장소 비어 있음`);
      }
      await h.settings({ runMode: "auto" });
      await newChat(h);
      const many = await walk(
        h,
        [findF, { fillMany: [{ label: "검색어", value: "노트북" }, { label: "메모", value: "010-1234-5678" }] }, findC, { click: "도움말" }, { text: "끝" }],
        { path: "/form", onCard: approveAll },
      );
      expect(skipped(many.out, "shadow_card"), `여러 칸 중 하나: 저장 안 함(${many.out})`);
      // navigate_to_url로 삭제 낱말 주소에 간 턴도 같다.
      await newChat(h);
      const del = await walk(h, [go(h, "/item/delete"), findC, { click: "도움말" }, { text: "끝" }], { path: "/", onCard: approveAll });
      expect(skipped(del.out), `삭제 주소 이동: 저장 안 함(${del.out})`);
      expect((await stored(h)).length === 0, "저장소 비어 있음");
    },
  },
  {
    name: "10. sign_in을 실행한 턴은 저장 안 함. 앞 턴에서 로그인한 값이 퍼센트 인코딩으로 경로에 든 주소를 거친 턴도 저장 안 함(대조: 다른 낱말이면 저장)",
    isolate: true,
    pages: {
      ...PAGES,
      "/login": `<title>Login</title><main><form id=f action="/session" method="post" onsubmit="event.preventDefault();this.remove()">
<label>아이디 <input name=u autocomplete=username></label><label>비밀번호 <input name=p type=password autocomplete=current-password></label>
<button>로그인</button></form><a href="/help">도움말</a><p id=out></p></main>`,
      "/me": `<title>나</title><main><a href="/profile/%68arnessuser/help">내 정보</a><a href="/profile/someone/help">남의 정보</a><p id=out></p></main>`,
      // 서버는 경로를 풀지 않고 받은 그대로 찾는다.
      "/profile/%68arnessuser/help": BACK_HOME("내 정보"),
      "/profile/someone/help": BACK_HOME("남의 정보"),
    },
    pages2: PAGES2,
    async run(h) {
      const UUID = "0123456789abcdef0123456789abcdef";
      // 아이디를 경로 낱말로 남을 수 있는 모양(plainWord)으로 둔다 — 정규화된 틀에서 드러나는 경우를 본다.
      h.installKeePassXC({ entries: [{ url: `${h.base}/`, uuid: UUID, name: "Harness", login: "harnessuser", password: "Harness-Pw-7731!" }], associations: { harness: "IDKEY" } });
      await h.sw.evaluate(() => chrome.storage.local.set({ keepassxcAssociation: { id: "harness", idKey: "IDKEY" } }));
      await h.settings({ autoApprove: true, loginSites: [{ origin: h.base, uuid: UUID, entryName: "Harness", totp: false }] });
      const findF = { tool: "find_form_fields", args: {} };
      const signed = await walk(h, [findF, { signIn: "password" }, findC, { click: "도움말" }, { text: "끝" }], { path: "/login" });
      expect(okResult(signed.r, "sign_in"), "자동 로그인 실행");
      expect(skipped(signed.out, "sign_in"), `sign_in 턴은 저장 안 함(${signed.out})`);
      // 사용자가 턴 도중 직접 옮긴 이동(같은 규칙으로 적히고 검사받는다). 도구 클릭은 그림자 판정에서 먼저 걸리므로 비밀 값 검사만 보려고 쓴다.
      const userWalk = async (path, links) => {
        await h.sw.evaluate(() => {
          globalThis.__streamGate = null;
        });
        await newChat(h);
        const mark = h.logs.length;
        const turn = h.turn([{ textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }], { path });
        await duringTurn(turn, async () => {
          await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), { label: "답 스트림 붙잡힘" });
          for (const href of links) {
            await h.tab.click(`a[href='${href}']`);
            await h.tab.waitForLoadState("load");
            await h.tab.waitForTimeout(150);
          }
          await h.sw.evaluate(() => globalThis.__releaseStream());
        });
        await turn;
        return outcome(h, mark);
      };
      const leaked = await userWalk("/me", ["/profile/%68arnessuser/help", "/help"]);
      expect(skipped(leaked, "secret"), `로그인 값이 든 주소를 거치면 저장 안 함(${leaked})`);
      expect((await stored(h)).length === 0, `저장소 비어 있음(${JSON.stringify(await stored(h))})`);
      expect(!h.logs.some((l) => l.includes("harnessuser")), "로그에 로그인 값이 없음");
      const ok = await userWalk("/me", ["/profile/someone/help", "/help"]);
      expect(ok.includes("path_recipe:result") && (await stored(h)).includes("/me /profile/someone/help /help"), `대조 저장(${ok})`);
    },
  },
  {
    name: "11. 물려받은 팝업 창에서 시작해 원래 탭으로 돌아와 끝난 턴은 저장 안 함(대조: 팝업 없이 사용자가 턴 중에 옮긴 이동은 저장)",
    ...base,
    pages: {
      ...PAGES,
      "/pp": `<title>예매</title><main><button onclick="window.open('/cal','cal','popup,width=420,height=320')">달력 열기</button><a href="/help">도움말</a><p id=out></p></main>`,
      "/cal": `<title>달력</title><main><button>10월 25일</button></main>`,
    },
    async run(h) {
      await closeExtraTabs(h);
      await h.settings({ autoApprove: true });
      try {
        await h.turn([findC, { click: "달력 열기" }, { text: "열었습니다" }], { path: "/pp" });
        // 둘째 턴은 팝업을 이어 따라간다. 답을 붙잡은 사이 팝업을 닫고 사용자가 원래 탭에서 링크를 누른다.
        const mark = h.logs.length;
        const turn = h.turn([findC, { textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }], { noReload: true });
        await duringTurn(turn, async () => {
          await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), {
            label: "답 스트림 붙잡힘",
            detail: async () => `${h.logs.slice(mark).filter((l) => /turn:|tool:|path_recipe/.test(l)).join(" | ").slice(0, 1500)} / 패널: ${(await h.panel.locator("body").innerText()).slice(-400)}`,
          });
          for (const p of h.ctx.pages()) if (p.url().includes("/cal")) await p.close();
          await h.tab.click("a[href='/help']");
          await h.tab.waitForURL(`${h.base}/help`);
          await h.sw.evaluate(() => globalThis.__releaseStream());
        });
        await turn;
        expect(h.logs.slice(mark).some((l) => l.includes("[SBP turn:popup]")), "둘째 턴이 팝업을 이어 따라감");
        const out = await outcome(h, mark);
        expect(skipped(out, "popup"), `물려받은 팝업: 저장 안 함(${out})`);
        expect((await stored(h)).length === 0, "저장소 비어 있음");
      } finally {
        await closeExtraTabs(h);
      }
      // 대조: 팝업 없이 같은 사용자 이동. 앞에서 푼 답 스트림 게이트를 비운다(다시 붙잡게).
      await h.sw.evaluate(() => {
        globalThis.__streamGate = null;
      });
      await newChat(h);
      const mark = h.logs.length;
      const turn = h.turn([findC, { textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }], { path: "/pp" });
      await duringTurn(turn, async () => {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), { label: "답 스트림 붙잡힘" });
        await h.tab.click("a[href='/help']");
        await h.tab.waitForURL(`${h.base}/help`);
        await h.sw.evaluate(() => globalThis.__releaseStream());
      });
      await turn;
      const out = await outcome(h, mark);
      expect(out.includes("path_recipe:result") && (await stored(h)).includes("/pp /help"), `사용자 이동도 저장(${out})`);
    },
  },
  {
    name: "12. 다 뜨기를 기다리는 사이 전체 지우기·다른 대화의 새 요청이 오면 저장 안 함",
    ...base,
    async run(h) {
      await h.settings({ autoApprove: true });
      // /held/notice: 시험이 풀 때까지 응답을 붙잡는다. 답이 패널에 보인 뒤(모델 응답이 끝나 경로 기록이 다 뜨기를 기다리는 중)
      // 일을 끼워 넣고 응답을 푼다.
      let release = null;
      h.routes.set("1/held/notice", (q, r) => {
        release = () => {
          r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          r.end(`<!doctype html><meta charset=utf-8>${NOTICE}`);
        };
      });
      const answered = (word) => waitUntil(async () => release && (await h.panel.locator("body").innerText()).includes(word), { label: `답 '${word}'이 보임` });
      // 전체 지우기(설정 화면의 기록 지우기와 같은 메시지).
      let mark = h.logs.length;
      let turn = h.turn([go(h, "/held/notice"), { text: "갔음하나" }], { path: "/" });
      await duringTurn(turn, async () => {
        await answered("갔음하나");
        expect((await ask(h, { kind: "action_log_clear" }))?.ok, "기록 지우기");
        release();
        release = null;
      });
      await turn;
      let out = await outcome(h, mark);
      expect(skipped(out, "deleted"), `지운 뒤 저장 안 함(${out})`);
      expect((await stored(h)).length === 0, "저장소 비어 있음");
      // 새 요청: 다른 대화(두 번째 패널)의 요청이 그 사이 시작된다. 같은 패널은 답을 마치기 전에는 보내기를 막아 이 틈에 새 요청·중단을
      // 넣을 수 없다(같은 대화의 중단·새 요청은 단위 시험 tests/pathRecipes.test.mjs의 isLive로 본다).
      const panel2 = await h.ctx.newPage();
      try {
        await panel2.goto(`chrome-extension://${h.extId}/src/sidepanel/index.html`);
        await panel2.waitForTimeout(500);
        await h.tab.bringToFront();
        await newChat(h);
        mark = h.logs.length;
        turn = h.turn([go(h, "/held/notice"), { text: "갔음둘" }, { text: "다른 대화" }], { path: "/" });
        await duringTurn(turn, async () => {
          await answered("갔음둘");
          await panel2.fill("textarea.composer-input", "다른 요청");
          await panel2.click("button.composer-btn.primary");
          await waitUntil(() => h.logs.slice(mark).filter((l) => l.includes("[SBP turn:tab]")).length >= 2, { label: "다른 대화의 턴 시작" });
          release();
          release = null;
        });
        await turn;
        out = await outcome(h, mark);
        expect(skipped(out, "overlap"), `다른 대화의 새 요청과 겹치면 저장 안 함(${out})`);
        await waitUntil(async () => !(await panel2.locator("button.composer-btn.danger").count()), { label: "다른 대화 끝" });
      } finally {
        await panel2.close().catch(() => {});
        await h.tab.bringToFront();
      }
      await h.tab.waitForTimeout(500);
      expect((await stored(h)).length === 0, `저장소 비어 있음(${JSON.stringify(await stored(h))})`);
      // 대조: 붙잡지 않으면 같은 이동이 저장된다.
      await newChat(h);
      h.routes.delete("1/held/notice");
      h.pages.set("1/held/notice", NOTICE);
      const ok = await walk(h, [go(h, "/held/notice"), { text: "갔음셋" }], { path: "/" });
      expect(ok.out.includes("path_recipe:result"), `대조 저장(${ok.out})`);
    },
  },
];
