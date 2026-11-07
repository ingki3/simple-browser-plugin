// 턴 탭 문맥(src/background/agent/tabContext.ts, #263 단계 2 — 계획 R4). 탭 머리말은 지금 턴의 탭을 getter로 받아, 옮기기 전
// this.turnTab을 읽던 시점·횟수 그대로 읽는다: 탭 id는 함수 시작에서, 팝업 안내는 탭 조회(chrome.tabs.get)를 기다린 뒤 다시.
// 그 사이 턴이 바뀌면 둘이 다른 턴의 값일 수 있다(지금 동작 — 옛 턴은 buildUserContent 뒤 stale 확인으로 버려진다, 하네스
// "사용자 문맥을 읽는 사이 새 요청이 오면…"). toolTabUrl은 호출이 받은 턴 탭(고정 값)만 쓴다.
// ../tools/handlers는 대역(tests/helpers/handlersStub.mjs)으로 바꾼다 — 이 파일에서 tabContext.ts가 부를 때만.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import "./helpers/tsLoader.mjs";

const STUB = new URL("./helpers/handlersStub.mjs", import.meta.url).href;
register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(spec, ctx, next) {
  if (spec === "../tools/handlers" && ctx.parentURL?.endsWith("/src/background/agent/tabContext.ts")) return { url: ${JSON.stringify(STUB)}, shortCircuit: true };
  return next(spec, ctx);
}`)}`,
  import.meta.url,
);

const T = await import("../src/background/agent/tabContext.ts");
const { popupWhere } = await import("../src/lib/actionTarget.ts");

// tabs: id → 탭(없으면 chrome.tabs.get이 거절). 불린 순서를 __tabEvents에 남긴다.
function setTabs(tabs) {
  globalThis.__tabEvents = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => {
        globalThis.__tabEvents.push(`tabs.get(${id})`);
        if (!(id in tabs)) throw new Error(`No tab with id: ${id}`);
        return { id, ...tabs[id] };
      },
    },
  };
}
const events = () => globalThis.__tabEvents;
// 부를 때마다 차례로 values의 값을 돌려주는 getter(마지막 값은 그 뒤에도 계속).
function getterOf(...values) {
  let n = 0;
  const get = () => {
    n += 1;
    globalThis.__tabEvents.push(`getter#${n}`);
    return values[Math.min(n, values.length) - 1];
  };
  get.calls = () => n;
  return get;
}

const A = { tabId: 1, internal: false };
const POP_URL = "https://pop.example/cal/day?x=1";
const B = () => ({ tabId: 2, internal: false, popups: [{ tabId: 22, windowId: 9 }] });
const TABS = { 1: { url: "https://a.example/page", title: "가게" }, 2: { url: "https://b.example/", title: "다른 턴" }, 22: { url: POP_URL, title: "달력" } };
const HEAD_A = "[탭 메타데이터 — 상세 내용은 describe_page로 관측하세요]\nURL: https://a.example/page\n제목: 가게";
const POPUP_NOTE = `\n[팝업 창을 따라가는 중 — 위 URL·제목은 앞에서 누른 버튼이 연 팝업 창(${popupWhere(POP_URL)})입니다. 아직 열려 있어 도구는 그 창에서 동작합니다. 창이 닫히면 원래 탭으로 돌아갑니다.]`;

test("fetchTabHeader: 탭 정보는 첫 getter 값, 팝업 안내는 탭 조회를 기다린 뒤 다시 읽은 getter 값(R4 특성)", async () => {
  setTabs(TABS);
  const get = getterOf(A, B());
  const header = await T.fetchTabHeader(get);
  assert.equal(header, HEAD_A + POPUP_NOTE);
  assert.equal(get.calls(), 2, "getter는 두 번(값 하나로 묶지 않음)");
  assert.deepEqual(events(), ["getter#1", "currentToolTab(1)", "tabs.get(1)", "getter#2", "currentToolTab(2)", "tabs.get(22)"]);
});

