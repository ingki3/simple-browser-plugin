// 승인·허락 상태(#263 단계 6, agent/grants.ts의 ConversationGrants). 필드별 삭제 누락은 이 시험이 맡는다(계획 1차 리뷰 P2-1):
// 10개 필드를 모두 채운 객체에 각 정리 메서드만 불러 필드별 기대 상태(R1 표 현재판)를 본다. 하네스(panel-reconnect)는 실제 재연결
// 흐름의 통합 확인이다. 필드 이름은 런타임에서 읽는다(TS private) — 제품 코드에 시험 훅을 두지 않는다.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers/agentLoader.mjs";

const { ConversationGrants } = await import("../src/background/agent/grants.ts");
const { ChatAgent } = await import("../src/background/agent/chatAgent.ts");

let logs;
beforeEach(() => {
  logs = [];
  globalThis.__agentStubs = { "debug.debugLog": (k, v) => logs.push(`${k}${v !== undefined ? ` ${v}` : ""}`) };
});

const FIELDS = [
  "approvedSites",
  "_linkGrant",
  "linkGrantOffers",
  "_chatGrants",
  "chatGrantOffers",
  "_allowedPersonalUrls",
  "personalUrlOffers",
  "loginSiteOffers",
  "signInTokens",
  "rememberLogin",
];

// 필드마다 비었는지(linkGrant는 null인지).
function emptiness(g) {
  const out = {};
  for (const f of FIELDS) {
    const v = g[f];
    if (f === "_linkGrant") out[f] = v === null;
    else if (v instanceof Map || v instanceof Set) out[f] = v.size === 0;
    else throw new Error(`알 수 없는 필드 ${f}`);
  }
  return out;
}

const offers = (o) => ({
  turn: 1,
  toolName: "click_element",
  linkOffer: false,
  pageSite: null,
  urlOffer: false,
  personalUrlKeys: [],
  loginOffer: null,
  signIn: undefined,
  chatGrantOffer: false,
  grantScope: undefined,
  ...o,
});

const NONE = { allowLinksThisTurn: false, allowToolThisChat: false, allowUrlsThisChat: false, rememberLoginSite: false };
const ALL = { allowLinksThisTurn: true, allowToolThisChat: true, allowUrlsThisChat: true, rememberLoginSite: true };

