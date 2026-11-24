// Google 인증(background/google/auth.ts)의 지금 동작을 고정하는 특성 시험(#319 PR ①). 제품 코드는 고치지 않는다.
// chrome.identity·chrome.storage·fetch는 모두 대역이고 토큰은 가짜 값이다(실제 Google로 요청하지 않는다).
// 모듈은 부를 때마다 globalThis.chrome을 읽으므로 시험마다 대역을 새로 건다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const FAKE_TOKEN = "fake-google-token-aaaa";
const FAKE_CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const VERSION_KEY = "googleAuthVersion";

// 대역을 걸고 호출 기록을 돌려준다.
// - clientId: manifest oauth2.client_id(빈 값이면 미설정 빌드)
// - identity: false면 chrome.identity가 없다(권한 없는 기본 빌드)
// - tokenReply(interactive): getAuthToken 콜백에 넘길 값. { lastError } 를 주면 chrome.runtime.lastError로 실패시킨다.
// - fetchReply(url, init): fetch 응답(Response) 또는 throw.
// - holdRemove: true면 removeCachedAuthToken 콜백을 calls.finishRemove()까지 부르지 않는다(삭제가 끝나기 전의 순서를 본다).
function install({ clientId = FAKE_CLIENT_ID, identity = true, tokenReply = () => FAKE_TOKEN, fetchReply = () => new Response("{}", { status: 200 }), holdRemove = false } = {}) {
  // order: 캐시 삭제·fetch·알림 저장이 일어난 순서(한 배열에 적는다).
  const calls = { getAuthToken: [], removeCached: [], storageSet: [], fetch: [], order: [] };
  const runtime = {
    lastError: undefined,
    getManifest: () => (clientId ? { oauth2: { client_id: clientId, scopes: [] } } : {}),
  };
  const chromeStub = {
    runtime,
    storage: {
      local: {
        set: async (obj) => {
          calls.storageSet.push(Object.keys(obj));
          calls.order.push("storageSet");
        },
      },
    },
  };
  if (identity) {
    chromeStub.identity = {
      getAuthToken: ({ interactive }, cb) => {
        calls.getAuthToken.push(interactive);
        const r = tokenReply(interactive, calls.getAuthToken.length);
        if (r && typeof r === "object" && "lastError" in r) {
          runtime.lastError = { message: r.lastError };
          cb(undefined);
          runtime.lastError = undefined;
          return;
        }
        cb(r);
      },
      removeCachedAuthToken: ({ token }, cb) => {
        calls.removeCached.push(token);
        calls.order.push("removeCached");
        if (holdRemove) calls.finishRemove = cb;
        else cb();
      },
    };
  }
  globalThis.chrome = chromeStub;
  globalThis.fetch = async (url, init) => {
    calls.fetch.push({ url: String(url), init });
    calls.order.push("fetch");
    return fetchReply(String(url), init);
  };
  return calls;
}

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
});

const auth = await import("../src/background/google/auth.ts");
// bumpAuthVersion은 void로 저장을 부른다 — 마이크로태스크 한 바퀴 뒤에 기록을 본다.
const tick = () => new Promise((r) => setImmediate(r));

test("U1 getAuthToken 응답: 문자열·{token} 객체는 토큰으로 읽고, lastError·빈 값이면 거부한다", async () => {
  install({ tokenReply: () => FAKE_TOKEN });
  assert.equal(await auth.getGoogleToken(), FAKE_TOKEN);
  install({ tokenReply: () => ({ token: FAKE_TOKEN }) });
  assert.equal(await auth.getGoogleToken(), FAKE_TOKEN);
  install({ tokenReply: () => ({ lastError: "OAuth2 not granted or revoked." }) });
  await assert.rejects(auth.getGoogleToken(), /OAuth2 not granted or revoked\./);
  for (const empty of [undefined, "", {}]) {
    install({ tokenReply: () => empty });
    await assert.rejects(auth.getGoogleToken(), /액세스 토큰이 비어 있습니다\./);
  }
});

