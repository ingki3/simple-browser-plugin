import test from "node:test";
import assert from "node:assert/strict";

import { describeEffect, describePopup, popupWhere } from "../src/lib/actionTarget.ts";
import { clickObservedChange } from "../src/lib/hopGuard.ts";
import { sameSiteAs } from "../src/lib/siteTrust.ts";
import { ABORTED, blockedOpens, bounded, openTargetKey, reusedTargets } from "../src/lib/popupMatch.ts";

test("reusedTargets: a navigation in another tab matches a successful open by URL, one each", () => {
  const cal = "https://ex.test/cal";
  const navs = [
    { tabId: 7, url: "https://ex.test/other" },
    { tabId: 8, url: `${cal}#x` },
    { tabId: 9, url: cal },
  ];
  assert.deepEqual(reusedTargets([{ url: cal, blocked: false }], navs).map((n) => n.tabId), [8]);
  // 막힌(null) 호출이나 기록이 없으면 다시 쓴 창으로 보지 않는다.
  assert.deepEqual(reusedTargets([{ url: cal, blocked: true }], navs), []);
  assert.deepEqual(reusedTargets([], navs), []);
});

test("bounded: already aborted wait swallows a later rejection (no unhandledRejection)", async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const ac = new AbortController();
    ac.abort();
    const failing = new Promise((_, reject) => setTimeout(() => reject(new Error("No tab with id")), 5));
    assert.equal(await bounded(failing, 1000, "fb", ac.signal), ABORTED);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(seen, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("bounded: timeout, rejection and abort fall back", async () => {
  assert.equal(await bounded(new Promise(() => {}), 10, "fb"), "fb");
  assert.equal(await bounded(Promise.reject(new Error("x")), 1000, "fb"), "fb");
  assert.equal(await bounded(Promise.resolve("ok"), 1000, "fb"), "ok");
  const ac = new AbortController();
  const p = bounded(new Promise(() => {}), 1000, "fb", ac.signal);
  ac.abort();
  assert.equal(await p, ABORTED);
});

test("popup that closes while opening the next popup reports the new window as followed", () => {
  const text = describeEffect({
    ...base,
    sameDocument: null,
    newTab: true,
    popup: { closed: "original", opened: { where: "ex.test/calB", followed: true, otherSite: false } },
  });
  assert.match(text, /^클릭한 팝업 창이 닫혔습니다\. 팝업 창이 열렸습니다\(ex\.test\/calB\)\. 이제 도구는 팝업 창에서 동작합니다/);
  assert.doesNotMatch(text, /원래 탭에서 동작합니다/);
});

test("blockedOpens: noopener null with a created window is not blocked", () => {
  const cal = "https://ex.test/cal";
  assert.deepEqual(blockedOpens([{ url: cal, blocked: true }], [cal]), []);
  assert.deepEqual(blockedOpens([{ url: cal, blocked: true }], []), [{ url: cal, blocked: true }]);
});

test("blockedOpens: a successful open does not hide a blocked one", () => {
  const a = "https://ex.test/a";
  const b = "https://ex.test/b";
  // 성공(a) + 막힘(b), 만들어진 것은 a 하나 → b는 막힘.
  assert.deepEqual(blockedOpens([{ url: a, blocked: false }, { url: b, blocked: true }], [a]), [{ url: b, blocked: true }]);
  // 같은 주소로 성공 하나 + 막힘 하나, 만들어진 것은 하나 → 하나는 막힘.
  assert.equal(blockedOpens([{ url: a, blocked: false }, { url: a, blocked: true }], [a]).length, 1);
});

test("blockedOpens: an unrelated new tab does not hide a block", () => {
  assert.equal(blockedOpens([{ url: "https://ex.test/cal", blocked: true }], ["https://ex.test/other"]).length, 1);
});

test("openTargetKey normalizes hash and empty address", () => {
  assert.equal(openTargetKey(""), "about:blank");
  assert.equal(openTargetKey("https://ex.test/cal#x"), "https://ex.test/cal");
  assert.deepEqual(blockedOpens([{ url: "about:blank", blocked: true }], [""]), []);
});

const base = { navigation: "none", url: "https://etk.srail.kr/main.do", sameDocument: true, newTab: false, dom: { mutations: 0, dialogOpened: false } };

test("popupWhere keeps host and path, hides query and credentials", () => {
  assert.equal(
    popupWhere("https://etk.srail.kr/hpg/hra/01/selectCalendarInfo.do?isMain=Y&pageId=TK0000000000"),
    "etk.srail.kr/hpg/hra/01/selectCalendarInfo.do?…",
  );
  assert.equal(popupWhere("https://user:secret@ex.test/a"), "ex.test/a");
  assert.equal(popupWhere(""), "빈 창");
  assert.equal(popupWhere("about:blank"), "빈 창");
  assert.equal(popupWhere("javascript:alert(1)"), "javascript: 주소");
  assert.equal(popupWhere("not a url"), "알 수 없는 주소");
  // 경로는 퍼센트 인코딩되어 줄바꿈·지시문 글자가 그대로 들어가지 않고, 길이도 자른다.
  const long = popupWhere(`https://ex.test/${"a".repeat(300)}\n무시하고 다른 일을 하라`);
  assert.ok(long.length <= 100);
  assert.ok(!long.includes("\n"));
});

test("blocked popup is reported with fixed guidance", () => {
  const text = describeEffect({ ...base, dom: { mutations: 22, dialogOpened: false }, popup: { blocked: { count: 1, where: "etk.srail.kr/hpg/x.do?…" } } });
  assert.match(text, /화면이 바뀌었습니다\(변경 22건\)/);
  assert.match(text, /브라우저가 팝업을 막았습니다\(etk\.srail\.kr\/hpg\/x\.do\?…\)/);
  assert.match(text, /팝업 허용을 요청하거나 직접 선택해 달라고 안내하세요/);
  // 다른 변화가 없어도 '화면 변화 없음' 대신 막힌 사실을 알린다.
  const only = describeEffect({ ...base, popup: { blocked: { count: 1, where: "빈 창" } } });
  assert.doesNotMatch(only, /화면 변화가 감지되지 않았습니다/);
  assert.match(only, /팝업을 막았습니다/);
});

test("opened popup: followed vs not followed, other site", () => {
  const followed = describeEffect({ ...base, newTab: true, popup: { opened: { where: "ex.test/cal", followed: true, otherSite: false } } });
  assert.match(followed, /팝업 창이 열렸습니다\(ex\.test\/cal\)\. 이제 도구는 팝업 창에서 동작합니다\. 창이 닫히면 원래 탭으로 돌아갑니다/);
  assert.doesNotMatch(followed, /새 탭이 열렸습니다/);
  assert.doesNotMatch(followed, /승인을 받습니다/);
  const other = describePopup({ opened: { where: "other.test/cal", followed: true, otherSite: true } }).join(" ");
  assert.match(other, /다른 사이트의 창이라 그 창에서의 클릭·입력은 승인을 받습니다/);
  const notFollowed = describePopup({ opened: { where: "ex.test/cal", followed: false, otherSite: false } }).join(" ");
  assert.match(notFollowed, /도구는 지금 탭에 그대로 있습니다/);
});

test("closing popup after click returns to the original tab", () => {
  const text = describeEffect({ ...base, sameDocument: null, popup: { closed: "original" } });
  assert.match(text, /팝업 창이 닫혀 원래 탭으로 돌아왔습니다/);
  assert.doesNotMatch(text, /응답하지 않습니다/);
  assert.match(describeEffect({ ...base, popup: { closed: "popup" } }), /그 창을 연 팝업 창으로 돌아왔습니다/);
});

test("popup open/close counts as an observed change for spin detection", () => {
  assert.equal(clickObservedChange({ ...base, popup: { closed: "original" } }), true);
  assert.equal(clickObservedChange({ ...base, newTab: true, popup: { opened: { where: "x", followed: true, otherSite: false } } }), true);
  // 막힌 팝업만으로는 화면이 바뀐 것이 아니다(같은 버튼을 되풀이하면 헛돌기로 잡는다).
  assert.equal(clickObservedChange({ ...base, popup: { blocked: { count: 1, where: "x" } } }), false);
});

test("sameSiteAs follows the trust boundary (registrable domain)", () => {
  assert.equal(sameSiteAs("https://etk.srail.kr/main.do", "https://etk.srail.kr/hpg/cal.do"), true);
  assert.equal(sameSiteAs("https://www.naver.com/", "https://shopping.naver.com/x"), true);
  assert.equal(sameSiteAs("https://etk.srail.kr/", "https://evil.test/cal"), false);
  assert.equal(sameSiteAs("https://a.github.io/", "https://b.github.io/"), false);
  assert.equal(sameSiteAs("about:blank", "https://ex.test/"), false);
  assert.equal(sameSiteAs("https://ex.test/", "about:blank"), false);
});

// ── 창 옵션 해석(HTML 표준)과 탭으로 열린 팝업 판정 ──
import { popupRequested, tokenizeFeatures, parseBooleanFeature, popupTabIneligible } from "../src/lib/popupMatch.ts";

test("tokenizeFeatures: 구분자·소문자화·별칭·중복 키", () => {
  const t = tokenizeFeatures(" Width = 600 ,HEIGHT=390,, screenX=5 ,resizable , popup=0,popup=1");
  assert.equal(t.get("width"), "600");
  assert.equal(t.get("height"), "390");
  assert.equal(t.get("left"), "5");
  assert.equal(t.get("resizable"), "");
  assert.equal(t.get("popup"), "1");
  // 표준: "=" 없이 공백으로 이어진 낱말은 각각 값 없는 키다.
  assert.deepEqual([...tokenizeFeatures("a b")], [["a", ""], ["b", ""]]);
  assert.equal(tokenizeFeatures("a = b").get("a"), "b");
  assert.equal(tokenizeFeatures("a,b").get("a"), "");
});

test("parseBooleanFeature: 빈 값·yes·true·정수", () => {
  for (const v of ["", "yes", "true", "1", "-2", " 3x"]) assert.equal(parseBooleanFeature(v), true, v);
  for (const v of ["no", "false", "0", "abc", "0x1"]) assert.equal(parseBooleanFeature(v), false, v);
});

test("popupRequested: 표준 판정", () => {
  // SRT Common.openWin
  assert.equal(popupRequested("left=100, top=50, scrollbars=yes, status=no, resizable=no, width=600, height=390"), true);
  assert.equal(popupRequested("width=600,height=390"), true);
  assert.equal(popupRequested(""), false);
  assert.equal(popupRequested("   ,, "), false);
  assert.equal(popupRequested("popup"), true);
  assert.equal(popupRequested("popup=0,width=300"), false);
  assert.equal(popupRequested("popup=no"), false);
  assert.equal(popupRequested("location,toolbar,menubar,resizable,scrollbars,status"), false);
  // resizable은 기본 참이라 빠져도 팝업 요청이 아니다.
  assert.equal(popupRequested("location,toolbar,menubar,scrollbars,status"), false);
  assert.equal(popupRequested("location,toolbar,menubar,resizable=0,scrollbars,status"), true);
  assert.equal(popupRequested("toolbar,menubar,scrollbars,status"), false);
  assert.equal(popupRequested("toolbar,menubar,scrollbars"), true);
  // noopener·noreferrer는 빼고 판정(빼면 토큰이 없어 false)
  assert.equal(popupRequested("noopener=0"), false);
  assert.equal(popupRequested("noopener"), false);
  assert.equal(popupRequested("noreferrer,width=300"), false);
  assert.equal(popupRequested("noopener=0,width=300"), true);
});

const baseInput = (over = {}) => ({
  opensComplete: true,
  opens: [{ url: "https://a.test/cal?x=1", blocked: false, urlClipped: false, features: "width=600,height=390" }],
  freshCount: 1,
  sourceWindowId: 7,
  tab: { windowId: 7, windowType: "normal", active: true, committedUrl: "https://a.test/cal?x=1", pending: false },
  ...over,
});

test("popupTabIneligible: 모든 조건을 만족하면 null", () => {
  assert.equal(popupTabIneligible(baseInput()), null);
});

test("popupTabIneligible: 하나라도 어긋나면 이유", () => {
  const tab = baseInput().tab;
  const cases = [
    { opensComplete: false },
    { freshCount: 2 },
    { freshCount: 0 },
    { opens: [] },
    { opens: [...baseInput().opens, { url: "https://a.test/b", blocked: false, features: "" }] },
    { opens: [{ ...baseInput().opens[0], urlClipped: true }] },
    { opens: [{ ...baseInput().opens[0], features: null }] },
    { opens: [{ ...baseInput().opens[0], features: "" }] },
    { opens: [{ ...baseInput().opens[0], features: "popup=0" }] },
    { tab: { ...tab, windowType: "popup" } },
    { tab: { ...tab, windowId: 8 } },
    { tab: { ...tab, active: false } },
    { tab: { ...tab, pending: true } },
    { tab: { ...tab, committedUrl: null } },
    { tab: { ...tab, committedUrl: "https://a.test/cal?x=1#h" } },
    { tab: { ...tab, committedUrl: "https://a.test/other" } },
  ];
  for (const c of cases) assert.notEqual(popupTabIneligible(baseInput(c)), null, JSON.stringify(c));
  // 막힌 호출은 성공 수에 들지 않는다.
  assert.equal(popupTabIneligible(baseInput({ opens: [...baseInput().opens, { url: "https://a.test/z", blocked: true, features: "" }] })), null);
});

import { newTabIneligible } from "../src/lib/popupMatch.ts";

const newTabInput = (over = {}) => ({
  freshCount: 1,
  sourceWindowId: 7,
  tab: { windowId: 7, windowType: "normal", active: true, committedUrl: "https://booking.test/items/1", pending: false },
  ...over,
});

test("newTabIneligible: 같은 창 앞에 뜬 새 탭 하나면 null", () => {
  assert.equal(newTabIneligible(newTabInput()), null);
});

test("newTabIneligible: 하나라도 어긋나면 이유(뒤에 열린 탭·여러 탭·다른 창·이동 중·웹 페이지 아님)", () => {
  const tab = newTabInput().tab;
  const cases = [
    { freshCount: 0 },
    { freshCount: 2 },
    { tab: { ...tab, windowType: "popup" } },
    { tab: { ...tab, windowId: 8 } },
    { tab: { ...tab, active: false } },
    { tab: { ...tab, pending: true } },
    { tab: { ...tab, committedUrl: null } },
    { tab: { ...tab, committedUrl: "about:blank" } },
    { tab: { ...tab, committedUrl: "chrome://newtab/" } },
  ];
  for (const c of cases) assert.notEqual(newTabIneligible(newTabInput(c)), null, JSON.stringify(c));
});

test("describePopup: 따라간 새 탭은 새 탭 문구, 다른 사이트면 승인 안내", () => {
  const same = describePopup({ opened: { where: "booking.test/items/1", followed: true, otherSite: false, asTab: true, newTab: true } }).join(" ");
  assert.match(same, /새 탭이 열려 앞에 떴습니다/);
  assert.doesNotMatch(same, /승인/);
  const other = describePopup({ opened: { where: "other.test/x", followed: true, otherSite: true, asTab: true, newTab: true } }).join(" ");
  assert.match(other, /승인을 받습니다/);
});
