// 설정 화면의 "저장된 읽기 방법 보기"(#297 1단계): 사이트별 목록, 하나·사이트째 지우기, 지운 뒤 readHints에서 빠짐,
// 턴 도중 지워도 되살아나지 않음, 설정 화면 둘에서 각각 지우기, content script 발신 거절.
import { duringTurn, expect, okResult, waitUntil } from "../lib.mjs";

const PAGE = `<title>목록</title><main><ul><li class=price>1,000원</li><li class=price>2,000원</li></ul><p class=note>안내 글</p><p id=out></p></main>`;
const q = (selector) => ({ tool: "query_dom", args: { selector } });

const stored = (h) => h.sw.evaluate(async () => ((await chrome.storage.local.get("readRecipesV2")).readRecipesV2 ?? []).map((r) => `${r.page.split("/")[2]} ${r.args.selector}`).sort());
const has = (list, sel) => list.some((x) => x.endsWith(` ${sel}`));

// 레시피 셋: 서버 1 /list의 li.price·p.note, 서버 2 /list의 li.price.
async function seed(h) {
  await h.turn([q("li.price"), { text: "읽음" }], { path: "/list" });
  await h.turn([q("p.note"), { text: "읽음" }], { path: "/list" });
  await h.turn([q("li.price"), { text: "읽음" }], { path: "/list", server: 2 });
  const list = await waitUntil(async () => {
    const s = await stored(h);
    return s.length === 3 && s;
  }, { label: "레시피 셋 저장", detail: async () => JSON.stringify(await stored(h)) });
  return list;
}

async function openList(h) {
  const opt = await h.openOptions("records");
  await opt.locator(".recipe-view > summary").click();
  await waitUntil(async () => (await opt.locator(".recipe-row").count()) > 0 || (await opt.locator(".recipe-view").innerText()).includes("없습니다"), {
    label: "읽기 방법 목록",
    detail: async () => (await opt.locator(".recipe-view").innerText()).slice(0, 200),
  });
  return opt;
}

const site = (opt, origin) => opt.locator(".recipe-site", { has: opt.locator(".recipe-origin", { hasText: origin }) });
const row = (opt, origin, sel) => site(opt, origin).locator(".recipe-row", { hasText: sel });

