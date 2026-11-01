// 목록형 승인 설정의 항목 단위 변경과 설정 캐시 세대(#127).
import test from "node:test";
import assert from "node:assert/strict";

import { applyLoginSiteOp, applyManualSiteOp, parseLoginSiteOp, parseManualSiteOp, withGrantIds } from "../src/lib/settingsOps.ts";
import { GRANT_ID_RE, MAX_LOGIN_SITES, newGrantId, normalizeLoginSites } from "../src/lib/loginPolicy.ts";
import { MAX_MANUAL_SITES } from "../src/lib/manualSites.ts";
import { makeGenCache } from "../src/lib/genCache.ts";

const G1 = "AAAAAAAAAAAAAAAAAAAAAA";
const G2 = "BBBBBBBBBBBBBBBBBBBBBB";
const site = (origin, grantId = G1, over = {}) => ({ origin, uuid: "a".repeat(32), entryName: "x", totp: false, grantId, ...over });

test("직접 조작할 사이트: 그때의 목록에 하나씩 — 동시 추가는 둘 다 남고, 뺀 것은 다른 추가로 되살아나지 않는다", () => {
  let list = ["https://a.example"];
  // 두 화면이 같은 옛 목록을 보고 각각 추가해도 순서대로 최신 목록에 적용된다.
  list = applyManualSiteOp(list, { op: "add", site: "https://b.example" }).list;
  list = applyManualSiteOp(list, { op: "add", site: "https://c.example" }).list;
  assert.deepEqual(list, ["https://a.example", "https://b.example", "https://c.example"]);
  list = applyManualSiteOp(list, { op: "remove", site: "https://a.example" }).list;
  list = applyManualSiteOp(list, { op: "add", site: "https://d.example" }).list;
  assert.ok(!list.includes("https://a.example"));
  assert.deepEqual(applyManualSiteOp(list, { op: "add", site: "https://b.example" }).list, list);
  assert.deepEqual(applyManualSiteOp(list, { op: "remove", site: "https://zz.example" }).list, list);
  const full = Array.from({ length: MAX_MANUAL_SITES }, (_, i) => `https://s${i}.example`);
  assert.equal(applyManualSiteOp(full, { op: "add", site: "https://new.example" }).ok, false);
});

test("직접 조작할 사이트 메시지 검사: 정규화한 출처만", () => {
  assert.deepEqual(parseManualSiteOp({ op: "add", site: "https://a.example" }), { op: "add", site: "https://a.example" });
  for (const bad of [null, {}, { op: "add" }, { op: "x", site: "https://a.example" }, { op: "add", site: "https://a.example/path" }, { op: "add", site: "javascript:1" }, { op: "remove", site: "HTTPS://A.example" }]) {
    assert.equal(parseManualSiteOp(bad), null, JSON.stringify(bad));
  }
});

test("자동 로그인: 보던 승인(grantId)과 같을 때만 — 지웠다 다시 승인(같은 항목이어도)하면 옛 변경은 거절", () => {
  const o = "https://login.example";
  let list = [site(o, G1)];
  const r = applyLoginSiteOp(list, { op: "set_totp", origin: o, grantId: G1, totp: true });
  assert.ok(r.ok && r.list[0].totp === true);
  // 삭제 → 같은 uuid로 재승인(새 grantId, totp:false) → 첫 승인의 늦은 totp 변경.
  list = applyLoginSiteOp(list, { op: "remove", origin: o, grantId: G1 }).list;
  assert.deepEqual(list, []);
  list = [site(o, G2)];
  const late = applyLoginSiteOp(list, { op: "set_totp", origin: o, grantId: G1, totp: true });
  assert.equal(late.ok, false);
  assert.equal(applyLoginSiteOp(list, { op: "remove", origin: o, grantId: G1 }).ok, false);
  // 없는 항목 빼기는 그대로(이미 원하는 결과).
  assert.ok(applyLoginSiteOp([], { op: "remove", origin: o, grantId: G1 }).ok);
  // 아직 grantId가 없는 옛 항목은 바꾸지 않는다(채운 뒤 다시).
  assert.equal(applyLoginSiteOp([site(o, "")], { op: "remove", origin: o, grantId: G1 }).ok, false);
});

