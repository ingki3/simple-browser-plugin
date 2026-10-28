// 오류를 사용자 말과 다음 행동으로 바꾸기(#130): 원인은 상태 코드·오류 종류로만 정하고, 원문은 detail에 남긴다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyError, MissingKeyError } from "../src/lib/friendlyError.ts";

function httpError(status, message = "provider says no") {
  const err = new Error(message);
  err.name = "ProviderHttpError";
  err.status = status;
  return err;
}

test("키 없음은 설정 열기", () => {
  const f = friendlyError(new MissingKeyError("OpenRouter API 키가 설정되지 않았습니다."));
  assert.equal(f.action, "settings");
});

test("상태 코드별 원인과 다음 행동, 원문은 detail", () => {
  assert.equal(friendlyError(httpError(401)).action, "settings");
  assert.equal(friendlyError(httpError(403)).action, "settings");
  assert.equal(friendlyError(httpError(402)).action, "usage");
  assert.equal(friendlyError(httpError(429)).action, "usage");
  assert.equal(friendlyError(httpError(404)).action, "settings");
  assert.equal(friendlyError(httpError(400)).action, "settings");
  const server = friendlyError(httpError(503, "overloaded"));
  assert.equal(server.action, undefined);
  assert.equal(server.detail, "overloaded");
  assert.match(server.message, /잠시 뒤/);
});

test("모르는 상태 코드와 일반 오류는 원문 그대로", () => {
  assert.deepEqual(friendlyError(httpError(418, "teapot")), { message: "teapot" });
  assert.deepEqual(friendlyError(new Error("도구 실패")), { message: "도구 실패" });
});

test("문구가 같아도 상태 코드가 없으면 바꾸지 않는다", () => {
  assert.deepEqual(friendlyError(new Error("401 Unauthorized")), { message: "401 Unauthorized" });
});

test("fetch 연결 실패(TypeError)는 연결 안내", () => {
  const f = friendlyError(new TypeError("Failed to fetch"));
  assert.match(f.message, /연결하지 못했습니다/);
  assert.equal(f.detail, "Failed to fetch");
});
