// 설정 페이지 발신자 판정(src/lib/optionsSender.ts, #319 공용 인증 층). 순수 함수라 바로 불러온다.
import test from "node:test";
import assert from "node:assert/strict";
import { isOptionsPageSender } from "../src/lib/optionsSender.ts";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const OPTIONS = `chrome-extension://${ID}/src/options/index.html`;
const from = (sender, optionsUrl = OPTIONS) => isOptionsPageSender(sender, ID, optionsUrl);

test("N1 설정 페이지에서 보낸 것만 허용: 정확히 같은 주소와 해시만 다른 주소", () => {
  assert.equal(from({ id: ID, url: OPTIONS }), true);
  assert.equal(from({ id: ID, url: `${OPTIONS}#model` }), true);
  assert.equal(from({ id: ID, url: `${OPTIONS}#telegram` }), true);
  assert.equal(from({ id: ID, url: `${OPTIONS}#` }), true);
});

test("N1 거절: 다른 확장, 주소 없음, 패널, 웹 주소, 경로만 같은 웹 문서, 쿼리가 붙은 설정 페이지", () => {
  assert.equal(from({ id: "ponmlkjihgfedcbaponmlkjihgfedcba", url: OPTIONS }), false, "다른 확장 ID");
  assert.equal(from({ url: OPTIONS }), false, "확장 ID 없음");
  assert.equal(from({ id: ID }), false, "주소 없음");
  assert.equal(from({ id: ID, url: undefined }), false);
  assert.equal(from({ id: ID, url: `chrome-extension://${ID}/src/sidepanel/index.html` }), false, "사이드 패널");
  assert.equal(from({ id: ID, url: "https://example.com/" }), false, "웹 주소(content script)");
  assert.equal(from({ id: ID, url: "https://example.com/src/options/index.html#model" }), false, "경로만 같은 웹 문서");
  assert.equal(from({ id: ID, url: `${OPTIONS}?from=x` }), false, "쿼리가 붙음");
  assert.equal(from({ id: ID, url: `${OPTIONS}?from=x#model` }), false, "쿼리와 해시");
  assert.equal(from({ id: ID, url: `${OPTIONS}/` }), false, "뒤에 경로가 더 붙음");
  assert.equal(from({ id: ID, url: `${OPTIONS}x` }), false, "접두사만 같음");
  assert.equal(from({ id: ID, url: `chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/src/options/index.html` }), false, "다른 확장의 같은 경로");
});

test("N1 설정 페이지 주소를 모르면(manifest에 options_page 없음) 늘 거절", () => {
  assert.equal(isOptionsPageSender({ id: ID, url: OPTIONS }, ID, undefined), false);
  assert.equal(isOptionsPageSender({ id: ID, url: "" }, ID, ""), false, "빈 주소끼리 같아도 거절");
  assert.equal(isOptionsPageSender({ id: ID, url: "#model" }, ID, ""), false);
});