test("fetchTabHeader: 같은 턴이면 팝업 창 머리말(탭 정보도 팝업 창), 탭으로 열린 팝업은 그 안내", async () => {
  setTabs(TABS);
  const b = B();
  assert.equal(
    await T.fetchTabHeader(getterOf(b)),
    `[탭 메타데이터 — 상세 내용은 describe_page로 관측하세요]\nURL: ${POP_URL}\n제목: 달력${POPUP_NOTE}`,
  );
  assert.deepEqual(events(), ["getter#1", "currentToolTab(2)", "tabs.get(22)", "getter#2", "currentToolTab(2)", "tabs.get(22)"]);
  setTabs(TABS);
  const asTab = { tabId: 2, internal: false, popups: [{ tabId: 22, windowId: 9, kind: "tab" }] };
  const h = await T.fetchTabHeader(getterOf(asTab));
  assert.ok(h.endsWith(`\n[클릭으로 열린 탭을 따라가는 중 — 위 URL·제목은 앞에서 누른 버튼·링크가 연 탭(새 탭, 또는 브라우저가 팝업을 탭으로 연 것 — ${popupWhere(POP_URL)})입니다. 그 탭이 앞에 보여 도구는 그 탭에서 동작합니다. 탭이 닫히면 원래 탭으로 돌아갑니다.]`), h);
});

test("fetchTabHeader: 내부 페이지·YouTube 안내, 빈 탭·없는 탭·오류 턴 탭은 빈 머리말", async () => {
  setTabs({ 1: { url: "chrome://newtab/", title: "새 탭" }, 3: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "영상" }, 4: { url: "", title: "" } });
  assert.ok((await T.fetchTabHeader(getterOf(A))).startsWith("[탭 메타데이터 — 브라우저 내부 페이지(새 탭·설정 등) — "));
  assert.ok((await T.fetchTabHeader(getterOf({ tabId: 3, internal: false }))).startsWith("[탭 메타데이터 — YouTube 영상 페이지 — "));
  const empty = getterOf({ tabId: 4, internal: false });
  assert.equal(await T.fetchTabHeader(empty), "");
  assert.equal(empty.calls(), 1, "글이 없으면 팝업 안내를 읽지 않는다");
  setTabs({});
  const missing = getterOf(A, B());
  assert.equal(await T.fetchTabHeader(missing), "");
  assert.equal(missing.calls(), 1, "탭 조회가 실패하면 다시 읽지 않는다");
  setTabs(TABS);
  const err = getterOf({ error: "활성 탭을 찾을 수 없습니다." });
  assert.equal(await T.fetchTabHeader(err), "");
  assert.deepEqual(events(), ["getter#1", "currentToolTab(error)"]);
});

test("fetchTabHeader: 팝업 안내의 탭 조회가 실패하면 머리말 전체가 빈 글이 아니라 안내만 빠진다", async () => {
  setTabs({ 1: TABS[1] });
  assert.equal(await T.fetchTabHeader(getterOf(A, B())), HEAD_A);
});

test("requestTabId: getter를 함수 시작에서 한 번 읽고 따라가는 팝업이 있으면 그 탭", async () => {
  setTabs(TABS);
  const get = getterOf(B(), A);
  assert.equal(await T.requestTabId(get), 22);
  assert.equal(get.calls(), 1);
  assert.equal(await T.requestTabId(getterOf({ error: "x" })), null);
});

test("toolTabUrl: 받은 턴 탭(고정 값)으로 도구가 동작하는 탭의 주소", async () => {
  setTabs(TABS);
  assert.equal(await T.toolTabUrl(B()), POP_URL);
  assert.equal(await T.toolTabUrl(A), "https://a.example/page");
  assert.equal(await T.toolTabUrl({ error: "x" }), undefined);
  setTabs({});
  assert.equal(await T.toolTabUrl(A), undefined);
});

test("turnTabOf·tabLoaded·loadedPage", async () => {
  setTabs({ 1: { url: "https://a.example/", status: "complete" }, 2: { url: "chrome://settings/", status: "complete" } });
  assert.deepEqual(await T.turnTabOf(1), { tabId: 1, internal: false });
  assert.deepEqual(await T.turnTabOf(2), { tabId: 2, internal: true });
  assert.deepEqual(await T.turnTabOf(9), { error: "작업 탭을 찾을 수 없습니다." });
  assert.equal(await T.tabLoaded(1), true);
  assert.equal(await T.tabLoaded(9), false);
  assert.deepEqual(await T.loadedPage(1), { documentId: "doc-1", url: "https://a.example/" });
  assert.equal(await T.loadedPage(9), null);
  // 로딩 중이면 다 뜰 때까지(100ms 간격) 다시 본다.
  let n = 0;
  globalThis.chrome.tabs.get = async () => ({ url: "https://a.example/", status: ++n < 3 ? "loading" : "complete" });
  assert.equal(await T.tabLoaded(1), true);
  assert.equal(n, 3);
});
