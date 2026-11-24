// Google 인증(background/google/auth.ts) 시험. U1~U7은 #319 PR ①의 특성 시험이고, ④에서 U4에 단언을 더하고 U7을 새 동작으로 바꿨으며
// G1~G12(401 재시도·오류 문구·시간 제한·중단·연결 끊기)를 더했다.
// chrome.identity·chrome.storage·fetch는 모두 대역이고 토큰은 가짜 값이다(실제 Google로 요청하지 않는다).
// 모듈은 부를 때마다 globalThis.chrome을 읽으므로 시험마다 대역을 새로 건다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const FAKE_TOKEN = "fake-google-token-aaaa";
const FAKE_TOKEN_2 = "fake-google-token-bbbb";
const FAKE_CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const VERSION_KEY = "googleAuthVersion";

// 대역을 걸고 호출 기록을 돌려준다.
// - clientId: manifest oauth2.client_id(빈 값이면 미설정 빌드)
// - identity: false면 chrome.identity가 없다(권한 없는 기본 빌드)
// - tokenReply(interactive): getAuthToken 콜백에 넘길 값. { lastError } 를 주면 chrome.runtime.lastError로 실패시킨다.
// - fetchReply(url, init): fetch 응답(Response) 또는 throw.
// - holdRemove: true면 removeCachedAuthToken 콜백을 calls.finishRemove()까지 부르지 않는다(삭제가 끝나기 전의 순서를 본다).
// - signInEvent: false면 identity.onSignInChanged가 없다(로그인 상태 변화를 볼 수 없는 환경). calls.signInChanged()로 변화를 알린다.
function install({ clientId = FAKE_CLIENT_ID, identity = true, tokenReply = () => FAKE_TOKEN, fetchReply = () => new Response("{}", { status: 200 }), holdRemove = false, signInEvent = true } = {}) {
  // order: 캐시 삭제·fetch·알림 저장이 일어난 순서(한 배열에 적는다).
  // storageValuesOk: 저장한 값이 모두 유한한 숫자(바뀐 시각)였는지 — 값 자체는 기록하지 않는다(토큰이 값으로 저장되는 회귀를 잡는다).
  const calls = { getAuthToken: [], removeCached: [], storageSet: [], storageValuesOk: true, fetch: [], order: [] };
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
          if (!Object.values(obj).every((v) => typeof v === "number" && Number.isFinite(v))) calls.storageValuesOk = false;
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
    if (signInEvent) {
      const listeners = [];
      chromeStub.identity.onSignInChanged = { addListener: (fn) => listeners.push(fn) };
      calls.signInListeners = listeners;
      calls.signInChanged = () => {
        for (const fn of listeners) fn({ id: "fake-account" }, true);
      };
    }
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
  assert.equal(c.storageValuesOk, true, "알림 값은 숫자(시각)뿐 — 토큰을 저장하지 않는다");

  c = install({ tokenReply: () => ({ lastError: "The user did not approve access." }) });
  await assert.rejects(auth.connectGoogle(), /The user did not approve access\./);
  await tick();
  assert.deepEqual(c.getAuthToken, [true]);
  assert.deepEqual(c.storageSet, [[VERSION_KEY]], "실패해도 알림 1회");
  assert.equal(c.storageValuesOk, true);

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
  assert.equal(`${u.origin}${u.pathname}`, "https://oauth2.googleapis.com/revoke");
  assert.equal(c.fetch[0].init?.method, "POST");
  // #319 ④: 토큰은 주소(쿼리)가 아니라 form 본문에 싣는다. 본문의 토큰은 캐시에서 지운 그 토큰이다(값은 실패 문구에 넣지 않고 일치 여부만 본다).
  assert.equal(u.search, "", "폐기 주소에 쿼리가 없다");
  assert.equal(c.fetch[0].url.includes(FAKE_TOKEN), false, "폐기 주소에 토큰이 없다");
  assert.equal(new Headers(c.fetch[0].init.headers).get("content-type"), "application/x-www-form-urlencoded");
  const form = new URLSearchParams(String(c.fetch[0].init.body));
  assert.deepEqual([...form.keys()], ["token"], "본문 필드는 token 하나");
  assert.ok(form.get("token") === c.removeCached[0] && form.get("token") === FAKE_TOKEN, "폐기 본문의 토큰이 캐시에서 지운 토큰과 같다");
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

  assert.equal(c.storageValuesOk, true, "알림 값은 숫자(시각)뿐");

  // 폐기 응답이 오기 전에는 알림이 나가지 않고 해제도 끝나지 않는다(폐기 요청을 기다리지 않는 회귀를 잡는다).
  let finishRevoke;
  c = install({ fetchReply: () => new Promise((r) => (finishRevoke = () => r(new Response("{}", { status: 200 })))) });
  let cleared = false;
  const revoking = auth.clearGoogleToken().then(() => {
    cleared = true;
  });
  await tick();
  assert.equal(c.fetch.length, 1);
  assert.deepEqual(c.storageSet, [], "폐기 응답 전 알림 0회");
  assert.equal(cleared, false, "폐기 응답 전에는 해제가 끝나지 않는다");
  finishRevoke();
  await revoking;
  await tick();
  assert.deepEqual(c.storageSet, [[VERSION_KEY]]);

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

test("U7 googleFetch 실패: 401은 캐시를 지우고 조용히 다시 받아 한 번 다시 보내고, 그 밖의 실패는 상태 번호와 고정 안내만", async () => {
  // 401 → 캐시 삭제 1회 → getAuthToken(false) 다시 → 새 토큰으로 두 번째 요청 → 성공 응답.
  let c = install({
    tokenReply: (_interactive, n) => (n === 1 ? FAKE_TOKEN : FAKE_TOKEN_2),
    fetchReply: (_url, init) =>
      new Headers(init.headers).get("Authorization") === `Bearer ${FAKE_TOKEN}`
        ? new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401, statusText: "Unauthorized" })
        : new Response('{"ok":1}', { status: 200 }),
  });
  const res = await auth.googleFetch("/v4/x");
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
  assert.deepEqual(c.getAuthToken, [false, false], "다시 받을 때도 로그인 창 없이");
  assert.equal(c.fetch.length, 2);
  assert.equal(new Headers(c.fetch[1].init.headers).get("Authorization"), `Bearer ${FAKE_TOKEN_2}`);
  assert.deepEqual(c.order, ["fetch", "removeCached", "fetch"]);

  // 401이 아닌 실패 응답: 상태 번호와 상태별 고정 안내뿐(본문·statusText 없음), 재시도 없음.
  const hints = {
    400: "Google API 오류 400. 요청 값(ID·범위)을 확인하세요.",
    403: "Google API 오류 403. Google이 요청을 거부했습니다. 접근 권한이나 사용 한도를 확인하세요.",
    404: "Google API 오류 404. 파일이나 시트를 찾지 못했습니다.",
    429: "Google API 오류 429. 요청이 많습니다. 잠시 뒤 다시 시도하세요.",
    500: "Google API 오류 500.",
  };
  for (const [status, message] of Object.entries(hints)) {
    c = install({ fetchReply: () => new Response("가".repeat(400), { status: Number(status), statusText: "Some Status Text" }) });
    await assert.rejects(auth.googleFetch("/v4/x"), (err) => {
      assert.equal(err.message, message);
      return true;
    });
    assert.deepEqual(c.removeCached, []);
    assert.equal(c.fetch.length, 1);
    assert.deepEqual(c.getAuthToken, [false]);
  }
});

