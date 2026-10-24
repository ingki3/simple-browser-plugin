import test from "node:test";
import assert from "node:assert/strict";

import { handoffResultText, isManualSite, manualSiteOf, MAX_MANUAL_SITES, normalizeManualSites } from "../src/lib/manualSites.ts";

test("manualSiteOf: http(s) 주소의 출처만", () => {
  assert.equal(manualSiteOf("https://etk.srail.kr/hpg/hra/01/selectScheduleList.do?pageId=1"), "https://etk.srail.kr");
  assert.equal(manualSiteOf("http://localhost:8080/a"), "http://localhost:8080");
  assert.equal(manualSiteOf("chrome://settings"), null);
  assert.equal(manualSiteOf("javascript:alert(1)"), null);
  assert.equal(manualSiteOf("not a url"), null);
  assert.equal(manualSiteOf(undefined), null);
});

test("normalizeManualSites: 출처 형태의 문자열만, 중복 없이, 최대 개수까지", () => {
  assert.deepEqual(normalizeManualSites(undefined), []);
  assert.deepEqual(normalizeManualSites("https://a.com"), []);
  assert.deepEqual(
    normalizeManualSites(["https://a.com", "https://a.com", "https://b.com/path", 3, "ftp://c.com", "https://C.com"]),
    ["https://a.com"],
  );
  const many = Array.from({ length: MAX_MANUAL_SITES + 5 }, (_, i) => `https://s${i}.com`);
  assert.equal(normalizeManualSites(many).length, MAX_MANUAL_SITES);
});

test("isManualSite: 같은 출처일 때만(하위 도메인·다른 포트·다른 scheme은 다름)", () => {
  const sites = ["https://etk.srail.kr"];
  assert.equal(isManualSite(sites, "https://etk.srail.kr/main.do"), true);
  assert.equal(isManualSite(sites, "https://www.srail.kr/"), false);
  assert.equal(isManualSite(sites, "http://etk.srail.kr/"), false);
  assert.equal(isManualSite(sites, undefined), false);
});

test("handoffResultText: 도구와 결과에 맞는 안내", () => {
  assert.match(handoffResultText("click_element", "clicked"), /직접 눌렀습니다/);
  assert.match(handoffResultText("fill_form_fields", "confirmed"), /직접 입력을 마쳤다고 알렸습니다/);
  assert.match(handoffResultText("click_element", "page_changed"), /페이지가 바뀌었습니다/);
});
