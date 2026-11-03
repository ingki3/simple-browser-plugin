import { test } from "node:test";
import assert from "node:assert/strict";
import { googleManifestParts, GOOGLE_SCOPES } from "../src/lib/manifestGoogle.ts";

test("클라이언트 ID가 없으면 identity·oauth2를 함께 뺀다", () => {
  assert.deepEqual(googleManifestParts(""), { permissions: [] });
  assert.deepEqual(googleManifestParts("   "), { permissions: [] });
});

test("클라이언트 ID가 있으면 identity와 oauth2를 함께 넣는다", () => {
  const parts = googleManifestParts(" abc.apps.googleusercontent.com ");
  assert.deepEqual(parts.permissions, ["identity"]);
  assert.deepEqual(parts.oauth2, { client_id: "abc.apps.googleusercontent.com", scopes: GOOGLE_SCOPES });
  assert.notEqual(parts.oauth2.scopes, GOOGLE_SCOPES, "범위 배열은 복사본");
});