test("자동 로그인 메시지 검사와 grantId 채우기·보존", () => {
  assert.ok(parseLoginSiteOp({ op: "set_totp", origin: "https://login.example", grantId: G1, totp: false }));
  for (const bad of [
    { op: "remove", origin: "https://login.example" },
    { op: "remove", origin: "https://login.example", grantId: "short" },
    { op: "set_totp", origin: "https://login.example", grantId: G1, totp: "yes" },
    { op: "remove", origin: "http://login.example", grantId: G1 },
    { op: "remove", origin: "https://login.example/a", grantId: G1 },
  ]) {
    assert.equal(parseLoginSiteOp(bad), null, JSON.stringify(bad));
  }
  assert.match(newGrantId(), GRANT_ID_RE);
  assert.notEqual(newGrantId(), newGrantId());
  const filled = withGrantIds([site("https://a.example", ""), site("https://b.example", G2)], () => G1);
  assert.deepEqual(filled.map((s) => s.grantId), [G1, G2]);
  assert.equal(withGrantIds([site("https://a.example", G2)], () => G1), null);
  // 저장 값 정리: 맞는 grantId는 남기고, 이상한 값은 비운다(채우기 대상).
  const norm = normalizeLoginSites([site("https://a.example", G1), site("https://b.example", "bad!")]);
  assert.deepEqual(norm.map((s) => s.grantId), [G1, ""]);
  assert.ok(MAX_LOGIN_SITES > 0);
});

test("설정 캐시: 읽는 사이 무효화되면 옛 결과를 넣지 않고 다시 읽는다, 동시 호출은 한 번만 읽는다", async () => {
  let stored = "openai";
  let reads = 0;
  let release;
  const gate = () => new Promise((r) => (release = r));
  let hold = null;
  const cache = makeGenCache(async () => {
    reads += 1;
    const v = stored;
    if (hold) await hold;
    return v;
  });
  hold = gate();
  const a = cache.get();
  const b = cache.get();
  // 읽는 중에 저장이 끝나 무효화된다.
  stored = "gemini";
  cache.invalidate();
  hold = null;
  release();
  assert.equal(await a, "gemini");
  assert.equal(await b, "gemini");
  assert.equal(await cache.get(), "gemini");
  assert.equal(reads, 2);
  // 무효화가 없으면 캐시를 쓴다.
  assert.equal(await cache.get(), "gemini");
  assert.equal(reads, 2);
});

import { tabSiteChoices } from "../src/lib/manualSites.ts";
import { settingsSectionOf } from "../src/lib/settingsSections.ts";

test("열린 탭에서 고르기: 웹 주소 탭의 출처만, 이미 넣은 사이트·중복 빼고, 제목은 60자", () => {
  const tabs = [
    { url: "https://etk.srail.kr/main.do", title: "SRT" },
    { url: "https://etk.srail.kr/other", title: "두 번째" },
    { url: "chrome://extensions/", title: "확장" },
    { url: "chrome-extension://abc/src/options/index.html", title: "설정" },
    { url: "https://a.example/x", title: "가".repeat(80) },
    { url: "https://done.example/", title: "이미" },
    { title: "주소 없음" },
  ];
  const out = tabSiteChoices(tabs, ["https://done.example"]);
  assert.deepEqual(out.map((c) => c.site), ["https://etk.srail.kr", "https://a.example"]);
  assert.equal(out[0].title, "SRT");
  assert.equal(out[1].title.length, 60);
});

test("설정 묶음 해시: 다섯 값만, 모르면 모델·연결", () => {
  assert.equal(settingsSectionOf("#sites"), "sites");
  assert.equal(settingsSectionOf("advanced"), "advanced");
  for (const bad of ["", "#", "#Sites", "#x", undefined, "#model?x"]) assert.equal(settingsSectionOf(bad), "model");
});
