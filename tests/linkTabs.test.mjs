// read_links_in_tabs(#293): 후보 판정(페이지 href 그대로·기억한 목적지 → 원래 링크·세탁 방지·해시·파일), 최종 주소 검사,
// 글자 배분, 그리고 chrome 대역(deps)으로 실행 순서·경쟁(늦은 탭 만들기, 읽기 기한·중단, 문서 바뀜, 사용자가 앞으로 가져온 탭,
// 닫기 실패·초기 청소, 저장 직렬화, 초기 청소 대기, 중단 시 정리 뒤 끝)을 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ABORTED_TEXT,
  CHANGED_TEXT,
  EMPTY_TEXT,
  MAX_TAB_LINK_READS_PER_TURN,
  TabOwnership,
  USER_TAB_TEXT,
  fileLinkReason,
  finalUrlBlock,
  perLinkChars,
  planTabCandidates,
  runTabReads,
  tabLinkPlan,
  tabReadResult,
} from "../src/lib/linkTabs.ts";
import { crossSiteRedirectText, tabReadFallbackText } from "../src/lib/linkRedirect.ts";

const PAGE = "https://news.example/list";
const lookOf = (hrefs) => {
  const m = new Map(Object.entries(hrefs));
  return (u) => (m.has(u) ? { text: m.get(u) } : null);
};
const noMemory = () => null;
const memOf = (pairs) => (u) => pairs[u] ?? null;

test("tabLinkPlan: 페이지 링크 통과, 없는 주소·계정 정보·http 아님·결제/개인정보 신호 거절", () => {
  const look = lookOf({ "https://news.example/a/1": "첫 글" });
  assert.deepEqual(tabLinkPlan("https://news.example/a/1", look, noMemory), { ok: true, open: "https://news.example/a/1", text: "첫 글", viaRedirect: false });
  assert.equal(tabLinkPlan("https://news.example/a/2", look, noMemory).ok, false);
  assert.match(tabLinkPlan("https://news.example/a/2", look, noMemory).reason, /지금 페이지에 없는 링크/);
  const withCreds = tabLinkPlan("https://u:p@news.example/a/1", lookOf({ "https://u:p@news.example/a/1": "x" }), noMemory);
  assert.equal(withCreds.ok, false);
  assert.match(withCreds.reason, /계정 정보/);
  const js = tabLinkPlan("javascript:alert(1)", lookOf({ "javascript:alert(1)": "x" }), noMemory);
  assert.equal(js.ok, false);
  const pay = tabLinkPlan("https://news.example/payment/start", lookOf({ "https://news.example/payment/start": "결제" }), noMemory);
  assert.equal(pay.ok, false);
  assert.match(pay.reason, /결제/);
});

test("tabLinkPlan: 기억한 다른 사이트 목적지 → 페이지의 원래 링크를 연다", () => {
  const look = lookOf({ "https://news.example/out/7": "외부 글" });
  const mem = memOf({ "https://other.example/story": "https://news.example/out/7" });
  assert.deepEqual(tabLinkPlan("https://other.example/story", look, mem), { ok: true, open: "https://news.example/out/7", text: "외부 글", viaRedirect: true });
});

test("세탁 방지: 결제 신호·파일인 원래 링크는 일반 목적지 주소로 들어와도 거절", () => {
  const look = lookOf({ "https://news.example/payment/start": "결제", "https://news.example/files/a.pdf": "첨부" });
  const pay = tabLinkPlan("https://other.example/ok", look, memOf({ "https://other.example/ok": "https://news.example/payment/start" }));
  assert.equal(pay.ok, false);
  assert.match(pay.reason, /여는 원래 링크: .*결제/);
  const file = tabLinkPlan("https://other.example/ok", look, memOf({ "https://other.example/ok": "https://news.example/files/a.pdf" }));
  assert.equal(file.ok, false);
  assert.match(file.reason, /여는 원래 링크: 파일 링크/);
  // 입력(목적지) 쪽 신호도 본다.
  const destPay = tabLinkPlan("https://other.example/checkout/pay", look, memOf({ "https://other.example/checkout/pay": "https://news.example/out/1" }));
  assert.equal(destPay.ok, false);
});