// #319 ①의 리뷰에서 넘어온 보강: U5는 성공 분기 뒤에 대역을 바꿔 알림 저장 0회를 실패 분기에서만 본다.
test("U5b getGoogleConnectionState: 조용한 토큰이 성공한 분기에서도 알림을 저장하지 않는다", async () => {
  const c = install();
  assert.deepEqual(await auth.getGoogleConnectionState(), { configured: true, connected: true, clientId: FAKE_CLIENT_ID });
  await tick();
  assert.deepEqual(c.getAuthToken, [false]);
  assert.deepEqual(c.storageSet, [], "성공한 상태 조회는 알림을 쓰지 않는다(쓰면 설정 화면이 다시 조회한다)");
  assert.deepEqual(c.removeCached, []);
  assert.equal(c.fetch.length, 0);
});

// ---- #319 ④: 401 재시도·오류 문구·시간 제한·중단·연결 끊기 ----

const REAUTH = "Google 인증이 만료됐습니다. 설정에서 'Google 연결'을 다시 눌러 주세요.";
const NO_RESPONSE = "Google 응답을 받지 못했습니다. 쓰기 요청이었다면 반영됐는지 확인한 뒤 다시 시도하세요.";
const UNREADABLE = "Google 응답을 읽지 못했습니다. 쓰기 요청이었다면 반영됐는지 확인한 뒤 다시 시도하세요.";
const CHANGED = "Google 연결이 바뀌어 멈췄습니다. 다시 시도하세요.";
const ABORTED = "중단되어 다시 보내지 않았습니다.";
const unauthorized = () => new Response('{"error":{"status":"UNAUTHENTICATED"}}', { status: 401, statusText: "Unauthorized" });
const bearer = (call) => new Headers(call.init.headers).get("Authorization");
const apiCalls = (c) => c.fetch.filter((f) => !f.url.startsWith("https://oauth2.googleapis.com/"));
const rejectsWith = (p, message) =>
  assert.rejects(p, (err) => {
    assert.equal(err.message, message);
    return true;
  });