test("U2 connectGoogle: interactive 한 번, getAuthToken을 부른 뒤에는 성공·실패 모두 알림 저장 1회, 사전 조건 실패는 호출·저장 0회", async () => {
  let c = install();
  assert.deepEqual(await auth.connectGoogle(), { ok: true });
  await tick();
  assert.deepEqual(c.getAuthToken, [true]);
  assert.deepEqual(c.storageSet, [[VERSION_KEY]]);

  c = install({ tokenReply: () => ({ lastError: "The user did not approve access." }) });
  await assert.rejects(auth.connectGoogle(), /The user did not approve access\./);
  await tick();
  assert.deepEqual(c.getAuthToken, [true]);
  assert.deepEqual(c.storageSet, [[VERSION_KEY]], "실패해도 알림 1회");

  // 클라이언트 ID 없음: try에 들어가기 전에 던진다.
  c = install({ clientId: "" });
  await assert.rejects(auth.connectGoogle(), /직접 빌드한 확장에서만 쓸 수 있습니다/);
  await tick();
  assert.deepEqual(c.getAuthToken, []);
  assert.deepEqual(c.storageSet, []);

  // identity 없음.
  c = install({ identity: false });
  await assert.rejects(auth.connectGoogle(), /chrome\.identity API가 없습니다/);
  await tick();
  assert.deepEqual(c.storageSet, []);
});

test("U3 getGoogleToken: interactive false, 실패 문구에 다시 연결 안내와 원인이 있다", async () => {
  const c = install({ tokenReply: () => ({ lastError: "OAuth2 not granted or revoked." }) });
  await assert.rejects(auth.getGoogleToken(), (err) => {
    assert.match(err.message, /설정에서 'Google 연결' 버튼을 눌러 재인증해 주세요\./);
    assert.match(err.message, /\(원인: OAuth2 not granted or revoked\.\)/);
    return true;
  });
  assert.deepEqual(c.getAuthToken, [false]);
  assert.deepEqual(c.storageSet, [], "조용한 조회는 알림을 쓰지 않는다");
});

