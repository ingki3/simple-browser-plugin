// 방문 기록에서 기억할 페이지 찾기(#175): 보낼 내용 확인 → 고른 항목만(쿼리 값 없이) 전송 → 추천 → 저장 카드(추천이 초안,
// 다시 묻지 않음) → 저장은 누를 때만. 취소·권한 거절·설정 변경·보내지 않은 항목의 추천은 막는다.
import { expect } from "../lib.mjs";

const page = (t) => `<title>${t}</title><main><h1>${t}</h1><p id=out></p></main>`;

async function visit(h) {
  await h.tab.goto(`${h.base}/shop/search?q=${encodeURIComponent("맥북")}&trk=t1`);
  await h.tab.goto(`${h.base}/shop/search?q=${encodeURIComponent("아이패드")}&trk=t2`);
  await h.tab.goto(`${h.base}/news/today`);
  await h.tab.goto(`${h.base}/order/history`);
  await h.tab.waitForTimeout(300);
}

async function openField(h) {
  await h.panel.click('button[title="설정"]');
  await h.panel.waitForTimeout(300);
  await h.panel.locator("summary", { hasText: "기억·기록" }).click();
  await h.panel.waitForTimeout(200);
}

// 확인 화면까지: 항목들의 표시 글자(목록 순서 = 스냅샷 번호).
async function prepare(h) {
  await openField(h);
  await h.panel.locator(".history-pick-start").click();
  await h.panel.waitForSelector(".history-pick-confirm", { timeout: 10_000 });
  const rows = await h.panel.locator(".history-pick-confirm .history-pick-list li").allInnerTexts();
  return rows;
}

const draftReqs = (h) => h.sw.evaluate(() => (globalThis.__draftReqs ?? []).length);