test("해시: 페이지의 href 그대로 열고, 해시를 바꾼 주소·해시 붙은 꼴로만 있는 원래 링크는 거절", () => {
  const look = lookOf({ "https://news.example/app#/article/1": "SPA 글", "https://news.example/r#top": "해시 붙은 링크" });
  assert.deepEqual(tabLinkPlan("https://news.example/app#/article/1", look, noMemory), {
    ok: true,
    open: "https://news.example/app#/article/1",
    text: "SPA 글",
    viaRedirect: false,
  });
  assert.equal(tabLinkPlan("https://news.example/app#/article/2", look, noMemory).ok, false);
  assert.equal(tabLinkPlan("https://news.example/app", look, noMemory).ok, false);
  // 기억한 원래 링크(해시 없음)가 페이지에는 해시 붙은 꼴로만 있으면 거절.
  const r = tabLinkPlan("https://other.example/x", look, memOf({ "https://other.example/x": "https://news.example/r" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /원래 링크가 지금 페이지에 그대로 있지 않음/);
});

test("파일: .pdf·.docx·.zip·.exe·.xls·이미지·쿼리의 파일 이름 거절, .html·확장자 없는 주소 통과", () => {
  for (const u of [
    "https://news.example/f/a.pdf",
    "https://news.example/f/a.docx",
    "https://news.example/f/a.zip",
    "https://news.example/f/setup.exe",
    "https://news.example/f/old.xls",
    "https://news.example/f/p.png",
    "https://news.example/f/p.JPG",
    "https://news.example/download.do?fileName=%EB%B3%B4%EA%B3%A0%EC%84%9C.hwp",
  ]) {
    assert.ok(fileLinkReason(u), u);
    assert.equal(tabLinkPlan(u, lookOf({ [u]: "파일" }), noMemory).ok, false, u);
  }
  for (const u of ["https://news.example/a.html", "https://news.example/a.htm", "https://news.example/article/123", "https://news.example/view.php?id=3"]) {
    assert.equal(fileLinkReason(u), null, u);
    assert.equal(tabLinkPlan(u, lookOf({ [u]: "글" }), noMemory).ok, true, u);
  }
});

test("planTabCandidates: 같은 열 주소 합침, 다른 사이트·원래 링크 표시, 거절 목록, 최대 8개", () => {
  let n = 0;
  const look = lookOf({ "https://news.example/a/1": "첫 글", "https://news.example/out/7": "", "https://far.example/z": "먼 글" });
  const mem = memOf({ "https://other.example/story": "https://news.example/out/7", "https://other.example/story2": "https://news.example/out/7" });
  const { list, rejected } = planTabCandidates(
    ["https://news.example/a/1", "https://news.example/a/1", "https://other.example/story", "https://other.example/story2", "https://far.example/z", "https://news.example/none"],
    look,
    mem,
    PAGE,
    () => `id${++n}`,
  );
  assert.deepEqual(
    list.map((c) => [c.open, c.label, c.sub]),
    [
      ["https://news.example/a/1", "첫 글", "https://news.example/a/1"],
      ["https://news.example/out/7", "https://news.example/out/7", "https://news.example/out/7 (리다이렉트 목적지 대신 페이지의 원래 링크를 엶)"],
      ["https://far.example/z", "먼 글", "https://far.example/z (다른 사이트)"],
    ],
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /news\.example\/none \(지금 페이지에 없는 링크\)/);
  const many = planTabCandidates(Array.from({ length: 12 }, (_, i) => `https://news.example/a/${i}`), () => ({ text: "" }), noMemory, PAGE, () => `x${++n}`);
  assert.equal(many.list.length, 8);
});

test("finalUrlBlock: 웹 아님·신호 있는 주소는 막고, 다른 사이트 일반 주소는 통과", () => {
  assert.match(finalUrlBlock("chrome-error://chromewebdata/"), /웹 페이지가 아닌/);
  assert.match(finalUrlBlock("about:blank"), /웹 페이지가 아닌/);
  assert.match(finalUrlBlock("https://pay.example/checkout/pay?x=1"), /결제·개인정보 신호/);
  assert.match(finalUrlBlock("https://u:p@x.example/"), /계정 정보/);
  assert.equal(finalUrlBlock("https://other.example/story"), null);
  // 긴 주소는 200자로 줄여 알린다.
  const long = `https://pay.example/checkout/${"a".repeat(400)}`;
  assert.ok(finalUrlBlock(long).length < 300);
});

test("글자 배분과 short·truncated·빈 본문", () => {
  assert.equal(perLinkChars(1), 4000);
  assert.equal(perLinkChars(8), 3000);
  assert.equal(perLinkChars(6), 4000);
  assert.equal(MAX_TAB_LINK_READS_PER_TURN, 2);
  const shortRead = tabReadResult("https://a.example/1", "https://a.example/1", "제목", "짧은 글", 4000);
  assert.deepEqual(shortRead, { url: "https://a.example/1", title: "제목", text: "짧은 글", truncated: false, short: true });
  const cut = tabReadResult("https://a.example/1", "https://b.example/2", "t", "가".repeat(5000), 3000);
  assert.equal(cut.text.length, 3000);
  assert.equal(cut.truncated, true);
  assert.equal(cut.finalUrl, "https://b.example/2");
  assert.equal(cut.short, undefined);
  assert.deepEqual(tabReadResult("https://a.example/1", "https://a.example/1", "t", "  \n ", 4000), { url: "https://a.example/1", error: EMPTY_TEXT });
});

test("read_linked_pages 안내 문구: 목적지 후보가 다시 다른 사이트로 가면 탭 도구 안내, blocked·본문 없음에도 탭 도구 안내", () => {
  const first = crossSiteRedirectText("https://b.example/x", false);
  assert.match(first, /read_linked_pages를 이 주소\(redirectTo\)로 한 번 다시/);
  assert.doesNotMatch(first, /read_links_in_tabs/);
  const again = crossSiteRedirectText("https://c.example/y", true);
  assert.match(again, /되풀이하지 말고/);
  assert.match(again, /read_links_in_tabs/);
  const fb = tabReadFallbackText("https://a.example/1");
  assert.match(fb, /read_links_in_tabs/);
  assert.match(fb, /navigate_to_url로 https:\/\/a\.example\/1/);
});

// ---- 실행기(가짜 chrome) ----

const FAST = { linkMs: 1500, loadMs: 600, settleMs: 5, readMs: 120, pollMs: 5 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fake(opts = {}) {
  const tabs = new Map();
  let nextId = 100;
  const storage = { ids: [...(opts.stored ?? [])] };
  const created = [];
  const removed = [];
  const log = [];
  const deps = {
    turnTab: async () => ({ windowId: 1, index: 0 }),
    create: (o) => {
      created.push(o);
      const make = () => {
        const id = nextId++;
        tabs.set(id, { url: opts.finalUrl?.(o.url) ?? o.url, status: opts.loading ? "loading" : "complete", active: false, doc: `d${id}` });
        opts.onCreate?.(id, tabs);
        return { id };
      };
      return opts.createDelay ? wait(opts.createDelay).then(make) : Promise.resolve(make());
    },
    get: async (id) => (tabs.has(id) ? { ...tabs.get(id) } : null),
    remove: async (id) => {
      if (opts.removeDelay) await wait(opts.removeDelay);
      if (opts.removeFails?.has(id)) throw new Error("remove failed");
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
      tabs.delete(id);
      removed.push(id);
    },
    mute: async () => {},
    topDocumentId: async (id) => {
      opts.onDoc?.(id, tabs);
      return tabs.get(id)?.doc ?? null;
    },
    readText: (id, doc, url, signal) =>
      opts.read ? opts.read(id, doc, url, signal, tabs) : Promise.resolve({ url, title: "제목", mainText: `본문 ${url}` }),
    loadOwned: async () => {
      if (opts.storageDelay) await wait(opts.storageDelay);
      return [...storage.ids];
    },
    saveOwned: async (ids) => {
      if (opts.storageDelay) await wait(opts.storageDelay);
      storage.ids = [...ids];
    },
    log: (t, m) => log.push(`${t} ${m}`),
  };
  const owner = new TabOwnership(deps);
  return { tabs, storage, created, removed, log, deps, owner };
}

const ready = Promise.resolve();
const never = () => new Promise(() => {});

test("실행기: 고른 링크를 열어 읽고 닫는다(목록에 남지 않음), 로그에 본문·제목 없음", async () => {
  const f = fake({ finalUrl: (u) => (u.endsWith("/2") ? "https://other.example/moved" : u) });
  const out = await runTabReads(["https://a.example/1", "https://a.example/2", "https://a.example/3"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, "본문 https://a.example/1");
  assert.equal(out[1].finalUrl, "https://other.example/moved");
  assert.equal(out[1].text, "본문 https://other.example/moved");
  assert.equal(f.tabs.size, 0);
  assert.deepEqual(f.storage.ids, []);
  assert.ok(f.created.every((c) => c.index === 1 && c.windowId === 1));
  assert.ok(!f.log.some((l) => l.includes("본문") || l.includes("제목")), f.log.join("\n"));
});

test("실행기: 최종 주소에 결제 신호가 있으면 읽지 않고 닫는다", async () => {
  let reads = 0;
  const f = fake({ finalUrl: () => "https://pay.example/checkout/pay", read: async (id, doc, url) => (reads++, { url, title: "", mainText: "x" }) });
  const [r] = await runTabReads(["https://a.example/1"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.match(r.error, /결제·개인정보 신호/);
  assert.equal(reads, 0);
  assert.equal(f.tabs.size, 0);
});

test("실행기: 탭 만들기 약속이 중단 뒤 늦게 끝나면 그 탭을 닫고 목록에 남기지 않는다", async () => {
  const f = fake({ createDelay: 60 });
  const ctl = new AbortController();
  const run = runTabReads(["https://a.example/1"], f.deps, f.owner, ready, ctl.signal, FAST);
  await wait(10);
  ctl.abort();
  await assert.rejects(run, (e) => e.message === ABORTED_TEXT);
  await wait(120);
  assert.equal(f.created.length, 1);
  assert.equal(f.tabs.size, 0, "늦게 열린 탭이 닫힘");
  assert.deepEqual(f.storage.ids, []);
});

test("실행기: 본문 응답이 오지 않으면(주입이 끝나지 않는 경우와 같음) 읽기 기한에 오류, 탭은 닫힘", async () => {
  let sawAbort = false;
  const f = fake({
    read: (id, doc, url, signal) => {
      signal.addEventListener("abort", () => (sawAbort = true));
      return never();
    },
  });
  const t0 = Date.now();
  const [r] = await runTabReads(["https://a.example/1"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.match(r.error, /초 안에 본문을 읽지 못했습니다/);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(sawAbort, "읽기 쪽에 중단 신호가 감");
  assert.equal(f.tabs.size, 0);
  assert.deepEqual(f.storage.ids, []);
});

test("실행기: 읽는 중 중단하면 기한을 기다리지 않고 바로 빠져나오고 탭을 닫는다", async () => {
  const f = fake({ read: () => never() });
  const ctl = new AbortController();
  const slow = { ...FAST, readMs: 5000, linkMs: 10_000 };
  const run = runTabReads(["https://a.example/1"], f.deps, f.owner, ready, ctl.signal, slow);
  await wait(40);
  const t0 = Date.now();
  ctl.abort();
  await assert.rejects(run, (e) => e.message === ABORTED_TEXT);
  assert.ok(Date.now() - t0 < 300);
  assert.equal(f.tabs.size, 0);
});

test("실행기: 읽는 사이 최상위 문서가 바뀌거나(같은 주소 재로드 포함) 주소가 바뀌면 글을 버린다", async () => {
  const reload = fake({
    read: async (id, doc, url, signal, tabs) => {
      tabs.get(id).doc = `${doc}-reloaded`;
      return { url, title: "t", mainText: "옛 문서 글" };
    },
  });
  const [a] = await runTabReads(["https://a.example/1"], reload.deps, reload.owner, ready, new AbortController().signal, FAST);
  assert.equal(a.error, CHANGED_TEXT);
  assert.ok(!JSON.stringify(a).includes("옛 문서 글"));
  assert.equal(reload.tabs.size, 0);
  const moved = fake({
    read: async (id, doc, url, signal, tabs) => {
      tabs.get(id).url = "https://a.example/elsewhere";
      return { url, title: "t", mainText: "옛 주소 글" };
    },
  });
  const [b] = await runTabReads(["https://a.example/1"], moved.deps, moved.owner, ready, new AbortController().signal, FAST);
  assert.equal(b.error, CHANGED_TEXT);
});

test("실행기: 사용자가 탭을 앞으로 가져오면(로딩 중·읽기 직전·읽은 직후) 글 없음, 닫지 않음, 목록에서 빠짐", async () => {
  const activate = (f, id) => {
    f.tabs.get(id).active = true;
    f.owner.noteActivated(id);
  };
  // 로딩 중
  const loading = fake({ loading: true });
  loading.deps.create = ((orig) => (o) => orig(o).then((t) => (setTimeout(() => activate(loading, t.id), 20), t)))(loading.deps.create);
  const [a] = await runTabReads(["https://a.example/1"], loading.deps, loading.owner, ready, new AbortController().signal, FAST);
  assert.equal(a.error, USER_TAB_TEXT);
  assert.equal(loading.tabs.size, 1, "탭은 그대로");
  assert.deepEqual(loading.storage.ids, []);
  assert.equal(loading.owner.has([...loading.tabs.keys()][0]), false);
  // 읽기 직전(문서 id를 얻는 순간 활성화 — onActivated 없이 tab.active만으로도)
  const before = fake({ onDoc: (id, tabs) => (tabs.get(id).active = true) });
  let reads = 0;
  before.deps.readText = async (id, doc, url) => (reads++, { url, title: "", mainText: "x" });
  const [b] = await runTabReads(["https://a.example/1"], before.deps, before.owner, ready, new AbortController().signal, FAST);
  assert.equal(b.error, USER_TAB_TEXT);
  assert.equal(reads, 0, "읽지 않음");
  assert.equal(before.tabs.size, 1);
  assert.deepEqual(before.storage.ids, []);
  // 읽은 직후
  const after = fake({
    read: async (id, doc, url) => {
      activate(after, id);
      return { url, title: "t", mainText: "사용자 탭의 글" };
    },
  });
  const [c] = await runTabReads(["https://a.example/1"], after.deps, after.owner, ready, new AbortController().signal, FAST);
  assert.equal(c.error, USER_TAB_TEXT);
  assert.ok(!JSON.stringify(c).includes("사용자 탭의 글"));
  assert.equal(after.tabs.size, 1);
  assert.deepEqual(after.storage.ids, []);
});

test("닫기 실패면 목록에 남고, 초기 청소는 닫힌 것·없는 것을 빼고 실패한 것은 남기며 활성 탭은 닫지 않는다", async () => {
  const f = fake({ removeFails: new Set([100]) });
  await runTabReads(["https://a.example/1"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.deepEqual(f.storage.ids, [100], "닫기 실패 → 남김");
  assert.ok(f.tabs.has(100));

  const g = fake({ stored: [1, 2, 3, 4], removeFails: new Set([3]) });
  g.tabs.set(1, { url: "https://a.example/1", status: "complete", active: false, doc: "x" });
  g.tabs.set(3, { url: "https://a.example/3", status: "complete", active: false, doc: "y" });
  g.tabs.set(4, { url: "https://a.example/4", status: "complete", active: true, doc: "z" });
  const r = await g.owner.cleanup();
  assert.deepEqual(r, { closed: 1, kept: 1 });
  assert.deepEqual(g.storage.ids, [3]);
  assert.ok(!g.tabs.has(1));
  assert.ok(g.tabs.has(3));
  assert.ok(g.tabs.has(4), "활성 탭은 닫지 않음");
  assert.ok(g.log.some((l) => l.startsWith("link_tabs:cleanup")));
});

test("동시 작업자 둘의 저장소 갱신이 서로를 덮지 않는다(읽기-고치기-쓰기 직렬화)", async () => {
  const f = fake({ storageDelay: 15 });
  await Promise.all([f.owner.add(1), f.owner.add(2), f.owner.add(3)]);
  assert.deepEqual(f.storage.ids.sort(), [1, 2, 3]);
  await Promise.all([f.owner.drop(1), f.owner.add(4), f.owner.drop(3)]);
  assert.deepEqual(f.storage.ids.sort(), [2, 4]);
  // 실행 둘이 동시에 돌아도 끝나면 목록이 빈다.
  const g = fake({ storageDelay: 5 });
  await Promise.all([
    runTabReads(["https://a.example/1", "https://a.example/2"], g.deps, g.owner, ready, new AbortController().signal, FAST),
    runTabReads(["https://a.example/3", "https://a.example/4"], g.deps, g.owner, ready, new AbortController().signal, FAST),
  ]);
  assert.deepEqual(g.storage.ids, []);
  assert.equal(g.tabs.size, 0);
});

test("초기 청소가 끝나기 전에는 실행이 탭을 만들지 않는다", async () => {
  const f = fake();
  let release;
  const gate = new Promise((r) => (release = r));
  const run = runTabReads(["https://a.example/1"], f.deps, f.owner, gate, new AbortController().signal, FAST);
  await wait(40);
  assert.equal(f.created.length, 0);
  release();
  const [r] = await run;
  assert.equal(f.created.length, 1);
  assert.ok("text" in r);
});

test("중단 시 두 작업자의 닫기가 모두 끝난 뒤에 호출이 끝나고, 새 링크는 시작하지 않는다", async () => {
  const f = fake({ read: () => never(), removeDelay: 60 });
  const ctl = new AbortController();
  const slow = { ...FAST, readMs: 5000, linkMs: 10_000 };
  const run = runTabReads(["https://a.example/1", "https://a.example/2", "https://a.example/3"], f.deps, f.owner, ready, ctl.signal, slow);
  await wait(50);
  assert.equal(f.created.length, 2, "작업자 둘");
  ctl.abort();
  await assert.rejects(run, (e) => e.message === ABORTED_TEXT);
  assert.equal(f.removed.length, 2, "끝날 때 이미 둘 다 닫힘");
  assert.equal(f.tabs.size, 0);
  assert.equal(f.created.length, 2, "세 번째 링크는 열지 않음");
  assert.deepEqual(f.storage.ids, []);
});

test("이미 중단된 신호면 탭을 만들지 않는다", async () => {
  const f = fake();
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(runTabReads(["https://a.example/1"], f.deps, f.owner, ready, ctl.signal, FAST), (e) => e.message === ABORTED_TEXT);
  assert.equal(f.created.length, 0);
});

test("실행기: 막 만든 탭의 about:blank complete는 다 뜬 것으로 보지 않고 실제 주소가 뜰 때까지 기다린다", async () => {
  const f = fake({
    onCreate: (id, tabs) => {
      const real = tabs.get(id).url;
      Object.assign(tabs.get(id), { url: "about:blank", status: "complete" });
      setTimeout(() => Object.assign(tabs.get(id), { url: real, status: "complete" }), 30);
    },
  });
  const [r] = await runTabReads(["https://a.example/1"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.equal(r.text, "본문 https://a.example/1");
  assert.equal(f.tabs.size, 0);
});

// 리뷰 P2(#293): 읽은 뒤 마지막 비동기 확인(topDocumentId)을 기다리는 사이·닫기 직전에 사용자가 앞으로 가져오면 글을 버린다.
test("실행기: 읽은 뒤 topDocumentId를 기다리는 사이 활성화되면 글 없음·탭 안 닫힘·목록에서 빠짐", async () => {
  let docCalls = 0;
  const f = fake({
    onDoc: (id) => {
      // 두 번째 호출 = 읽은 뒤 확인. 그 사이 onActivated만 왔다(get의 active는 아직 false).
      if (++docCalls === 2) f.owner.noteActivated(id);
    },
    read: async (id, doc, url) => ({ url, title: "t", mainText: "사용자 탭의 글" }),
  });
  const [r] = await runTabReads(["https://a.example/1"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.equal(r.error, USER_TAB_TEXT);
  assert.ok(!JSON.stringify(r).includes("사용자 탭의 글"));
  assert.equal(f.tabs.size, 1, "탭은 그대로");
  assert.deepEqual(f.storage.ids, []);
  assert.equal(f.owner.has([...f.tabs.keys()][0]), false);
});

test("실행기: 닫기 단계의 확인에서 활성으로 보이면 이미 만든 글을 버리고 탭을 닫지 않는다", async () => {
  let docCalls = 0;
  let armed = false;
  const f = fake({
    // 읽은 뒤 확인(두 번째 topDocumentId)이 끝난 다음의 get = 닫기 단계의 확인. 거기서 처음 활성으로 보인다(onActivated 없이).
    onDoc: () => {
      if (++docCalls === 2) armed = true;
    },
    read: async (id, doc, url) => ({ url, title: "t", mainText: "닫기 직전 사용자 탭의 글" }),
  });
  const get = f.deps.get;
  f.deps.get = async (id) => {
    if (armed && f.tabs.has(id)) f.tabs.get(id).active = true;
    return get(id);
  };
  const [r] = await runTabReads(["https://a.example/1"], f.deps, f.owner, ready, new AbortController().signal, FAST);
  assert.equal(r.error, USER_TAB_TEXT);
  assert.ok(!JSON.stringify(r).includes("닫기 직전"));
  assert.equal(f.tabs.size, 1, "탭은 그대로");
  assert.deepEqual(f.storage.ids, []);
});
