// read_links_in_tabs(#293): 지금 페이지의 링크를 로그인된 상태로 뒤에서 새 탭으로 열어 본문을 읽고 닫는다.
// 시험 서버 두 출처(127.0.0.1 = A, localhost = B)와 쿠키(sess=ok)로 "로그인해야 전문", A→B→A 왕복 리다이렉트, 최종 주소의
// 결제 신호, 해시로 화면을 그리는 페이지, 늦게 오는 응답을 만든다. 연 탭이 남지 않는지는 실제 탭 목록과 소유 목록(storage.session)으로 본다.
import { duringTurn, expect, okResult, waitUntil } from "../lib.mjs";

const MEMBER = "회원 전용 전문 본문입니다. 로그인한 사람에게만 끝까지 보이는 글의 내용이 여기에 이어집니다.";
const ROUND = "왕복 리다이렉트 뒤에 보이는 회원 본문입니다. 다른 사이트를 거쳐 돌아와도 로그인 상태로 읽힙니다.";
const PUBLIC = "누구나 볼 수 있는 공개 글의 본문입니다. 쿠키가 없어도 같은 글이 보입니다.";
const SECRET = "Harness-Pw-2933";

const article = (title, body) => `<title>${title}</title><main><article><h1>${title}</h1><p>${body}</p><p>${body}</p><p>${body}</p></article></main>`;
const send = (r, body, status = 200) => {
  r.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  r.end(`<!doctype html><meta charset=utf-8>${body}`);
};
const loggedIn = (q) => /(?:^|;\s*)sess=ok(?:;|$)/.test(q.headers.cookie ?? "");
const redirect = (r, location) => {
  r.writeHead(302, { location });
  r.end();
};

const LIST = `<title>목록</title><main><h1>목록</h1><ul>
<li><a href="/member/1">회원 글 하나</a></li>
<li><a href="/member/2">회원 글 둘</a></li>
<li><a href="/rt/1">왕복 글</a></li>
<li><a href="/app#/a">화면 A</a></li>
<li><a href="/app#/b">화면 B</a></li>
<li><a href="/payment/start">결제 시작</a></li>
<li><a href="/files/a.pdf">첨부 파일</a></li>
<li><a href="/event/7">이벤트 보기</a></li>
<li><a href="/slow-art/x">느린 글</a></li>
<li><a href="/slow-art/y">느린 글 둘</a></li>
<li><a href="/pub/1">공개 글</a></li>
<li><a href="/secret/1">값이 든 글</a></li>
<li><a href="/relay/1">중계 뒤 글</a></li>
</ul><p id=out></p></main>`;

const APP = `<title>앱</title><main id=m></main><script>
const m = document.getElementById("m");
const draw = () => {
  const b = location.hash === "#/b";
  m.innerHTML = "<article><h1>" + (b ? "화면 B" : "화면 A") + "</h1><p>" + (b ? "화면 B 글 " : "화면 A 글 ").repeat(30) + "</p></article>";
};
draw();
addEventListener("hashchange", draw);
</script>`;

// 시나리오 공통 경로(쿠키를 보는 글·리다이렉트·느린 글).
function setup(h) {
  h.pages.set("1/lt", LIST);
  h.pages.set("1/app", APP);
  h.pages.set("1/pub/1", article("공개 글", PUBLIC));
  h.pages.set("1/secret/1", article(`제목 ${SECRET}`, `본문에 든 값 ${SECRET} 입니다. ${PUBLIC}`));
  for (const n of ["1", "2"]) {
    h.routes.set(`1/member/${n}`, (q, r) => send(r, loggedIn(q) ? article(`회원 글 ${n}`, MEMBER) : article("안내", "로그인하면 전체 글을 볼 수 있습니다.")));
  }
  h.routes.set("1/rt/1", (q, r, { base, base2 }) => redirect(r, `${base2}/bounce?to=${encodeURIComponent(`${base}/rt-final/1`)}`));
  h.routes.set("2/bounce", (q, r) => redirect(r, new URL(q.url, "http://x").searchParams.get("to")));
  h.routes.set("1/rt-final/1", (q, r) => send(r, loggedIn(q) ? article("왕복 글", ROUND) : article("안내", "로그인이 필요합니다.")));
  h.routes.set("1/event/7", (q, r) => redirect(r, "/checkout/pay"));
  h.routes.set("1/checkout/pay", (q, r) => send(r, article("결제", "결제 화면 글")));
  // 로그인 중계 페이지(#293 3차 리뷰): 처음 뜬 뒤 500ms에 location.replace로 본문 페이지로 가고, 본문 응답은 1.5초 늦다.
  h.pages.set("1/relay/1", `<title>중계</title><main><p>${"중계 페이지 글입니다. ".repeat(20)}</p></main><script>setTimeout(() => location.replace("/late/1"), 500)</script>`);
  h.routes.set("1/late/1", (q, r) => setTimeout(() => send(r, article("본문 페이지", ROUND)), 1_500));
  for (const k of ["x", "y"]) h.routes.set(`1/slow-art/${k}`, (q, r) => setTimeout(() => send(r, article("느린 글", PUBLIC)), 8_000));
}