export default [
  {
    name: "방문 기록 찾기(#175): 쿼리 값 없이 고른 항목만 보내고, 추천으로 채운 카드는 누를 때만 저장",
    pages: { "/shop/search": page("상품 검색"), "/news/today": page("오늘 뉴스"), "/order/history": page("주문 내역") },
    async run(h) {
      await h.settings({});
      await visit(h);
      const rows = await prepare(h);
      const shop = rows.findIndex((r) => r.includes("/shop/search"));
      const news = rows.findIndex((r) => r.includes("/news/today"));
      expect(shop >= 0 && news >= 0, `후보(${JSON.stringify(rows)})`);
      expect(rows[shop].includes("?q&trk") && !rows.join(" ").includes("맥북") && !rows.join(" ").includes("t1"), `쿼리 값은 보이지도 보내지도 않음(${rows[shop]})`);
      // 결제·개인정보 단서가 보이는 주소는 빼지 않고 ⚠로 보이며 기본으로 체크하지 않는다.
      const order = rows.findIndex((r) => r.includes("/order/history"));
      expect(order >= 0 && rows[order].includes("⚠"), `주문 주소는 경고와 함께 보인다(${rows[order]})`);
      expect(!(await h.panel.locator(".history-pick-confirm .history-pick-list li").nth(order).locator("input").isChecked()), "기본으로 체크하지 않음");
      // 뉴스는 체크를 푼다. 모델이 그 항목을 돌려줘도 무시해야 한다.
      await h.panel.locator(".history-pick-confirm .history-pick-list li").nth(news).locator("input").uncheck();
      await h.sw.evaluate(({ shop, news }) => {
        globalThis.__draftReqs = [];
        globalThis.__draft = {
          picks: [
            { index: shop, name: "상품 검색", purpose: "상품을 검색해 가격 비교", reason: "검색어를 바꿔 자주 씀", params: [{ p: 0, mode: "slot", slot: "상품명", hint: "검색할 상품" }, { p: 1, mode: "drop" }] },
            { index: news, name: "뉴스", purpose: "뉴스", reason: "보내지 않은 항목" },
          ],
        };
      }, { shop, news });
      await h.panel.locator(".history-pick-send").click();
      await h.panel.waitForSelector(".history-pick-results", { timeout: 10_000 });
      const req = await h.sw.evaluate(() => globalThis.__draftReqs.at(-1));
      const content = req?.messages?.[0]?.content ?? "";
      const data = JSON.parse(content.slice(content.indexOf("데이터:\n") + 4));
      expect(data.length === rows.length - 2 && !data.some((d) => d.base.includes("/news/") || d.base.includes("/order/")), `체크한 항목만(${JSON.stringify(data.map((d) => d.base))})`);
      expect(!content.includes("맥북") && !content.includes("아이패드") && !content.includes("t1") && !/"visits"|"typed"/.test(content), "쿼리 값·통계 없음");
      const picks = await h.panel.locator(".history-pick-results .history-pick-list li").allInnerTexts();
      expect(picks.length === 1 && picks[0].includes("상품 검색"), `보낸 항목의 추천만(${JSON.stringify(picks)})`);
      await h.panel.locator(".history-pick-open").first().click();
      await h.panel.waitForSelector(".page-offer.open", { timeout: 5000 });
      await h.panel.waitForSelector(".drawer", { state: "detached", timeout: 3000 }).catch(() => {});
      expect((await h.panel.locator(".drawer").count()) === 0, "설정 서랍을 닫는다");
      const card = h.panel.locator(".page-offer.open");
      expect((await card.locator("input").first().inputValue()) === "상품 검색", "추천 이름");
      expect((await card.innerText()).includes("방문 기록 추천으로 채웠습니다"), "출처 안내");
      expect((await card.locator(".page-offer-draft").count()) === 0, "다시 채우기 없음");
      const selects = await card.locator("select").evaluateAll((els) => els.map((e) => e.value));
      expect(JSON.stringify(selects) === JSON.stringify(["slot", "drop"]), `자리·빼기(${JSON.stringify(selects)})`);
      await h.panel.waitForTimeout(500);
      expect((await draftReqs(h)) === 1, "카드는 초안을 다시 묻지 않는다");
      let saved = await h.sw.evaluate(async () => (await chrome.storage.local.get("savedPages")).savedPages ?? []);
      expect(saved.length === 0, "누르기 전에는 저장 안 함");
      await card.locator(".btn-approve").click();
      await h.panel.waitForTimeout(500);
      saved = await h.sw.evaluate(async () => (await chrome.storage.local.get("savedPages")).savedPages ?? []);
      expect(saved.length === 1 && saved[0].template.params.length === 1 && saved[0].template.params[0].slot === "상품명", `저장(${JSON.stringify(saved)})`);
    },
  },
  {
    name: "방문 기록 찾기(#175): 취소하면 보내지 않고, 이미 저장한 링크 형태는 후보에서 뺀다",
    pages: { "/shop/search": page("상품 검색"), "/news/today": page("오늘 뉴스") },
    async run(h) {
      await h.settings({});
      await h.sw.evaluate(async (base) => {
        await chrome.storage.local.set({
          savedPages: [
            { id: "s1", name: "상품 검색", purpose: "", template: { base: `${base}/shop/search`, params: [{ key: "q", slot: "상품명" }, { key: "trk", slot: "추적" }], hash: "" }, slots: [{ key: "상품명", hint: "" }, { key: "추적", hint: "" }], site: base, savedAt: 1, lastUsedAt: 1, uses: 0 },
          ],
        });
        globalThis.__draftReqs = [];
      }, h.base);
      await visit(h);
      const rows = await prepare(h);
      expect(!rows.some((r) => r.includes("/shop/search")), `저장한 형태는 뺀다(${JSON.stringify(rows)})`);
      await h.panel.locator(".history-pick-confirm .btn-cancel").click();
      await h.panel.waitForTimeout(500);
      expect((await draftReqs(h)) === 0, "취소하면 보내지 않는다");
      expect((await h.panel.locator(".history-pick-start").count()) === 1, "처음으로");
    },
  },
  {
    name: "방문 기록 찾기(#175): 권한을 거절하면 기록을 읽지도 보내지도 않는다",
    pages: { "/news/today": page("오늘 뉴스") },
    async run(h) {
      await h.settings({});
      await visit(h);
      await h.panel.evaluate(() => {
        chrome.permissions.request = async () => false;
      });
      await h.sw.evaluate(() => {
        globalThis.__draftReqs = [];
      });
      await openField(h);
      await h.panel.locator(".history-pick-start").click();
      await h.panel.waitForTimeout(800);
      expect((await h.panel.locator(".history-pick").innerText()).includes("허락하지 않아"), "거절 안내");
      expect((await h.panel.locator(".history-pick-confirm").count()) === 0, "확인 화면 없음");
      const logs = h.logs.filter((l) => l.includes("history_pick:prepared"));
      expect(logs.length === 0, `기록을 읽지 않음(${JSON.stringify(logs)})`);
      expect((await draftReqs(h)) === 0, "보내지 않음");
    },
  },
  {
    name: "방문 기록 찾기(#175): 준비한 뒤 모델 설정이 바뀌면 보내지 않는다",
    pages: { "/news/today": page("오늘 뉴스"), "/shop/search": page("상품 검색") },
    async run(h) {
      await h.settings({});
      await visit(h);
      await prepare(h);
      await h.sw.evaluate(async () => {
        globalThis.__draftReqs = [];
        const cur = (await chrome.storage.local.get("settings")).settings ?? {};
        await chrome.storage.local.set({ settings: { ...cur, model: "other/model" } });
      });
      await h.panel.waitForTimeout(300);
      await h.panel.locator(".history-pick-send").click();
      await h.panel.waitForTimeout(800);
      expect((await h.panel.locator(".history-pick").innerText()).includes("설정이 바뀌었습니다"), "다시 준비 안내");
      expect((await draftReqs(h)) === 0, "보내지 않음");
    },
  },
];
