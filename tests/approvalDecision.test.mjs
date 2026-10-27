import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApproval, withoutChatGrant } from "../src/lib/approvalDecision.ts";

const PAGE = "https://shop.example/list";
const SITE = "https://shop.example";
const link = (href) => ({ tag: "a", role: "link", text: "다음", href });

// 기본: 자동 실행 꺼짐, 보호 아님, 지금 페이지 = shop.example(신뢰 사이트).
const input = (over = {}) => ({
  toolName: "click_element",
  preview: { autoBlock: null, linkHrefs: [], fillValues: [] },
  guarded: false,
  autoApprove: false,
  taskMode: false,
  pageUrl: PAGE,
  manualSite: false,
  trusted: new Set([SITE]),
  turn: 1,
  linkGrant: null,
  fromInternal: false,
  namedSites: [],
  allowedPersonalUrls: new Set(),
  chatGrants: new Map(),
  ...over,
});

// 승인 규칙 표: [이름, 입력 덮어쓰기, 기대 mode, 기대 block(정규식 또는 null)]
const TABLE = [
  ["자동 실행 꺼짐 → 카드", {}, "card", null],
  ["자동 실행 + 같은 사이트 일반 클릭 → 자동", { autoApprove: true }, "auto", null],
  ["자동 실행 + 결제 단서(autoBlock) → 카드", { autoApprove: true, preview: { autoBlock: "결제·구매 동작" } }, "card", /결제/],
  ["자동 실행 + 늘 묻는 동작(#62) → 카드", { autoApprove: true, preview: { autoBlock: null, alwaysAsk: "삭제" } }, "card", /삭제/],
  ["자동 실행 + 보호 중(#37) → 카드", { autoApprove: true, guarded: true }, "card", null],
  ["자동 실행 + 다른 사이트 페이지의 클릭 → 카드", { autoApprove: true, pageUrl: "https://other.example/x" }, "card", /./],
  ["자동 실행 + 다른 사이트로 가는 링크 → 카드", { autoApprove: true, preview: { autoBlock: null, linkHrefs: ["https://evil.example/"] } }, "card", /./],
  ["직접 조작할 사이트(0.2.2) → 손 넘기기", { autoApprove: true, manualSite: true }, "handoff", null],
  ["직접 조작할 사이트라도 이동은 손 넘기기 아님", { toolName: "navigate_to_url", manualSite: true, preview: { details: `${SITE}/a` } }, "card", null],
  ["자동 실행 + 신뢰 사이트 안 이동 → 자동", { toolName: "navigate_to_url", autoApprove: true, pageUrl: undefined, preview: { details: `${SITE}/b` } }, "auto", null],
  ["자동 실행 + 사이트 밖 이동 → 카드", { toolName: "navigate_to_url", autoApprove: true, pageUrl: undefined, preview: { details: "https://other.example/" } }, "card", /사이트 밖/],
  ["내부 페이지에서 요청에 적은 사이트로 이동(#54) → 자동", { toolName: "navigate_to_url", autoApprove: true, pageUrl: undefined, trusted: new Set(), fromInternal: true, namedSites: ["https://news.example"], preview: { details: "https://news.example/" } }, "auto", null],
  // 처음에 승인 받고 끝까지 실행(#123): 사용자가 고르는 카드(로그인 항목·다른 탭)와 손 넘기기 밖은 모두 맡긴 작업으로 실행한다.
  ["맡기기 방식 + 결제 단서 → 맡긴 작업", { taskMode: true, preview: { autoBlock: "결제·구매 동작" } }, "task", null],
  ["맡기기 방식 + 늘 묻는 동작 → 맡긴 작업", { taskMode: true, preview: { autoBlock: null, alwaysAsk: "삭제" } }, "task", null],
  ["맡기기 방식 + 보호 중 → 맡긴 작업", { taskMode: true, guarded: true }, "task", null],
  ["맡기기 방식 + 다른 사이트 이동 → 맡긴 작업", { toolName: "navigate_to_url", taskMode: true, pageUrl: undefined, preview: { details: "https://other.example/" } }, "task", null],
  ["맡기기 방식 + 직접 조작할 사이트 → 손 넘기기", { taskMode: true, manualSite: true }, "handoff", null],
  ["맡기기 방식 + 다른 탭 읽기 → 카드(탭은 사용자가 고름)", { toolName: "read_other_tabs", taskMode: true, pageUrl: undefined, preview: {} }, "card", null],
  ["맡기기 방식 + 로그인 → 맡긴 작업 아님", { toolName: "sign_in", taskMode: true, preview: {} }, "card", null],
  ["내부 페이지에서 적지 않은 사이트로 이동 → 카드", { toolName: "navigate_to_url", autoApprove: true, pageUrl: undefined, trusted: new Set(), fromInternal: true, namedSites: ["https://news.example"], preview: { details: "https://other.example/" } }, "card", /./],
];

for (const [name, over, mode, block] of TABLE) {
  test(`승인 규칙: ${name}`, () => {
    const d = decideApproval(input(over));
    assert.equal(d.mode, mode, JSON.stringify(d));
    if (block) assert.match(d.block ?? "", block);
    else if (mode === "auto") assert.equal(d.block, null);
  });
}