// 풀 때까지 기다리는 값. hold.promise를 기다리게 하고 hold.open(v)로 푼다.
function gate() {
  let open;
  const promise = new Promise((r) => (open = r));
  return { promise, open };
}
// 헤더가 오지 않는 요청 / 헤더 뒤 본문이 멈춘 응답. 실제 fetch처럼 요청 신호와 이어져 있다(abort되면 끝난다).
const neverResponds = (init) =>
  new Promise((_, reject) => {
    const fail = () => reject(new DOMException("aborted", "AbortError"));
    if (init.signal.aborted) fail();
    else init.signal.addEventListener("abort", fail, { once: true });
  });
function stalledBody(init, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      const fail = () => controller.error(new DOMException("aborted", "AbortError"));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener("abort", fail, { once: true });
    },
  });
  return new Response(stream, { status });
}
test.afterEach(() => auth.setGoogleFetchLimitForTest());

test("G1 두 번째도 401이면 거기서 멈춘다: 요청 2회, 두 토큰 모두 캐시에서 지우고 다시 연결 안내", async () => {
  const c = install({ tokenReply: (_i, n) => (n === 1 ? FAKE_TOKEN : FAKE_TOKEN_2), fetchReply: unauthorized });
  await rejectsWith(auth.googleFetch("/v4/x"), REAUTH);
  assert.equal(c.fetch.length, 2);
  assert.deepEqual(c.removeCached, [FAKE_TOKEN, FAKE_TOKEN_2]);
  assert.deepEqual(c.getAuthToken, [false, false]);
});

test("G2 401 뒤 조용한 재발급이 실패하면 다시 보내지 않는다: 요청 1회, 로그인 창 0회", async () => {
  const c = install({ tokenReply: (_i, n) => (n === 1 ? FAKE_TOKEN : { lastError: "OAuth2 not granted or revoked." }), fetchReply: unauthorized });
  await assert.rejects(auth.googleFetch("/v4/x"), (err) => {
    assert.equal(err.message, REAUTH);
    assert.equal(err.message.includes("OAuth2 not granted"), false, "재발급 실패의 원인 글은 넣지 않는다");
    return true;
  });
  assert.equal(c.fetch.length, 1);
  assert.deepEqual(c.getAuthToken, [false, false]);
  assert.equal(c.getAuthToken.includes(true), false);
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
});

test("G3 401 뒤 같은 토큰 문자열이 다시 와도 한 번은 다시 보낸다: 요청은 정확히 2회", async () => {
  let n = 0;
  const c = install({ fetchReply: () => (++n === 1 ? unauthorized() : new Response("{}", { status: 200 })) });
  const res = await auth.googleFetch("/v4/x");
  assert.equal(res.status, 200);
  assert.equal(c.fetch.length, 2);
  assert.equal(bearer(c.fetch[0]), bearer(c.fetch[1]));
  // 계속 401이어도 세 번째는 없다.
  const c2 = install({ fetchReply: unauthorized });
  await rejectsWith(auth.googleFetch("/v4/x"), REAUTH);
  assert.equal(c2.fetch.length, 2);
});

