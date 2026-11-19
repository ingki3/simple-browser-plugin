import { test } from "node:test";
import assert from "node:assert/strict";
import { googleManifestParts, GOOGLE_SCOPES, optionalPermissions } from "../src/lib/manifestGoogle.ts";

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

// #310: 카카오 로그인(launchWebAuthFlow)용 identity는 기본 빌드에서 선택 권한, Google 빌드에서는 필수 그대로(선택에 중복 없음).
test("선택 권한: 기본 빌드는 identity를 더하고, Google 빌드는 필수 identity·oauth2 그대로에 선택에는 넣지 않는다", () => {
  const base = ["nativeMessaging", "history"];
  assert.deepEqual(optionalPermissions(base, googleManifestParts("")), ["nativeMessaging", "history", "identity"]);
  const g = googleManifestParts("abc.apps.googleusercontent.com");
  assert.deepEqual(optionalPermissions(base, g), ["nativeMessaging", "history"]);
  assert.deepEqual(g.permissions, ["identity"]);
  assert.ok(g.oauth2?.client_id);
  assert.deepEqual(base, ["nativeMessaging", "history"], "입력 배열은 그대로");
});
