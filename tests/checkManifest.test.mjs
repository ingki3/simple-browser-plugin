// 빌드 산출물 검사(#215): web_accessible_resources 없음, content script는 다른 조각을 불러오지 않는 한 파일.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function check(manifest, content) {
  const dir = mkdtempSync(join(tmpdir(), "sbp-check-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "1.0.0", permissions: [], content_scripts: [{ js: ["content.js"], matches: ["<all_urls>"] }], ...manifest }));
  if (content !== null) writeFileSync(join(dir, "content.js"), content);
  return spawnSync(process.execPath, ["scripts/checkManifest.mjs", dir], { encoding: "utf8" });
}

test("한 파일 IIFE content script는 통과", () => {
  const r = check({}, '!function(){"use strict";chrome.runtime.onMessage.addListener(()=>{})}();');
  assert.equal(r.status, 0, r.stderr);
});

test("crxjs loader처럼 IIFE 안에서 import(...)로 본체를 불러오면 실패", () => {
  const r = check({}, '(function(){(async()=>{await import(chrome.runtime.getURL("assets/index.ts-x.js"))})()})();');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /한 파일이 아님/);
});

test("모듈 문(import/export)이 있으면 실패, 파일이 없으면 실패", () => {
  assert.notEqual(check({}, 'import x from "./a.js";\nx();').status, 0);
  assert.match(check({}, null).stderr, /content script 파일이 없습니다/);
});

test("web_accessible_resources가 남아 있으면 실패", () => {
  const r = check({ web_accessible_resources: [{ matches: ["<all_urls>"], resources: ["content.js"] }] }, "!function(){}();");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /web_accessible_resources가 있습니다/);
});
