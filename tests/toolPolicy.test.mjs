import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOL_POLICY, needsApprovalWhenProtected } from "../src/lib/toolPolicy.ts";

// 도구 선언(declarations.ts)의 이름 집합과 정책 표의 키 집합이 같아야 한다(미분류 도구 없음).
test("every declared tool is classified", () => {
  const src = readFileSync(new URL("../src/background/tools/declarations.ts", import.meta.url), "utf8");
  const declared = new Set([...src.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...declared].sort(), Object.keys(TOOL_POLICY).sort());
});

test("only page-reading tools that never change the page are allowed without approval when protected", () => {
  const observe = Object.entries(TOOL_POLICY).filter(([, p]) => p.observeOnly).map(([n]) => n).sort();
  assert.deepEqual(observe, ["describe_page", "get_page_content", "list_file_links", "list_page_images", "query_dom"]);
  for (const name of ["find_clickables", "find_form_fields", "get_youtube_transcript", "translate_page", "navigate_to_url",
    "click_element", "fill_form_fields", "download_images", "read_document", "google_drive_search", "google_sheets_append_rows"]) {
    assert.equal(needsApprovalWhenProtected(name), true, name);
  }
});

test("external-content tools: file reading and every Google tool", () => {
  const external = Object.entries(TOOL_POLICY).filter(([, p]) => p.bringsExternal).map(([n]) => n).sort();
  const google = Object.keys(TOOL_POLICY).filter((n) => n.startsWith("google_"));
  assert.deepEqual(external, ["read_document", "read_linked_pages", "read_other_tabs", ...google].sort());
  for (const [name, p] of Object.entries(TOOL_POLICY)) assert.ok(!(p.bringsExternal && p.observeOnly), name);
});