const login = (h) => h.ctx.addCookies([{ name: "sess", value: "ok", url: h.base }]);
const logout = (h) => h.ctx.clearCookies();
const linked = (urls) => ({ tool: "read_linked_pages", args: { urls } });
const inTabs = (urls) => ({ tool: "read_links_in_tabs", args: { urls } });
const tabLog = (r) => r.tools.filter((t) => t.name === "read_links_in_tabs");

// 이 시나리오가 링크로 둔 경로의 탭(이 도구가 연 탭). 공용 하네스에서는 앞 시나리오 묶음이 연 다른 경로의 탭이 남아 있을 수 있어
// 이 파일의 경로만 본다. 탭 줄 순서.
const LINK_PATH = /^\/(member|rt|rt-final|bounce|app|pub|secret|slow-art|event|checkout|payment|files|nope|relay|late)(\/|$)/;
const extraTabs = (h) =>
  h.sw.evaluate(
    async ({ bases, re }) => {
      const path = new RegExp(re);
      return (await chrome.tabs.query({}))
        .filter((t) => {
          const u = t.url || t.pendingUrl || "";
          return bases.some((b) => u.startsWith(b)) && path.test(new URL(u).pathname);
        })
        .map((t) => ({ id: t.id, url: t.url || t.pendingUrl, active: t.active }));
    },
    { bases: [h.base, h.base2], re: LINK_PATH.source },
  );
const owned = (h) => h.sw.evaluate(async () => (await chrome.storage.session.get("linkTabs:open"))["linkTabs:open"] ?? []);
async function noLeftover(h, label) {
  await waitUntil(async () => (await extraTabs(h)).length === 0 && (await owned(h)).length === 0, {
    timeoutMs: 8000,
    label: `${label}: 연 탭이 남지 않음`,
    detail: async () => JSON.stringify({ tabs: await extraTabs(h), owned: await owned(h) }),
  });
}
const hitCount = (h, from, key) => h.hits.slice(from).filter((x) => x === key).length;
const onCardTexts = (seen, act = (card) => card.locator(".btn-approve").click()) => async (card) => {
  seen.push(await card.innerText());
  await act(card);
};