test("U4 clearGoogleToken: 캐시 삭제 → 폐기 요청 → 알림, 토큰이 없으면 삭제·폐기 없이 알림만, identity가 없으면 알림도 없다", async () => {
  let c = install();
  await auth.clearGoogleToken();
  await tick();
  assert.deepEqual(c.getAuthToken, [false]);
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
  assert.equal(c.fetch.length, 1);
  const u = new URL(c.fetch[0].url);
  // 토큰이 주소 쿼리에 있는지는 여기서 단언하지 않는다(#319 ④에서 본문으로 옮긴다).
  assert.equal(`${u.origin}${u.pathname}`, "https://oauth2.googleapis.com/revoke");
  assert.equal(c.fetch[0].init?.method, "POST");
  assert.deepEqual(c.storageSet, [[VERSION_KEY]]);
  // 순서: 캐시 삭제 → 원격 폐기 → 알림(알림이 먼저 나가면 다른 설정 화면이 아직 남은 캐시를 읽는다).
  assert.deepEqual(c.order, ["removeCached", "fetch", "storageSet"]);

  // 캐시 삭제가 끝나기 전에는 폐기 요청도 알림도 나가지 않는다(삭제를 기다리지 않는 회귀를 잡는다).
  c = install({ holdRemove: true });
  const clearing = auth.clearGoogleToken();
  await tick();
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
  assert.equal(c.fetch.length, 0, "삭제가 끝나기 전 폐기 요청 0회");
  assert.deepEqual(c.storageSet, [], "삭제가 끝나기 전 알림 0회");
  c.finishRemove();
  await clearing;
  await tick();
  assert.deepEqual(c.order, ["removeCached", "fetch", "storageSet"]);

  // 토큰이 없으면(조용한 조회 실패) 삭제·폐기 0회, 알림 1회.
  c = install({ tokenReply: () => ({ lastError: "OAuth2 not granted or revoked." }) });
  await auth.clearGoogleToken();
  await tick();
  assert.deepEqual(c.removeCached, []);
  assert.equal(c.fetch.length, 0);
  assert.deepEqual(c.storageSet, [[VERSION_KEY]]);

  // identity가 없으면 아무것도 하지 않는다.
  c = install({ identity: false });
  await auth.clearGoogleToken();
  await tick();
  assert.equal(c.fetch.length, 0);
  assert.deepEqual(c.storageSet, []);

  // 폐기 요청이 실패(연결 실패)해도 삼키고 끝난다.
  c = install({
    fetchReply: () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await auth.clearGoogleToken();
  await tick();
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
  assert.equal(c.fetch.length, 1);
  assert.deepEqual(c.storageSet, [[VERSION_KEY]]);
  assert.deepEqual(c.order, ["removeCached", "fetch", "storageSet"]);
});

test("U5 getGoogleConnectionState·isGoogleConfigured: 미설정이면 getAuthToken을 부르지 않고, 설정됐고 조용한 토큰이 성공하면 connected", async () => {
  let c = install({ clientId: "" });
  assert.equal(auth.isGoogleConfigured(), false);
  assert.deepEqual(await auth.getGoogleConnectionState(), { configured: false, connected: false, clientId: "" });
  assert.deepEqual(c.getAuthToken, []);

  // 클라이언트 ID가 있어도 identity가 없으면 미설정.
  c = install({ identity: false });
  assert.equal(auth.isGoogleConfigured(), false);
  assert.deepEqual(await auth.getGoogleConnectionState(), { configured: false, connected: false, clientId: FAKE_CLIENT_ID });

  c = install();
  assert.equal(auth.isGoogleConfigured(), true);
  assert.deepEqual(await auth.getGoogleConnectionState(), { configured: true, connected: true, clientId: FAKE_CLIENT_ID });
  assert.deepEqual(c.getAuthToken, [false]);

  c = install({ tokenReply: () => ({ lastError: "OAuth2 not granted or revoked." }) });
  assert.deepEqual(await auth.getGoogleConnectionState(), { configured: true, connected: false, clientId: FAKE_CLIENT_ID });
  assert.deepEqual(c.storageSet, [], "상태 조회는 알림을 쓰지 않는다");
});

test("U6 googleFetch: Bearer 헤더, body가 있을 때만 Content-Type 기본값, 주소 규칙, 성공 응답을 호출자가 읽는다", async () => {
  let c = install({ fetchReply: () => new Response(JSON.stringify({ files: [] }), { status: 200, headers: { "content-type": "application/json", "content-length": "12" } }) });
  const res = await auth.googleFetch("/drive/v3/files?q=x");
  assert.equal(c.fetch[0].url, "https://www.googleapis.com/drive/v3/files?q=x");
  const h = new Headers(c.fetch[0].init.headers);
  assert.equal(h.get("Authorization"), `Bearer ${FAKE_TOKEN}`);
  assert.equal(h.has("Content-Type"), false, "body가 없으면 Content-Type을 넣지 않는다");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "12");
  assert.deepEqual(await res.json(), { files: [] });
  assert.deepEqual(c.getAuthToken, [false]);

  // body가 있으면 JSON 기본값, 메서드·본문은 그대로.
  c = install();
  await auth.googleFetch("/v4/x", { method: "PUT", body: '{"values":[]}' });
  assert.equal(new Headers(c.fetch[0].init.headers).get("Content-Type"), "application/json");
  assert.equal(c.fetch[0].init.method, "PUT");
  assert.equal(c.fetch[0].init.body, '{"values":[]}');

  // 이미 준 Content-Type은 유지.
  c = install();
  await auth.googleFetch("/v4/x", { method: "POST", body: "a,b", headers: { "Content-Type": "text/csv" } });
  assert.equal(new Headers(c.fetch[0].init.headers).get("Content-Type"), "text/csv");

  // https:// 주소는 그대로.
  c = install({ fetchReply: () => new Response("본문 글자", { status: 200 }) });
  const r2 = await auth.googleFetch("https://sheets.googleapis.com/v4/spreadsheets/abc");
  assert.equal(c.fetch[0].url, "https://sheets.googleapis.com/v4/spreadsheets/abc");
  assert.equal(await r2.text(), "본문 글자");
});

test("U7 googleFetch 실패: 401은 캐시 삭제 1회·재시도 없이 고정 문구, 그 밖은 상태와 본문 앞 300자 (#319 ④에서 바뀜)", async () => {
  let c = install({ fetchReply: () => new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401, statusText: "Unauthorized" }) });
  await assert.rejects(auth.googleFetch("/v4/x"), (err) => {
    assert.equal(err.message, "Google API 401 Unauthorized. 토큰 캐시를 지웠습니다. 설정에서 'Google 연결'을 다시 눌러 주세요.");
    return true;
  });
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
  assert.equal(c.fetch.length, 1, "재시도 없음");
  assert.deepEqual(c.getAuthToken, [false], "다시 받지 않는다");

  const long = "가".repeat(400);
  c = install({ fetchReply: () => new Response(long, { status: 400, statusText: "Bad Request" }) });
  await assert.rejects(auth.googleFetch("/v4/x"), (err) => {
    assert.equal(err.message, `Google API 400 Bad Request: ${"가".repeat(300)}`);
    return true;
  });
  assert.deepEqual(c.removeCached, []);
  assert.equal(c.fetch.length, 1);

  // 연결 실패는 fetch가 던진 오류가 그대로 나온다.
  c = install({
    fetchReply: () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(auth.googleFetch("/v4/x"), (err) => err instanceof TypeError && err.message === "Failed to fetch");
  assert.equal(c.fetch.length, 1);
});