export default [
  {
    name: "사이트별로 보이고, 하나 지우면 그 항목만 사라지며 다음 describe_page의 readHints에서도 빠진다. 사이트 모두 지우기",
    pages: { "/list": PAGE },
    pages2: { "/list": PAGE },
    async run(h) {
      await seed(h);
      const opt = await openList(h);
      const text = await opt.locator(".recipe-view").innerText();
      expect(text.includes(h.base) && text.includes(h.base2), `두 사이트 묶음(${text.slice(0, 300)})`);
      expect(text.includes("페이지 내용 찾기") && text.includes("selector: li.price") && text.includes("/list"), `도구 표시 이름·인자·주소 틀(${text.slice(0, 300)})`);
      expect(text.includes("쓴 횟수 1번") && text.includes("마지막 사용"), "쓴 횟수·마지막 사용일");
      expect((await site(opt, h.base).locator(".recipe-row").count()) === 2, "서버 1 묶음에 둘");

      await row(opt, h.base, "li.price").locator(".recipe-delete").click();
      await waitUntil(async () => (await row(opt, h.base, "li.price").count()) === 0, { label: "지운 행이 사라짐" });
      expect((await row(opt, h.base, "p.note").count()) === 1 && (await row(opt, h.base2, "li.price").count()) === 1, "다른 항목은 남음");
      const after = await stored(h);
      expect(after.length === 2 && !after.includes(`${new URL(h.base).host} li.price`), `저장소에서 그 항목만 빠짐(${JSON.stringify(after)})`);

      const r = await h.turn([{ tool: "describe_page", args: {} }, { text: "끝" }], { path: "/list" });
      const hints = okResult(r, "describe_page").readHints ?? [];
      const sels = hints.map((x) => x.args.selector);
      expect(!sels.includes("li.price") && sels.includes("p.note"), `readHints에서 빠짐(${JSON.stringify(sels)})`);

      await site(opt, h.base).locator(".recipe-delete-site").click();
      await waitUntil(async () => (await site(opt, h.base).count()) === 0, { label: "서버 1 묶음이 사라짐" });
      expect((await row(opt, h.base2, "li.price").count()) === 1, "다른 사이트 묶음은 남음");
      const last = await stored(h);
      expect(last.length === 1 && last[0] === `${new URL(h.base2).host} li.price`, `저장소에는 서버 2만(${JSON.stringify(last)})`);
      await opt.close();
    },
  },
  {
    name: "관찰이 쌓인 턴이 끝나기 전에 지우면 턴이 끝나도 되살아나지 않는다",
    pages: { "/list": PAGE },
    async run(h) {
      await h.turn([q("li.price"), { text: "읽음" }], { path: "/list" });
      await waitUntil(async () => has(await stored(h), "li.price"), { label: "레시피 저장" });
      const opt = await openList(h);
      // 같은 호출을 다시 관찰한 턴을 답 글자 도중에 붙잡는다.
      const turn = h.turn([q("li.price"), { textParts: ["끝 ", "앞"], gapMs: 0, holdAfter: 1 }], { path: "/list" });
      await duringTurn(turn, async () => {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__streamHeld === true), { label: "답 스트림 붙잡힘" });
        await row(opt, h.base, "li.price").locator(".recipe-delete").click();
        await waitUntil(async () => !has(await stored(h), "li.price"), { label: "턴 도중 지움" });
        await h.sw.evaluate(() => globalThis.__releaseStream());
      });
      await turn;
      await opt.waitForTimeout(800);
      const s = await stored(h);
      expect(!has(s, "li.price"), `턴이 끝나도 되살아나지 않음(${JSON.stringify(s)})`);
      expect((await row(opt, h.base, "li.price").count()) === 0, "화면에도 없음");
      // 지운 뒤 새로 한 관찰은 정상으로 쌓인다.
      await h.turn([q("li.price"), { text: "읽음" }], { path: "/list" });
      await waitUntil(async () => has(await stored(h), "li.price"), { label: "지운 뒤 새 관찰은 저장" });
      await opt.close();
    },
  },
  {
    name: "지우기가 실패하면 다시 읽은 뒤에도 실패 안내가 남고, 다음 지우기가 성공하면 사라진다",
    pages: { "/list": PAGE },
    async run(h) {
      await h.turn([q("li.price"), { text: "읽음" }], { path: "/list" });
      await waitUntil(async () => has(await stored(h), "li.price"), { label: "레시피 저장" });
      const opt = await openList(h);
      // 이 설정 화면에서만 recipe_delete가 실패하게 하고, recipes_list 조회 수를 센다.
      await opt.evaluate(() => {
        const real = chrome.runtime.sendMessage.bind(chrome.runtime);
        globalThis.__failDelete = true;
        globalThis.__lists = 0;
        chrome.runtime.sendMessage = async (m) => {
          if (m?.kind === "recipes_list") globalThis.__lists++;
          if (m?.kind === "recipe_delete" && globalThis.__failDelete) return { ok: false, error: "시험 실패" };
          return real(m);
        };
      });
      const lists = () => opt.evaluate(() => globalThis.__lists);
      await row(opt, h.base, "li.price").locator(".recipe-delete").click();
      // 실패 뒤 다시 읽기(성공)까지 기다린다.
      await waitUntil(async () => (await lists()) >= 1, { label: "실패 뒤 다시 읽음" });
      await opt.waitForTimeout(300);
      const msg = opt.locator(".recipe-delete-error");
      expect((await msg.count()) === 1 && (await msg.innerText()).includes("지우지 못했습니다(시험 실패)"), `삭제 실패 안내(${await opt.locator(".recipe-view").innerText()})`);
      expect((await row(opt, h.base, "li.price").count()) === 1, "항목은 남음");
      expect((await opt.locator(".recipe-list-error").count()) === 0, "조회 오류는 없음");
      // 다른 곳의 저장소 변경으로 다시 읽어도 안내가 남는다.
      const n = await lists();
      await h.turn([q("p.note"), { text: "읽음" }], { path: "/list" });
      await waitUntil(async () => (await lists()) > n && (await opt.locator(".recipe-row").count()) === 2, { label: "저장소 변경 뒤 다시 읽음" });
      expect((await opt.locator(".recipe-delete-error").count()) === 1, "다시 읽은 뒤에도 삭제 실패 안내가 남음");
      // 다음 지우기가 성공하면 안내가 사라진다.
      await opt.evaluate(() => (globalThis.__failDelete = false));
      await row(opt, h.base, "li.price").locator(".recipe-delete").click();
      await waitUntil(async () => (await row(opt, h.base, "li.price").count()) === 0, { label: "성공한 지우기" });
      expect((await opt.locator(".recipe-delete-error").count()) === 0, "성공하면 안내가 사라짐");
      await opt.close();
    },
  },
  {
    name: "설정 화면 두 개에서 서로 다른 항목을 지워도 둘 다 반영된다",
    pages: { "/list": PAGE },
    pages2: { "/list": PAGE },
    async run(h) {
      await seed(h);
      const a = await openList(h);
      const b = await openList(h);
      await row(a, h.base, "li.price").locator(".recipe-delete").click();
      await waitUntil(async () => (await row(a, h.base, "li.price").count()) === 0, { label: "화면 A에서 지움" });
      await row(b, h.base2, "li.price").locator(".recipe-delete").click();
      await waitUntil(async () => (await stored(h)).length === 1, { label: "두 삭제 모두 반영", detail: async () => JSON.stringify(await stored(h)) });
      const s = await stored(h);
      expect(s[0] === `${new URL(h.base).host} p.note`, `남은 것은 p.note(${JSON.stringify(s)})`);
      // 두 화면 모두 저장소 변경을 따라 같은 목록이 된다.
      for (const opt of [a, b]) {
        await waitUntil(async () => (await opt.locator(".recipe-row").count()) === 1, { label: "화면이 따라감" });
      }
      await a.close();
      await b.close();
    },
  },
  {
    name: "content script에서 보낸 recipes_list·recipe_delete·action_log_count·action_log_clear는 모두 거절한다",
    pages: { "/list": PAGE },
    async run(h) {
      await h.turn([q("li.price"), { text: "읽음" }], { path: "/list" });
      const before = await waitUntil(async () => {
        const s = await stored(h);
        return s.length === 1 && s;
      }, { label: "레시피 저장" });
      const keys = await h.sw.evaluate(async () =>
        ((await chrome.storage.local.get("readRecipesV2")).readRecipesV2 ?? []).map((r) => `read:${r.page} ${r.tool} ${JSON.stringify(r.args)}`),
      );
      const res = await h.sw.evaluate(async ({ base, keys }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url ?? "").startsWith(base));
        const [out] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (keys) => {
            const kinds = ["recipes_list", "recipe_delete", "action_log_count", "action_log_clear"];
            const r = [];
            for (const kind of kinds) r.push(await chrome.runtime.sendMessage({ kind, keys }));
            return r;
          },
          args: [keys],
        });
        return out.result;
      }, { base: h.base, keys });
      expect(Array.isArray(res) && res.length === 4, `응답 넷(${JSON.stringify(res)})`);
      expect(res.every((x) => x && x.ok === false && x.error === "허용되지 않은 요청"), `모두 거절(${JSON.stringify(res)})`);
      expect(!JSON.stringify(res).includes("li.price"), "목록이 새지 않음");
      const after = await stored(h);
      expect(JSON.stringify(after) === JSON.stringify(before), `지워지지 않음(${JSON.stringify(after)})`);
      // 확장 화면(패널)에서는 받는다.
      const ok = await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "recipes_list" }));
      expect(ok?.ok && ok.data.sites.length === 1, `확장 화면에서는 목록(${JSON.stringify(ok)?.slice(0, 200)})`);
      const bad = await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "recipe_delete", keys: [1] }));
      expect(bad?.ok === false, "문자열이 아닌 key는 거절");
      const many = await h.panel.evaluate(() => chrome.runtime.sendMessage({ kind: "recipe_delete", keys: Array.from({ length: 401 }, (_, i) => `read:${i}`) }));
      expect(many?.ok === false, "401개는 거절");
    },
  },
];