// 10개 필드를 모두 채운다: c1(sign_in — 로그인 제안·준비 열쇠·묶기 선택), c2(대화 허락 도구 — 링크·주소·대화 허락 제안을 받아들임),
// c3(제안만 남은 열린 카드 — 받은 뒤에도 제안 맵이 비지 않게).
function filled() {
  const g = new ConversationGrants();
  g.addApprovedSite("http://a.test");
  g.recordOffers("c1", offers({ toolName: "sign_in", loginOffer: "http://login.test", signIn: { token: "tok1" } }));
  g.recordOffers("c2", offers({ toolName: "read_linked_pages", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k1", "k2"], chatGrantOffer: true, grantScope: "" }));
  g.recordOffers("c3", offers({ toolName: "translate_page", linkOffer: true, pageSite: "http://q.test", urlOffer: true, personalUrlKeys: ["k3"], chatGrantOffer: true, grantScope: "ko" }));
  g.acceptOffers("c1", ALL, { pending: true, currentTurn: 1 });
  g.acceptOffers("c2", ALL, { pending: true, currentTurn: 1 });
  const e = emptiness(g);
  for (const f of FIELDS) assert.equal(e[f], false, `채운 상태: ${f}`);
  return g;
}

const expectState = (g, emptyFields, label) => {
  const e = emptiness(g);
  for (const f of FIELDS) assert.equal(e[f], emptyFields.includes(f), `${label}: ${f}는 ${emptyFields.includes(f) ? "비어야" : "남아야"} 한다`);
};

const OFFER_FIELDS = ["linkGrantOffers", "chatGrantOffers", "personalUrlOffers"];

test("R1 clearForReconnect: 10개 필드를 모두 지운다", () => {
  const g = filled();
  g.clearForReconnect();
  expectState(g, FIELDS, "clearForReconnect");
});

test("R1 clearForCancel: 허락 제안 3개만 지우고 받은 허락·로그인 제안·준비 열쇠·묶기 선택은 남긴다", () => {
  const g = filled();
  g.clearForCancel();
  expectState(g, OFFER_FIELDS, "clearForCancel");
});

test("R1 takeCallOffers: 그 callId의 제안만 지우고 묶기를 골랐으면 출처를 돌려준다(받은 허락·다른 callId는 그대로)", () => {
  const g = filled();
  assert.deepEqual(g.takeCallOffers("c1"), { rememberOrigin: "http://login.test" });
  assert.equal(g.loginSiteOffers.has("c1"), false);
  assert.equal(g.signInTokens.has("c1"), false);
  assert.equal(g.rememberLogin.has("c1"), false);
  assert.equal(g.signInToken("c1"), undefined);
  // c2·c3 제안은 남고 받은 허락도 남는다.
  assert.equal(g.linkGrantOffers.size, 2);
  assert.equal(g.chatGrantOffers.size, 2);
  assert.equal(g.personalUrlOffers.size, 2);
  assert.deepEqual(g.takeCallOffers("c2"), { rememberOrigin: undefined });
  assert.deepEqual([...g.linkGrantOffers.keys()], ["c3"]);
  assert.deepEqual([...g.chatGrantOffers.keys()], ["c3"]);
  assert.deepEqual([...g.personalUrlOffers.keys()], ["c3"]);
  assert.deepEqual(g.linkGrant, { turn: 1, site: "http://p.test" });
  assert.deepEqual([...g.allowedPersonalUrls], ["k1", "k2"]);
  assert.deepEqual(g.chatGrantList(), [{ tool: "read_linked_pages", scope: "" }]);
  assert.deepEqual([...g.approvedSiteSet()], ["http://a.test"]);
});

test("takeCallOffers: 로그인 제안이 있어도 묶기를 고르지 않았으면 rememberOrigin이 없다", () => {
  const g = new ConversationGrants();
  g.recordOffers("s1", offers({ toolName: "sign_in", loginOffer: "http://login.test", signIn: { token: "t" } }));
  g.acceptOffers("s1", { ...NONE }, { pending: true, currentTurn: 1 });
  assert.deepEqual(g.takeCallOffers("s1"), { rememberOrigin: undefined });
  expectState(g, FIELDS, "고르지 않고 정리한 뒤");
});

test("recordOffers: 보인 제안만 남긴다(사이트 없는 링크 제안·sign_in 밖의 준비 열쇠·대화 허락 도구 밖의 대화 허락 제안은 남기지 않음)", () => {
  const g = new ConversationGrants();
  g.recordOffers("x", offers({ toolName: "click_element", linkOffer: true, pageSite: null, signIn: { token: "t" }, chatGrantOffer: true }));
  expectState(g, FIELDS, "남길 제안 없음");
  g.recordOffers("y", offers({ toolName: "download_images", chatGrantOffer: true }));
  assert.deepEqual(g.chatGrantOffers.get("y"), { tool: "download_images", scope: "" }, "범위가 없으면 빈 글자");
});

test("acceptOffers: 대기 중이 아닌 callId의 선택은 하나도 받지 않는다", () => {
  const g = new ConversationGrants();
  g.recordOffers("c", offers({ toolName: "read_linked_pages", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k"], chatGrantOffer: true, loginOffer: "http://l.test" }));
  assert.deepEqual(g.acceptOffers("c", ALL, { pending: false, currentTurn: 1 }), { chatGrantAccepted: false });
  assert.equal(g.linkGrant, null);
  assert.equal(g.allowedPersonalUrls.size, 0);
  assert.equal(g.chatGrants.size, 0);
  assert.equal(g.rememberLogin.size, 0);
  assert.deepEqual(logs, []);
});

test("acceptOffers: 다른 턴의 링크·주소 제안은 받지 않는다(대화 허락은 턴과 무관)", () => {
  const g = new ConversationGrants();
  g.recordOffers("c", offers({ turn: 1, toolName: "read_linked_pages", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k"], chatGrantOffer: true }));
  assert.deepEqual(g.acceptOffers("c", ALL, { pending: true, currentTurn: 2 }), { chatGrantAccepted: true });
  assert.equal(g.linkGrant, null, "다른 턴의 링크 제안");
  assert.equal(g.allowedPersonalUrls.size, 0, "다른 턴의 주소 제안");
  assert.deepEqual(g.chatGrantList(), [{ tool: "read_linked_pages", scope: "" }]);
});

test("acceptOffers: 보이지 않은 제안·고르지 않은 선택은 받지 않는다", () => {
  const g = new ConversationGrants();
  // 제안 없이 온 선택.
  assert.deepEqual(g.acceptOffers("nope", ALL, { pending: true, currentTurn: 1 }), { chatGrantAccepted: false });
  expectState(g, FIELDS, "제안 없는 선택");
  // 제안은 있으나 선택하지 않음.
  g.recordOffers("c", offers({ toolName: "read_linked_pages", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k"], chatGrantOffer: true, loginOffer: "http://l.test" }));
  assert.deepEqual(g.acceptOffers("c", NONE, { pending: true, currentTurn: 1 }), { chatGrantAccepted: false });
  assert.equal(g.linkGrant, null);
  assert.equal(g.allowedPersonalUrls.size, 0);
  assert.equal(g.chatGrants.size, 0);
  assert.equal(g.rememberLogin.size, 0);
  assert.deepEqual(logs, []);
});

test("acceptOffers: 받아들이면 링크 → 주소 → 대화 허락 순서로 기록하고, 같은 값을 다시 받아도 chatGrantAccepted=true", () => {
  const g = new ConversationGrants();
  const rec = () => g.recordOffers("c", offers({ toolName: "download_images", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k1", "k2"], chatGrantOffer: true, grantScope: "폴더" }));
  rec();
  assert.deepEqual(g.acceptOffers("c", ALL, { pending: true, currentTurn: 1 }), { chatGrantAccepted: true });
  assert.deepEqual(logs, ["tool:link_grant turn 1", "tool:url_allow 2개 주소", "tool:chat_grant download_images · 폴더"]);
  logs.length = 0;
  rec();
  assert.deepEqual(g.acceptOffers("c", { ...NONE, allowToolThisChat: true }, { pending: true, currentTurn: 1 }), { chatGrantAccepted: true }, "같은 도구·범위 재수락");
  assert.deepEqual(logs, ["tool:chat_grant download_images · 폴더"]);
  assert.deepEqual(g.chatGrantList(), [{ tool: "download_images", scope: "폴더" }]);
});

test("객체 참조: 판정 입력 getter는 같은 객체를 돌려주고, 링크 허락은 제안 객체 그대로, approvedSiteSet은 복사본", () => {
  const g = new ConversationGrants();
  const urls = g.allowedPersonalUrls;
  const chat = g.chatGrants;
  g.recordOffers("c", offers({ toolName: "read_linked_pages", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k"], chatGrantOffer: true }));
  const offer = g.linkGrantOffers.get("c");
  g.acceptOffers("c", ALL, { pending: true, currentTurn: 1 });
  assert.equal(g.allowedPersonalUrls, urls, "주소 허락 Set은 같은 객체");
  assert.equal(g.chatGrants, chat, "대화 허락 Map은 같은 객체");
  assert.equal(g.allowedPersonalUrls, g._allowedPersonalUrls);
  assert.equal(g.chatGrants, g._chatGrants);
  assert.equal(g.linkGrant, offer, "링크 허락은 받아들인 제안 객체 그대로(옮기기 전 this.linkGrant = offer)");
  assert.ok(urls.has("k") && chat.has("read_linked_pages"), "앞서 받은 참조로도 새 값이 보인다");
  g.clearForReconnect();
  assert.equal(g.allowedPersonalUrls, urls, "지워도 같은 객체(clear)");
  assert.equal(g.chatGrants, chat);
  g.addApprovedSite("http://a.test");
  const copy = g.approvedSiteSet();
  copy.add("http://b.test");
  assert.deepEqual([...g.approvedSiteSet()], ["http://a.test"], "복사본에 더해도 허락은 그대로");
  assert.notEqual(g.approvedSiteSet(), g.approvedSites);
});

test("revokeChatGrant: 허락한 도구만 지우고 true, 없거나 대화 허락 도구가 아니면 false", () => {
  const g = new ConversationGrants();
  g.recordOffers("c", offers({ toolName: "translate_page", chatGrantOffer: true, grantScope: "ko" }));
  g.acceptOffers("c", { ...NONE, allowToolThisChat: true }, { pending: true, currentTurn: 1 });
  assert.equal(g.revokeChatGrant("click_element"), false);
  assert.equal(g.revokeChatGrant("read_linked_pages"), false);
  assert.equal(g.revokeChatGrant("translate_page"), true);
  assert.equal(g.revokeChatGrant("translate_page"), false);
  assert.equal(g.chatGrants.size, 0);
});

// ChatAgent 연결(agentLoader): 정리 경로가 맞는 메서드를 부르는지, approveTool의 순서.
function agentWith() {
  const posted = [];
  const agent = new ChatAgent({ postMessage: (m) => posted.push(m) });
  return { agent, posted };
}

function fillAgent(agent) {
  const g = agent.grants;
  g.addApprovedSite("http://a.test");
  g.recordOffers("c1", offers({ turn: agent.currentTurn, toolName: "sign_in", loginOffer: "http://login.test", signIn: { token: "tok1" } }));
  g.recordOffers("c2", offers({ turn: agent.currentTurn, toolName: "read_linked_pages", linkOffer: true, pageSite: "http://p.test", urlOffer: true, personalUrlKeys: ["k"], chatGrantOffer: true }));
  g.recordOffers("c3", offers({ turn: agent.currentTurn, toolName: "translate_page", linkOffer: true, pageSite: "http://q.test", urlOffer: true, personalUrlKeys: ["k3"], chatGrantOffer: true }));
  agent.pendingApprovals.set("c1", () => {});
  agent.pendingApprovals.set("c2", () => {});
  agent.approveTool("c1", false, undefined, false, false, true);
  agent.approveTool("c2", true, undefined, true, true);
  agent.pendingApprovals.clear();
  for (const f of FIELDS) assert.equal(emptiness(g)[f], false, `채운 상태: ${f}`);
}

test("ChatAgent: suspendForReconnect는 허락 10개를 모두 지우고, abort(cancelInFlight)는 제안 3개만 지운다", () => {
  const { agent } = agentWith();
  fillAgent(agent);
  agent.abort();
  expectState(agent.grants, OFFER_FIELDS, "abort");
  const { agent: b } = agentWith();
  fillAgent(b);
  b.suspendForReconnect();
  expectState(b.grants, FIELDS, "suspendForReconnect");
});

test("ChatAgent.approveTool: 대화 허락 기록 → chat_grants 전송 → 승인 순서(같은 값 재수락도 같음)", () => {
  const { agent, posted } = agentWith();
  const order = [];
  globalThis.__agentStubs["debug.debugLog"] = (k) => order.push(`log ${k}`);
  const g = agent.grants;
  for (let i = 0; i < 2; i++) {
    order.length = 0;
    posted.length = 0;
    g.recordOffers("c", offers({ turn: agent.currentTurn, toolName: "read_linked_pages", chatGrantOffer: true }));
    agent.pendingApprovals.set("c", (v) => order.push(`resolve ${v} (전송 ${posted.length})`));
    const before = posted.length;
    agent.approveTool("c", false, undefined, true);
    assert.deepEqual(order, ["log tool:chat_grant", "resolve true (전송 1)"], `${i + 1}번째`);
    assert.equal(posted.length - before, 1);
    assert.deepEqual(posted.at(-1), { kind: "chat_grants", grants: [{ tool: "read_linked_pages", scope: "" }] });
    agent.pendingApprovals.delete("c");
    g.takeCallOffers("c");
  }
  // 허락 선택 없이 승인하면 chat_grants를 보내지 않는다.
  posted.length = 0;
  g.recordOffers("d", offers({ turn: agent.currentTurn, toolName: "read_linked_pages", chatGrantOffer: true }));
  let resolved = null;
  agent.pendingApprovals.set("d", (v) => (resolved = v));
  agent.approveTool("d");
  assert.equal(resolved, true);
  assert.equal(posted.filter((m) => m.kind === "chat_grants").length, 0);
});

test("ChatAgent.revokeChatGrant: 지웠을 때만 기록하고 chat_grants를 보낸다", () => {
  const { agent, posted } = agentWith();
  agent.revokeChatGrant("read_linked_pages");
  assert.equal(posted.length, 0);
  agent.grants.recordOffers("c", offers({ turn: agent.currentTurn, toolName: "read_linked_pages", chatGrantOffer: true }));
  agent.pendingApprovals.set("c", () => {});
  agent.approveTool("c", false, undefined, true);
  posted.length = 0;
  logs.length = 0;
  agent.revokeChatGrant("read_linked_pages");
  assert.deepEqual(logs, ["tool:chat_grant_revoked read_linked_pages"]);
  assert.deepEqual(posted, [{ kind: "chat_grants", grants: [] }]);
});