test("G4 401이 아닌 실패는 다시 보내지 않는다: 500·429·연결 실패 모두 요청 1회", async () => {
  for (const status of [500, 429, 403]) {
    const c = install({ fetchReply: () => new Response("x", { status }) });
    await assert.rejects(auth.googleFetch("/v4/x", { method: "POST", body: "{}" }));
    assert.equal(c.fetch.length, 1, `${status}: 재시도 없음`);
    assert.deepEqual(c.getAuthToken, [false]);
  }
  const c = install({
    fetchReply: () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(auth.googleFetch("/v4/x", { method: "POST", body: "{}" }));
  assert.equal(c.fetch.length, 1, "연결 실패: 재시도 없음");
});

test("G5 401 재시도는 본문 없는 조회와 문자열 본문 쓰기 모두 같은 메서드·주소·본문으로 다시 보낸다", async () => {
  for (const init of [undefined, { method: "PUT", body: '{"values":[["a"]]}' }, { method: "POST", body: '{"values":[["b"]]}', headers: { "Content-Type": "application/json" } }]) {
    let n = 0;
    const c = install({ tokenReply: (_i, k) => (k === 1 ? FAKE_TOKEN : FAKE_TOKEN_2), fetchReply: () => (++n === 1 ? unauthorized() : new Response('{"ok":1}', { status: 200 })) });
    const res = await auth.googleFetch("/v4/x", init);
    assert.equal(res.status, 200);
    assert.equal(c.fetch.length, 2);
    assert.equal(c.fetch[1].url, c.fetch[0].url);
    assert.equal(c.fetch[1].init.method, c.fetch[0].init.method);
    assert.equal(c.fetch[1].init.body, c.fetch[0].init.body);
    assert.equal(c.fetch[1].init.body, init?.body);
    assert.equal(new Headers(c.fetch[1].init.headers).get("Content-Type"), new Headers(c.fetch[0].init.headers).get("Content-Type"));
    assert.equal(bearer(c.fetch[1]), `Bearer ${FAKE_TOKEN_2}`);
  }
  // 다시 쓸 수 없는 본문(스트림 등)은 다시 보내지 않는다.
  const c = install({ fetchReply: unauthorized });
  await rejectsWith(auth.googleFetch("/v4/x", { method: "POST", body: new Blob(["x"]) }), REAUTH);
  assert.equal(c.fetch.length, 1);
  assert.deepEqual(c.getAuthToken, [false], "재발급도 하지 않는다");
});

test("G6 오류에 응답 원문을 넣지 않는다: 실패 응답의 본문·statusText, 깨진 JSON의 본문 모두 없다", async () => {
  const MARK = "LEAK_MARK_VALUE";
  const body = JSON.stringify({ error: { code: 400, status: MARK, message: `Unable to parse range: ${MARK}` } });
  for (const status of [400, 403, 404, 429, 500, 503]) {
    install({ fetchReply: () => new Response(body, { status, statusText: MARK }) });
    await assert.rejects(auth.googleFetch("/v4/x"), (err) => {
      assert.equal(err.message.includes(MARK), false, `${status}: 본문·statusText의 글자가 없다`);
      assert.equal(err.message.includes("Unable to parse"), false);
      assert.match(err.message, new RegExp(`^Google API 오류 ${status}\\.`));
      return true;
    });
  }
  // 401(재시도 뒤에도)도 고정 문구뿐이다.
  install({ fetchReply: () => new Response(body, { status: 401, statusText: MARK }) });
  await rejectsWith(auth.googleFetch("/v4/x"), REAUTH);

  // 성공 응답인데 JSON이 아니면 고정 문구(파싱 오류의 글에는 본문 앞부분이 들어갈 수 있다).
  for (const broken of [`${MARK} not json`, `{"a": ${MARK}`, ""]) {
    const c = install({ fetchReply: () => new Response(broken, { status: 200 }) });
    await assert.rejects(auth.googleJson("/v4/x"), (err) => {
      assert.equal(err.message, UNREADABLE);
      return true;
    });
    assert.equal(c.fetch.length, 1);
  }
  // 정상 JSON은 그대로 읽는다.
  install({ fetchReply: () => new Response('{"files":[1]}', { status: 200 }) });
  assert.deepEqual(await auth.googleJson("/v4/x"), { files: [1] });
});

test("G7 시간 제한: 헤더가 오지 않거나 200 헤더 뒤 본문이 멈추면 고정 문구로 실패하고 요청 신호가 abort된다", async () => {
  auth.setGoogleFetchLimitForTest(30);
  let c = install({ fetchReply: (_url, init) => neverResponds(init) });
  await rejectsWith(auth.googleFetch("/v4/x"), NO_RESPONSE);
  assert.equal(c.fetch.length, 1);
  assert.equal(c.fetch[0].init.signal.aborted, true);

  c = install({ fetchReply: (_url, init) => stalledBody(init) });
  await rejectsWith(auth.googleFetch("/v4/x"), NO_RESPONSE);
  assert.equal(c.fetch.length, 1);
  assert.equal(c.fetch[0].init.signal.aborted, true, "본문 읽기도 제한 안에 든다");

  // 제한 안에 끝난 응답은 호출자가 읽을 때 더 기다리지 않는다(본문을 이미 다 받았다).
  auth.setGoogleFetchLimitForTest();
  c = install({ fetchReply: () => new Response("본문", { status: 200, headers: { "content-length": "6" } }) });
  const res = await auth.googleFetch("/v4/x");
  assert.equal(c.fetch[0].init.signal.aborted, false);
  assert.equal(res.headers.get("content-length"), "6");
  assert.equal(new TextDecoder().decode(await res.arrayBuffer()), "본문");
});

test("G8 연결 실패의 오류는 고정 문구다(fetch가 던진 글이 없다)", async () => {
  install({
    fetchReply: () => {
      throw new TypeError("Failed to fetch: net::ERR_NAME_NOT_RESOLVED https://www.googleapis.com/v4/x");
    },
  });
  await rejectsWith(auth.googleFetch("/v4/x"), NO_RESPONSE);
});

test("G9 쓰기에서 시간 초과·본문 정지·깨진 JSON은 다시 보내지 않는다(이미 반영됐을 수 있다)", async () => {
  auth.setGoogleFetchLimitForTest(30);
  for (const init of [{ method: "POST", body: '{"values":[]}' }, { method: "PUT", body: '{"values":[]}' }]) {
    let c = install({ fetchReply: (_url, i) => neverResponds(i) });
    await rejectsWith(auth.googleJson("/v4/x", init), NO_RESPONSE);
    assert.equal(c.fetch.length, 1, `${init.method} 시간 초과: 재전송 0회`);
    c = install({ fetchReply: (_url, i) => stalledBody(i) });
    await rejectsWith(auth.googleJson("/v4/x", init), NO_RESPONSE);
    assert.equal(c.fetch.length, 1, `${init.method} 본문 정지: 재전송 0회`);
    c = install({ fetchReply: () => new Response("not json", { status: 200 }) });
    await rejectsWith(auth.googleJson("/v4/x", init), UNREADABLE);
    assert.equal(c.fetch.length, 1, `${init.method} 깨진 JSON: 재전송 0회`);
    assert.deepEqual(c.getAuthToken, [false]);
  }
});

test("G10 폐기 요청이 시간 초과여도 연결 해제는 끝나고 알림은 한 번", async () => {
  auth.setGoogleFetchLimitForTest(30);
  const c = install({ fetchReply: (_url, init) => neverResponds(init) });
  await auth.clearGoogleToken();
  await tick();
  assert.equal(c.fetch.length, 1);
  assert.equal(c.fetch[0].init.signal.aborted, true);
  assert.deepEqual(c.removeCached, [FAKE_TOKEN]);
  assert.deepEqual(c.storageSet, [[VERSION_KEY]]);
});

test("G11 401 뒤 재발급을 기다리는 사이 중단되면 다시 보내지 않는다(쓰기 1회뿐), 신호가 없거나 중단되지 않았으면 다시 보낸다", async () => {
  const sheets = await import("../src/background/google/sheets.ts");
  // 재발급(getAuthToken 두 번째 호출)을 보류하는 대역: tokenReply 대신 identity를 직접 감싼다.
  const withHeldReissue = () => {
    const c = install({ fetchReply: unauthorized });
    const hold = gate();
    const orig = globalThis.chrome.identity.getAuthToken;
    let n = 0;
    globalThis.chrome.identity.getAuthToken = (o, cb) => {
      if (++n === 1) return orig(o, cb);
      c.getAuthToken.push(o.interactive);
      hold.promise.then(() => cb(FAKE_TOKEN_2));
    };
    return { c, hold };
  };
  const untilReissueAsked = async (c) => {
    for (let i = 0; i < 50 && c.getAuthToken.length < 2; i++) await tick();
    assert.equal(c.getAuthToken.length, 2, "재발급을 요청함");
  };

  // googleFetch 직접: POST 401 → 재발급 보류 → 중단 → 풀어도 두 번째 요청 없음.
  {
    const { c, hold } = withHeldReissue();
    const ac = new AbortController();
    const p = auth.googleFetch("/v4/x", { method: "POST", body: "{}" }, { signal: ac.signal });
    const settled = rejectsWith(p, ABORTED);
    await untilReissueAsked(c);
    ac.abort();
    hold.open();
    await settled;
    assert.equal(c.fetch.length, 1, "쓰기 요청은 최초 1회뿐");
  }
  // 401을 받기 전에 이미 중단됐으면 재발급도 하지 않는다.
  {
    const c = install({ fetchReply: unauthorized });
    const ac = new AbortController();
    ac.abort();
    await rejectsWith(auth.googleFetch("/v4/x", { method: "POST", body: "{}" }, { signal: ac.signal }), ABORTED);
    assert.equal(c.fetch.length, 1);
    assert.deepEqual(c.getAuthToken, [false]);
  }
  // 시트 쓰기 두 함수(범위 쓰기·Markdown 표 쓰기가 타는 writeRange, 행 추가 appendRows)가 신호를 끝까지 넘긴다.
  for (const [what, write] of [
    ["appendRows", (signal) => sheets.appendRows("sheet-id", "A1", [["a"]], signal)],
    ["writeRange", (signal) => sheets.writeRange("sheet-id", "A1:B2", [["a"]], signal)],
  ]) {
    const { c, hold } = withHeldReissue();
    const ac = new AbortController();
    const settled = rejectsWith(write(ac.signal), ABORTED);
    await untilReissueAsked(c);
    ac.abort();
    hold.open();
    await settled;
    assert.equal(c.fetch.length, 1, `${what}: 쓰기 요청은 최초 1회뿐`);
    assert.equal(c.fetch[0].init.method, what === "appendRows" ? "POST" : "PUT");
  }
  // 신호를 주지 않았거나 중단되지 않았으면 다시 보낸다.
  for (const signal of [undefined, new AbortController().signal]) {
    let n = 0;
    const c = install({ fetchReply: () => (++n === 1 ? unauthorized() : new Response('{"updates":{"updatedRows":1,"updatedRange":"A1"}}', { status: 200 })) });
    assert.deepEqual(await sheets.appendRows("sheet-id", "A1", [["a"]], signal), { appendedRows: 1, updatedRange: "A1" });
    assert.equal(c.fetch.length, 2);
  }
});

test("G12 연결을 끊은 뒤·끊는 중에 시작한 요청은 401이어도 재발급·재전송하지 않는다", async () => {
  // 대역 하나로 API 요청과 폐기 요청을 따로 보류한다.
  const setup = () => {
    const api = gate();
    const revoke = gate();
    const c = install({
      fetchReply: (url) => (url.startsWith("https://oauth2.googleapis.com/") ? revoke.promise : api.promise),
    });
    return { c, api, revoke };
  };
  const untilApiSent = async (c, n = 1) => {
    for (let i = 0; i < 50 && apiCalls(c).length < n; i++) await tick();
    assert.equal(apiCalls(c).length, n, "API 요청이 나감");
  };
  const post = () => auth.googleFetch("/v4/x", { method: "POST", body: "{}" });

  // (가) 요청을 시작한 뒤 끊기 → 재연결이 끝나고 나서 그 요청에 401.
  {
    const { c, api, revoke } = setup();
    const settled = rejectsWith(post(), CHANGED);
    await untilApiSent(c);
    revoke.open(new Response("{}", { status: 200 }));
    await auth.clearGoogleToken();
    await auth.connectGoogle();
    const tokenCallsBefore = c.getAuthToken.filter((i) => i === false).length;
    api.open(unauthorized());
    await settled;
    assert.equal(apiCalls(c).length, 1, "(가) API 요청은 최초 1회뿐");
    assert.equal(c.getAuthToken.filter((i) => i === false).length, tokenCallsBefore, "(가) 401 뒤 조용한 재발급 0회");
  }
  // (나) 끊기를 시작해 폐기 응답을 기다리는 사이 요청을 시작 → 끊기·재연결이 끝난 뒤 401.
  {
    const { c, api, revoke } = setup();
    const clearing = auth.clearGoogleToken();
    for (let i = 0; i < 50 && c.fetch.length < 1; i++) await tick();
    assert.equal(c.fetch.length, 1, "폐기 요청이 나가 보류됨");
    const settled = rejectsWith(post(), CHANGED);
    await untilApiSent(c);
    revoke.open(new Response("{}", { status: 200 }));
    await clearing;
    await auth.connectGoogle();
    const tokenCallsBefore = c.getAuthToken.filter((i) => i === false).length;
    api.open(unauthorized());
    await settled;
    assert.equal(apiCalls(c).length, 1, "(나) API 요청은 최초 1회뿐");
    assert.equal(c.getAuthToken.filter((i) => i === false).length, tokenCallsBefore, "(나) 401 뒤 조용한 재발급 0회");
  }
  // (다) (나)와 같되 폐기 응답을 계속 보류한 채(끊기가 끝나지 않음) 재연결하고 401.
  {
    const { c, api, revoke } = setup();
    const clearing = auth.clearGoogleToken();
    for (let i = 0; i < 50 && c.fetch.length < 1; i++) await tick();
    const settled = rejectsWith(post(), CHANGED);
    await untilApiSent(c);
    await auth.connectGoogle();
    const tokenCallsBefore = c.getAuthToken.filter((i) => i === false).length;
    api.open(unauthorized());
    await settled;
    assert.equal(apiCalls(c).length, 1, "(다) API 요청은 최초 1회뿐");
    assert.equal(c.getAuthToken.filter((i) => i === false).length, tokenCallsBefore, "(다) 401 뒤 조용한 재발급 0회");
    revoke.open(new Response("{}", { status: 200 }));
    await clearing;
  }
  // (라) 재발급을 기다리는 사이 끊으면 두 번째 요청을 보내지 않는다.
  {
    const c = install({ fetchReply: (url) => (url.startsWith("https://oauth2.googleapis.com/") ? new Response("{}", { status: 200 }) : unauthorized()) });
    const hold = gate();
    const orig = globalThis.chrome.identity.getAuthToken;
    let n = 0;
    globalThis.chrome.identity.getAuthToken = (o, cb) => {
      if (++n !== 2) return orig(o, cb);
      c.getAuthToken.push(o.interactive);
      hold.promise.then(() => cb(FAKE_TOKEN_2));
    };
    const settled = rejectsWith(post(), CHANGED);
    for (let i = 0; i < 50 && c.getAuthToken.length < 2; i++) await tick();
    await auth.clearGoogleToken();
    hold.open();
    await settled;
    assert.equal(apiCalls(c).length, 1, "(라) API 요청은 최초 1회뿐");
  }
  // 끊기가 없으면(앞의 끊기는 모두 끝났다) 다시 보낸다 — 끊기 수가 0으로 돌아왔는지도 함께 본다.
  {
    let n = 0;
    const c = install({ fetchReply: () => (++n === 1 ? unauthorized() : new Response("{}", { status: 200 })) });
    const res = await post();
    assert.equal(res.status, 200);
    assert.equal(c.fetch.length, 2);
  }
});

test("G13 요청이 도는 사이 Chrome 프로필의 로그인 상태가 바뀌면(다른 계정일 수 있다) 401이어도 재발급·재전송하지 않는다", async () => {
  const drive = await import("../src/background/google/drive.ts");
  // (가) 첫 요청의 응답을 기다리는 사이 계정이 바뀜 → 401 → 재발급 0회, 요청 1회. 다른 계정의 토큰(FAKE_TOKEN_2)으로는 나가지 않는다.
  {
    const api = gate();
    const c = install({ tokenReply: (_i, n) => (n === 1 ? FAKE_TOKEN : FAKE_TOKEN_2), fetchReply: () => api.promise });
    const settled = rejectsWith(drive.listRecent(undefined, 5), CHANGED);
    for (let i = 0; i < 50 && c.fetch.length < 1; i++) await tick();
    assert.equal(c.signInListeners.length, 1, "요청을 보내기 전에 감시를 건다");
    c.signInChanged();
    api.open(unauthorized());
    await settled;
    assert.equal(c.fetch.length, 1);
    assert.deepEqual(c.getAuthToken, [false], "401 뒤 재발급 0회");
    assert.equal(c.fetch.some((f) => bearer(f) === `Bearer ${FAKE_TOKEN_2}`), false);
  }
  // (나) 재발급을 기다리는 사이 계정이 바뀜 → 다시 받은 토큰으로 보내지 않는다.
  {
    const c = install({ fetchReply: unauthorized });
    const hold = gate();
    const orig = globalThis.chrome.identity.getAuthToken;
    let n = 0;
    globalThis.chrome.identity.getAuthToken = (o, cb) => {
      if (++n === 1) return orig(o, cb);
      c.getAuthToken.push(o.interactive);
      hold.promise.then(() => cb(FAKE_TOKEN_2));
    };
    const settled = rejectsWith(auth.googleFetch("/v4/x", { method: "POST", body: "{}" }), CHANGED);
    for (let i = 0; i < 50 && c.getAuthToken.length < 2; i++) await tick();
    c.signInChanged();
    hold.open();
    await settled;
    assert.equal(c.fetch.length, 1, "두 번째 요청 0회");
  }
  // (다) 로그인 상태 변화를 볼 수 없으면(이벤트 없음) 같은 계정인지 확인할 수 없다 → 다시 보내지 않는다.
  {
    const c = install({ signInEvent: false, fetchReply: unauthorized });
    await rejectsWith(auth.googleFetch("/v4/x"), REAUTH);
    assert.equal(c.fetch.length, 1);
    assert.deepEqual(c.getAuthToken, [false]);
    assert.deepEqual(c.removeCached, [FAKE_TOKEN], "401을 받은 토큰은 캐시에서 지운다");
  }
  // (라) 요청 전의 변화는 상관없다: 변화가 없던 요청은 다시 보낸다. 감시는 identity마다 한 번만 건다.
  {
    let n = 0;
    const c = install({ fetchReply: () => (++n === 1 ? unauthorized() : new Response("{}", { status: 200 })) });
    c.signInChanged();
    assert.equal((await auth.googleFetch("/v4/x")).status, 200);
    c.signInChanged();
    n = 0;
    assert.equal((await auth.googleFetch("/v4/x")).status, 200);
    assert.equal(c.fetch.length, 4);
    assert.equal(c.signInListeners.length, 1, "같은 identity에는 감시를 한 번만 건다");
  }
});

test("시트·드라이브의 JSON 읽기: 응답을 지금과 같은 값으로 돌려주고, JSON이 아니면 고정 문구", async () => {
  const sheets = await import("../src/background/google/sheets.ts");
  const drive = await import("../src/background/google/drive.ts");
  let c = install({ fetchReply: () => new Response(JSON.stringify({ range: "S!A1:B1", values: [["a", "b"]] }), { status: 200 }) });
  assert.deepEqual(await sheets.readRange("sheet-id", "A1:B1"), { range: "S!A1:B1", values: [["a", "b"]] });
  assert.equal(c.fetch[0].url, "https://www.googleapis.com/sheets/v4/spreadsheets/sheet-id/values/A1%3AB1?majorDimension=ROWS");
  install({ fetchReply: () => new Response(JSON.stringify({ updatedCells: 4 }), { status: 200 }) });
  assert.deepEqual(await sheets.writeRange("sheet-id", "A1:B2", [["a"]]), { updatedCells: 4 });
  install({ fetchReply: () => new Response(JSON.stringify({ properties: { title: "문서" }, sheets: [{ properties: { sheetId: 7, title: "시트1", index: 0, gridProperties: { rowCount: 10, columnCount: 3 } } }] }), { status: 200 }) });
  assert.deepEqual(await sheets.listSheets("sheet-id"), { title: "문서", sheets: [{ sheetId: 7, title: "시트1", index: 0, rowCount: 10, columnCount: 3 }] });
  const files = [{ id: "f1", name: "이름", mimeType: "text/plain" }];
  install({ fetchReply: () => new Response(JSON.stringify({ files }), { status: 200 }) });
  assert.deepEqual(await drive.searchFiles("name contains 'x'", 5), files);
  install({ fetchReply: () => new Response(JSON.stringify({ files }), { status: 200 }) });
  assert.deepEqual(await drive.listRecent(undefined, 5), files);
  for (const call of [() => sheets.readRange("sheet-id", "A1"), () => sheets.appendRows("sheet-id", "A1", [["a"]]), () => drive.searchFiles("q", 5)]) {
    c = install({ fetchReply: () => new Response("<html>오류 페이지</html>", { status: 200 }) });
    await rejectsWith(call(), UNREADABLE);
    assert.equal(c.fetch.length, 1);
  }
});