test("링크 이동 허락(#28): 같은 사이트 일반 링크면 제안, 같은 턴에 허락했으면 자동 실행(결제 문구 판정 없이)", () => {
  const preview = { autoBlock: "결제·구매 동작", linkHrefs: [`${SITE}/next`], clickTarget: link(`${SITE}/next`) };
  const offer = decideApproval(input({ preview }));
  assert.equal(offer.linkOffer, true);
  assert.equal(offer.mode, "card");
  const granted = decideApproval(input({ preview, linkGrant: { turn: 1, site: SITE } }));
  assert.equal(granted.linkGranted, true);
  assert.equal(granted.mode, "auto");
  // 다른 턴의 허락은 쓰지 않는다.
  assert.equal(decideApproval(input({ preview, linkGrant: { turn: 0, site: SITE } })).mode, "card");
  // 늘 묻는 동작·보호 중에는 제안도 사용도 하지 않는다.
  const always = decideApproval(input({ preview: { ...preview, alwaysAsk: "삭제" }, linkGrant: { turn: 1, site: SITE } }));
  assert.equal(always.linkOffer, false);
  assert.equal(always.mode, "card");
  assert.equal(decideApproval(input({ preview, guarded: true, linkGrant: { turn: 1, site: SITE } })).mode, "card");
  // 다른 사이트로 가는 링크는 제안하지 않는다.
  const out = decideApproval(input({ preview: { linkHrefs: ["https://other.example/"], clickTarget: link("https://other.example/") } }));
  assert.equal(out.linkOffer, false);
});

test("개인정보 모양 주소: 그것만 막을 때 '다시 묻지 않기'를 제안하고, 모두 허용했으면 그 신호를 뺀 판정", () => {
  const preview = { autoBlock: "개인정보 모양 주소", personalUrlKeys: ["k1"], autoBlockIfUrlsAllowed: null, linkHrefs: [] };
  const d = decideApproval(input({ autoApprove: true, preview }));
  assert.equal(d.mode, "card");
  assert.equal(d.urlOffer, true);
  const allowed = decideApproval(input({ autoApprove: true, preview, allowedPersonalUrls: new Set(["k1"]) }));
  assert.equal(allowed.mode, "auto");
  assert.equal(allowed.urlOffer, false);
  // 다른 이유도 함께 있으면(autoBlockIfUrlsAllowed가 남음) 제안하지 않는다.
  const other = decideApproval(input({ autoApprove: true, preview: { ...preview, autoBlockIfUrlsAllowed: "결제" } }));
  assert.equal(other.urlOffer, false);
  // 자동 실행이 꺼져 있으면 제안하지 않는다.
  assert.equal(decideApproval(input({ preview })).urlOffer, false);
});

test("이번 대화 허락(#53): 같은 범위면 카드 없이, 처음이면 제안, 경고·보호 중 외부 전송 도구는 덮지 않음", () => {
  const base = { toolName: "download_images", pageUrl: undefined, preview: { grantBlock: null, grantScope: "imgs" } };
  assert.equal(decideApproval(input({ ...base, chatGrants: new Map([["download_images", "imgs"]]) })).mode, "grant");
  const first = decideApproval(input(base));
  assert.equal(first.mode, "card");
  assert.equal(first.chatGrant.offer, true);
  assert.equal(decideApproval(input({ ...base, chatGrants: new Map([["download_images", "other"]]) })).mode, "card");
  const warned = decideApproval(input({ ...base, preview: { grantBlock: "페이지에 없는 이미지", grantScope: "imgs" }, chatGrants: new Map([["download_images", "imgs"]]) }));
  assert.equal(warned.mode, "card");
  assert.match(warned.chatGrant.reason ?? "", /페이지에 없는/);
  const always = decideApproval(input({ ...base, preview: { alwaysAsk: "삭제", grantScope: "imgs" }, chatGrants: new Map([["download_images", "imgs"]]) }));
  assert.equal(always.mode, "card");
  // 미리 받기에 실패하면 허락을 쓰지 않고 그 이유로 카드.
  const fell = withoutChatGrant(decideApproval(input({ ...base, chatGrants: new Map([["download_images", "imgs"]]) })), "리다이렉트");
  assert.equal(fell.mode, "card");
  assert.equal(fell.chatGrant.reason, "리다이렉트");
});

test("손 넘기기는 다른 판정보다 앞선다(자동 실행·허락과 무관)", () => {
  const d = decideApproval(input({ manualSite: true, autoApprove: false, toolName: "fill_form_fields" }));
  assert.equal(d.mode, "handoff");
  assert.equal(withoutChatGrant(d, "x").mode, "handoff");
});

test("맡긴 작업(#123)은 이번 대화 허락을 못 쓰게 돼도 맡긴 작업으로 남는다", () => {
  const d = decideApproval(input({ taskMode: true, toolName: "download_images", pageUrl: undefined, preview: {} }));
  assert.equal(d.mode, "task");
  assert.equal(withoutChatGrant(d, "이유").mode, "task");
});