export default [
  {
    name: "read_links_in_tabs: 쿠키가 있어야 전문인 글 — read_linked_pages는 안내문, 탭 읽기는 전문, 읽은 뒤 연 탭이 남지 않는다",
    async run(h) {
      setup(h);
      await login(h);
      try {
        const m1 = `${h.base}/member/1`;
        const seen = [];
        const r = await h.turn([linked([m1]), inTabs([m1]), { text: "끝" }], { path: "/lt", onCard: onCardTexts(seen) });
        const [noCookie] = okResult(r, "read_linked_pages");
        expect(String(noCookie.text).includes("로그인하면 전체 글") && !String(noCookie.text).includes("회원 전용"), `쿠키 없는 읽기는 안내문(${JSON.stringify(noCookie).slice(0, 200)})`);
        const [withCookie] = okResult(r, "read_links_in_tabs");
        expect(String(withCookie.text).includes("회원 전용 전문") && withCookie.url === m1 && !withCookie.finalUrl, `탭 읽기는 전문(${JSON.stringify(withCookie).slice(0, 200)})`);
        expect(seen.length === 2 && seen[1].includes("로그인된 상태로") && seen[1].includes("링크를 탭으로 열어 읽기"), `탭 카드 문구(${seen[1]?.slice(0, 200)})`);
        await noLeftover(h, "로그인 쿠키");
        expect(r.logs.some((l) => l.includes("link_tabs:open")) && r.logs.some((l) => l.includes("link_tabs:read")), "열기·읽기 로그");
        expect(!r.logs.some((l) => l.includes("회원 전용")), "로그에 본문 없음");
      } finally {
        await logout(h);
      }
    },
  },
  {
    name: "read_links_in_tabs: 다른 사이트 왕복 리다이렉트(A→B→A)도 로그인 상태로 읽고 finalUrl을 알린다",
    async run(h) {
      setup(h);
      await login(h);
      try {
        const r = await h.turn([inTabs([`${h.base}/rt/1`]), { text: "끝" }], { path: "/lt", approve: true });
        const [t] = okResult(r, "read_links_in_tabs");
        expect(String(t.text).includes("왕복 리다이렉트 뒤에") && t.finalUrl === `${h.base}/rt-final/1`, `왕복 읽기(${JSON.stringify(t).slice(0, 240)})`);
        await noLeftover(h, "왕복");
      } finally {
        await logout(h);
      }
    },
  },
  {
    name: "read_links_in_tabs: read_linked_pages가 알려 준 redirectTo를 넘기면 페이지의 원래 링크로 연다(서버 요청 기록)",
    async run(h) {
      setup(h);
      await login(h);
      try {
        const dest = `${h.base2}/bounce?to=${encodeURIComponent(`${h.base}/rt-final/1`)}`;
        const from = h.hits.length;
        const seen = [];
        const r = await h.turn([linked([`${h.base}/rt/1`]), inTabs([dest]), { text: "끝" }], { path: "/lt", onCard: onCardTexts(seen) });
        const [first] = okResult(r, "read_linked_pages");
        expect(first.redirectTo === dest, `목적지를 알림(${JSON.stringify(first).slice(0, 240)})`);
        const tabCard = seen.find((s) => s.includes("로그인된 상태로")) ?? "";
        expect(tabCard.includes(`${h.base}/rt/1`) && tabCard.includes("리다이렉트 목적지 대신 페이지의 원래 링크를 엶"), `원래 링크 후보(${tabCard.slice(0, 300)})`);
        const [t] = okResult(r, "read_links_in_tabs");
        expect(t.url === `${h.base}/rt/1` && String(t.text).includes("왕복 리다이렉트 뒤에"), `원래 링크로 읽음(${JSON.stringify(t).slice(0, 240)})`);
        // read_linked_pages가 한 번(쿠키 없이, 따라가지 않음), 탭이 한 번 원래 링크를 요청하고 탭만 B를 거쳐 A로 돌아온다.
        expect(hitCount(h, from, "1/rt/1") === 2 && hitCount(h, from, "2/bounce") === 1 && hitCount(h, from, "1/rt-final/1") === 1, `요청 기록(${h.hits.slice(from).join(",")})`);
        await noLeftover(h, "redirectTo");
      } finally {
        await logout(h);
      }
    },
  },
  {
    name: "read_links_in_tabs(ask·auto·task): ask는 카드에서 일부만 고르면 그만큼만 열고, auto도 카드, task는 맡긴 뒤 카드 없이, 대화 허락 버튼 없음",
    async run(h) {
      setup(h);
      await login(h);
      try {
        const m1 = `${h.base}/member/1`;
        const m2 = `${h.base}/member/2`;
        // ask: 두 후보 중 둘째를 끄고 승인.
        let from = h.hits.length;
        let chatBtn = -1;
        const r = await h.turn([inTabs([m1, m2]), { text: "끝" }], {
          path: "/lt",
          onCard: async (card) => {
            chatBtn = await card.locator(".btn-approve-chat").count();
            await card.locator("input[type=checkbox]").nth(1).uncheck();
            await card.locator(".btn-approve").click();
          },
        });
        expect(r.cards === 1 && chatBtn === 0, `카드 하나·대화 허락 버튼 없음(${r.cards}/${chatBtn})`);
        const got = okResult(r, "read_links_in_tabs");
        expect(got.length === 1 && got[0].url === m1, `고른 것만 읽음(${JSON.stringify(got).slice(0, 200)})`);
        expect(hitCount(h, from, "1/member/1") === 1 && hitCount(h, from, "1/member/2") === 0, `고른 것만 열림(${h.hits.slice(from).join(",")})`);
        await noLeftover(h, "ask");

        // auto: 그래도 카드(고정 이유). 앞의 읽기로 외부 본문 보호가 켜졌으니 새 대화로 본다.
        await h.reset();
        await h.settings({ runMode: "auto" });
        const seen = [];
        const r2 = await h.turn([inTabs([m1]), { text: "끝" }], { path: "/lt", onCard: onCardTexts(seen) });
        expect(r2.cards === 1 && seen[0].includes("로그인된 탭으로 여는 읽기는 늘 확인"), `auto도 카드(${seen[0]?.slice(0, 240)})`);
        expect(String(okResult(r2, "read_links_in_tabs")[0].text).includes("회원 전용"), "auto 카드 승인 뒤 읽음");

        // task: 맡기기 카드 한 번, 같은 요청의 다음 호출은 카드 없이 후보 전부(새 대화).
        await h.reset();
        await h.settings({ runMode: "task" });
        from = h.hits.length;
        const seen3 = [];
        const r3 = await h.turn([inTabs([m1, m2]), inTabs([m2]), { text: "끝" }], { path: "/lt", onCard: onCardTexts(seen3) });
        expect(r3.cards === 1 && seen3[0].includes("작업 맡기기"), `맡기기 카드 하나(${r3.cards} / ${seen3[0]?.slice(0, 120)})`);
        const logs = tabLog(r3);
        expect(logs.length === 2 && logs[0].result?.length === 2 && logs[1].result?.length === 1, `둘 다 실행(${JSON.stringify(logs).slice(0, 300)})`);
        expect(hitCount(h, from, "1/member/2") === 2, `task는 후보 전부(${h.hits.slice(from).join(",")})`);
        await noLeftover(h, "task");
      } finally {
        await logout(h);
      }
    },
  },
  {
    name: "read_links_in_tabs: 페이지에 없는 주소·결제 신호·파일·해시를 바꾼 주소는 후보에서 빠지고 탭을 열지 않으며, 최종 주소가 결제면 읽지 않는다",
    async run(h) {
      setup(h);
      const bad = [`${h.base}/nope`, `${h.base}/payment/start`, `${h.base}/files/a.pdf`, `${h.base}/app#/zzz`];
      let from = h.hits.length;
      const r = await h.turn([inTabs(bad), { text: "끝" }], { path: "/lt" });
      const [t] = tabLog(r);
      expect(r.cards === 0 && String(t?.error).includes("탭으로 열어 읽을 수 있는 링크가 없습니다"), `카드 없이 거절(${JSON.stringify(t).slice(0, 300)})`);
      for (const why of ["지금 페이지에 없는 링크", "결제", "파일 링크"]) expect(String(t.error).includes(why), `이유 ${why}`);
      const touched = h.hits.slice(from).filter((x) => /\/(nope|payment|files|app)/.test(x));
      expect(!touched.length, `서버 요청 없음(${touched.join(",")})`);
      expect((await extraTabs(h)).length === 0, "탭 없음");

      // 섞인 호출: 좋은 후보만 카드에, 나머지는 "열지 않는 주소".
      const seen = [];
      from = h.hits.length;
      const r2 = await h.turn([inTabs([`${h.base}/pub/1`, `${h.base}/payment/start`]), { text: "끝" }], { path: "/lt", onCard: onCardTexts(seen) });
      expect(seen[0]?.includes("열지 않는 주소") && seen[0].includes("/payment/start") && (await h.panel.locator(".tool-pending").last().locator("input[type=checkbox]").count()) === 1, `섞인 카드(${seen[0]?.slice(0, 300)})`);
      expect(okResult(r2, "read_links_in_tabs").length === 1 && hitCount(h, from, "1/payment/start") === 0, "결제 링크는 열지 않음");

      // 최종 주소가 결제 신호면 읽지 않는다(브라우저가 넘어간 것은 막을 수 없지만 본문을 읽지 않고 닫는다).
      const r3 = await h.turn([inTabs([`${h.base}/event/7`]), { text: "끝" }], { path: "/lt", approve: true });
      const [p] = okResult(r3, "read_links_in_tabs");
      expect(String(p.error).includes("결제·개인정보 신호가 있는 주소") && p.text === undefined && !JSON.stringify(p).includes("결제 화면 글"), `읽지 않음(${JSON.stringify(p).slice(0, 240)})`);
      await noLeftover(h, "최종 주소");
    },
  },
  {
    name: "read_links_in_tabs: 해시로 화면을 그리는 페이지의 #/b 링크는 그 화면의 글을 읽는다",
    async run(h) {
      setup(h);
      const r = await h.turn([inTabs([`${h.base}/app#/b`]), { text: "끝" }], { path: "/lt", approve: true });
      const [t] = okResult(r, "read_links_in_tabs");
      expect(String(t.text).includes("화면 B 글") && !String(t.text).includes("화면 A 글") && t.url === `${h.base}/app#/b`, `B 화면(${JSON.stringify(t).slice(0, 200)})`);
      await noLeftover(h, "해시");
    },
  },
  {
    name: "read_links_in_tabs: 다 뜬 뒤 대기하는 사이 중계 페이지가 새 이동을 시작하면 다시 기다려 본문 페이지의 글을 읽는다",
    async run(h) {
      setup(h);
      const r = await h.turn([inTabs([`${h.base}/relay/1`]), { text: "끝" }], { path: "/lt", approve: true, maxWaitMs: 30_000 });
      const [t] = okResult(r, "read_links_in_tabs");
      expect(String(t.text).includes("왕복 리다이렉트 뒤에") && !String(t.text).includes("중계 페이지 글") && t.finalUrl === `${h.base}/late/1`, `본문 페이지 글(${JSON.stringify(t).slice(0, 240)})`);
      await noLeftover(h, "중계");
    },
  },
  {
    name: "read_links_in_tabs: 늦는 글을 읽다 멈추면 연 탭이 모두 닫히고, 한 요청에 3번째 호출은 거절한다",
    async run(h) {
      setup(h);
      const slow = [`${h.base}/slow-art/x`, `${h.base}/slow-art/y`];
      const turn = h.turn([inTabs(slow), { text: "끝" }], { path: "/lt", approve: true, keepRunning: true, maxWaitMs: 30_000 });
      await duringTurn(turn, async () => {
        await waitUntil(async () => (await extraTabs(h)).length === 2 && (await owned(h)).length === 2, {
          timeoutMs: 8000,
          label: "탭 둘이 열림",
          detail: async () => JSON.stringify({ tabs: await extraTabs(h), owned: await owned(h) }),
        });
        await h.panel.click("button.composer-btn.danger");
      });
      await turn;
      await noLeftover(h, "중단");

      const p = `${h.base}/pub/1`;
      const r = await h.turn([inTabs([p]), inTabs([p]), inTabs([p]), { text: "끝" }], { path: "/lt", approve: true });
      // 앞 요청에서 멈춘 호출(interrupted)은 이 요청의 첫 모델 요청에 실려 오므로 뺀다.
      const logs = tabLog(r).filter((t) => t.error !== "interrupted");
      expect(logs.length === 3 && logs[0].result && logs[1].result && String(logs[2].error).includes("최대 2번"), `3번째 거절(${JSON.stringify(logs).slice(0, 300)})`);
      expect(r.cards === 2, `카드 둘(${r.cards})`);
      await noLeftover(h, "턴당 상한");
    },
  },
  {
    name: "read_links_in_tabs: 읽는 중 사용자가 그 탭을 앞으로 가져오면 그 링크는 오류, 탭은 그대로 남는다",
    async run(h) {
      setup(h);
      const turn = h.turn([inTabs([`${h.base}/slow-art/x`]), { text: "끝" }], { path: "/lt", approve: true, maxWaitMs: 30_000 });
      let mine = null;
      await duringTurn(turn, async () => {
        const tabs = await waitUntil(async () => {
          const t = await extraTabs(h);
          return t.length === 1 ? t : null;
        }, { timeoutMs: 8000, label: "탭이 열림" });
        mine = tabs[0].id;
        await h.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), mine);
      });
      const r = await turn;
      try {
        const [t] = okResult(r, "read_links_in_tabs");
        expect(String(t.error).includes("사용자가 이 탭을 열어 읽지 않았습니다"), `사용자 탭 오류(${JSON.stringify(t)})`);
        const left = await extraTabs(h);
        expect(left.length === 1 && left[0].id === mine, `탭은 그대로(${JSON.stringify(left)})`);
        expect((await owned(h)).length === 0, "소유 목록에서 빠짐");
      } finally {
        if (mine !== null) await h.sw.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), mine);
        await h.tab.bringToFront();
      }
    },
  },
  {
    name: "read_links_in_tabs(auto): 읽은 뒤에는 외부 본문 보호가 켜져 다음 동작이 카드로 묻는다",
    async run(h) {
      setup(h);
      await h.settings({ runMode: "auto" });
      const seen = [];
      await h.turn([inTabs([`${h.base}/pub/1`]), { tool: "navigate_to_url", args: { url: `${h.base}/lt?next=1` } }, { text: "끝" }], { path: "/lt", onCard: onCardTexts(seen) });
      const nav = seen.find((s) => s.includes("이동합니다"));
      expect(seen.length === 2 && nav && nav.includes("외부 문서 내용을 읽은 대화라 자동 실행하지 않음"), `보호 중 카드(${seen.map((s) => s.slice(0, 100)).join(" | ")})`);
      await noLeftover(h, "보호");
    },
  },
  {
    name: "read_links_in_tabs: 탭 읽기 뒤에도 도구 대상 탭은 원래 탭 그대로다(팝업 따라가기에 잡히지 않음)",
    async run(h) {
      setup(h);
      const r = await h.turn([inTabs([`${h.base}/pub/1`]), { tool: "describe_page", args: {} }, { text: "끝" }], { path: "/lt", approve: true });
      okResult(r, "read_links_in_tabs");
      const d = okResult(r, "describe_page");
      expect(d.url === `${h.base}/lt` && !d.window, `원래 탭(${JSON.stringify({ url: d.url, window: d.window })})`);
      expect(!r.logs.some((l) => /popup:follow|popups:follow/.test(l)), "팝업 따라가기 없음");
    },
  },
  {
    name: "read_links_in_tabs: 자동 로그인 값이 읽은 글의 본문·제목에 있으면 모델 요청에는 가린 값으로 가고 로그에 값이 없다(새 워커)",
    isolate: true,
    onWorker: (sw) => sw.evaluate((v) => chrome.storage.session.set({ loginSecrets: { t1: [v] } }).then(() => true), SECRET),
    async run(h) {
      setup(h);
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      const r = await h.turn([inTabs([`${h.base}/secret/1`]), { text: "끝" }], { path: "/lt", approve: true });
      const [t] = okResult(r, "read_links_in_tabs");
      expect(!JSON.stringify(t).includes(SECRET) && String(t.text).includes("[가린 값]") && String(t.title).includes("[가린 값]"), `가린 결과(${JSON.stringify(t).slice(0, 200)})`);
      const reqs = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs.map((q) => q.body)));
      expect(!reqs.includes(SECRET) && reqs.includes("[가린 값]"), "모델 요청에 값 없음");
      expect(!r.logs.some((l) => l.includes(SECRET)), "디버그 로그에 값 없음");
      expect(!(await h.panel.evaluate((v) => document.body.innerText.includes(v), SECRET)), "패널 화면에 값 없음");
      await noLeftover(h, "가림");
    },
  },
];
