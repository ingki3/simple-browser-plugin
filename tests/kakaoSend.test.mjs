// send_to_kakao(#310)의 순수 부분: 인증 주소·돌아온 주소 검사, 토큰 응답 해석·갱신 판단, 카카오 나누기(200자 × 5개), 메시지 본문,
// 링크 주소 검사, 조각 보내기(401 → 한 번 갱신 → 재시도, 두 번째 401 → needs_login, 429 재시도 없음), 미리보기 준비·실행.
// 저장·가림·전송은 주입해 시험한다(네트워크 없음, 가짜 키만).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KAKAO_MAX_PARTS,
  KAKAO_MAX_TEXT,
  KAKAO_MEMO_URL,
  MAX_KAKAO_SENDS_PER_TURN,
  SEND_TO_KAKAO_MAX,
  checkRedirect,
  classifyMemo,
  kakaoAuthorizeUrl,
  kakaoConnState,
  kakaoErrorCode,
  kakaoSendAllowed,
  kakaoSendErrorText,
  memoBody,
  needsRefresh,
  parseRefreshResponse,
  parseTokenResponse,
  prepareKakaoSend,
  refreshExpired,
  runKakaoSend,
  scopeAgreed,
  kakaoUserOk,
  sendKakaoParts,
  splitKakao,
  validAppKey,
  validLinkUrl,
} from "../src/lib/kakao.ts";
import { splitWhole, TELEGRAM_MAX_TEXT } from "../src/lib/telegram.ts";
import { sendToKakaoArgs } from "../src/lib/kakaoSendArgs.ts";
import { createSerial } from "../src/lib/async.ts";

const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";
const KEY = "fakeRestKey0123456789abcdef";

const isLone = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};
const okParts = (text, parts) => {
  assert.ok(parts, "null이 아님");
  assert.equal(parts.join(""), text, "이으면 원문");
  assert.ok(parts.length <= KAKAO_MAX_PARTS, `조각 ${parts.length}개`);
  for (const p of parts) {
    assert.ok(p.length <= KAKAO_MAX_TEXT, `조각 ${p.length}자`);
    assert.ok(p.trim().length > 0, "빈·공백만 조각 없음");
    assert.ok(!isLone(p), "서로게이트 쌍을 가르지 않음");
  }
};

// ---- 스키마·상수 ----

test("스키마: text 하나(1~1000자), 받는 곳·링크 같은 키는 거절", () => {
  assert.equal(SEND_TO_KAKAO_MAX, 1000);
  assert.equal(MAX_KAKAO_SENDS_PER_TURN, 3);
  assert.ok(sendToKakaoArgs.safeParse({ text: "안녕" }).success);
  assert.ok(sendToKakaoArgs.safeParse({ text: "가".repeat(1000) }).success);
  for (const bad of [{}, { text: "" }, { text: "  \n" }, { text: "a".repeat(1001) }, { text: "hi", to: "friend" }, { text: "hi", linkUrl: "https://evil.example" }, { text: "hi", receiver_uuids: ["x"] }]) {
    assert.equal(sendToKakaoArgs.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
});

// ---- 인증 ----

test("인증 주소: 고정 kauth 주소, client_id·redirect_uri·code·talk_message·state", () => {
  const u = new URL(kakaoAuthorizeUrl(KEY, REDIRECT, "st8"));
  assert.equal(`${u.origin}${u.pathname}`, "https://kauth.kakao.com/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), KEY);
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("scope"), "talk_message");
  assert.equal(u.searchParams.get("state"), "st8");
});

test("돌아온 주소 검사: 다른 출처·경로, state 불일치, error 있음, code 없음은 거절", () => {
  assert.deepEqual(checkRedirect(`${REDIRECT}?code=C1&state=s`, REDIRECT, "s"), { ok: true, code: "C1" });
  assert.equal(checkRedirect(`https://evil.chromiumapp.org/?code=C1&state=s`, REDIRECT, "s").why, "origin");
  assert.equal(checkRedirect(`${REDIRECT}cb?code=C1&state=s`, REDIRECT, "s").why, "origin");
  assert.equal(checkRedirect(`${REDIRECT}?code=C1&state=t`, REDIRECT, "s").why, "state");
  assert.equal(checkRedirect(`${REDIRECT}?code=C1`, REDIRECT, "s").why, "state");
  assert.equal(checkRedirect(`${REDIRECT}?code=C1&state=`, REDIRECT, "").why, "state", "빈 state는 늘 거절");
  assert.equal(checkRedirect(`${REDIRECT}?error=access_denied&state=s`, REDIRECT, "s").why, "error");
  assert.equal(checkRedirect(`${REDIRECT}?state=s`, REDIRECT, "s").why, "no_code");
  assert.equal(checkRedirect("not a url", REDIRECT, "s").why, "bad_url");
});

test("토큰 응답: 만료 시각 계산, scope에 talk_message가 없으면 거절, 형식 틀리면 거절", () => {
  const now = 1_000_000;
  const body = { access_token: "AT1", expires_in: 21599, refresh_token: "RT1", refresh_token_expires_in: 5183999, scope: "profile_nickname talk_message" };
  assert.deepEqual(parseTokenResponse(body, now), {
    ok: true,
    scopeKnown: true,
    tokens: { accessToken: "AT1", accessExpiresAt: now + 21599_000, refreshToken: "RT1", refreshExpiresAt: now + 5183999_000 },
  });
  assert.deepEqual(parseTokenResponse({ ...body, scope: "profile_nickname" }, now), { ok: false, why: "scope" });
  // scope는 필수 항목이 아니다 — 없으면 동의 내역 조회로 확인하라고 알린다(scopeKnown false).
  const noScope = parseTokenResponse({ ...body, scope: undefined }, now);
  assert.equal(noScope.ok, true);
  assert.equal(noScope.scopeKnown, false);
  assert.deepEqual(parseTokenResponse({ ...body, scope: "talk_messages" }, now), { ok: false, why: "scope" }, "낱말 일부가 아닌 정확한 범위");
  for (const bad of [null, "x", { ...body, access_token: "" }, { ...body, expires_in: "1" }, { ...body, refresh_token: undefined }, { ...body, access_token: "a b" }]) {
    assert.deepEqual(parseTokenResponse(bad, now), { ok: false, why: "format" }, JSON.stringify(bad));
  }
});

test("갱신 응답: 새 리프레시 토큰이 오면 바꾸고, 없으면 지금 것을 둔다", () => {
  const now = 5_000;
  const cur = { refreshToken: "RT1", refreshExpiresAt: 99_999 };
  assert.deepEqual(parseRefreshResponse({ access_token: "AT2", expires_in: 100 }, now, cur), { accessToken: "AT2", accessExpiresAt: now + 100_000, refreshToken: "RT1", refreshExpiresAt: 99_999 });
  assert.deepEqual(parseRefreshResponse({ access_token: "AT2", expires_in: 100, refresh_token: "RT2", refresh_token_expires_in: 200 }, now, cur), {
    accessToken: "AT2",
    accessExpiresAt: now + 100_000,
    refreshToken: "RT2",
    refreshExpiresAt: now + 200_000,
  });
  assert.equal(parseRefreshResponse({ expires_in: 100 }, now, cur), null);
});

test("갱신 판단: 만료 60초 전부터 갱신, 리프레시도 만료면 다시 로그인", () => {
  const now = 10_000_000;
  assert.equal(needsRefresh({ accessExpiresAt: now + 61_000 }, now), false);
  assert.equal(needsRefresh({ accessExpiresAt: now + 59_000 }, now), true);
  assert.equal(needsRefresh({ accessExpiresAt: now - 1 }, now), true);
  assert.equal(refreshExpired({ refreshToken: "R", refreshExpiresAt: now + 1 }, now), false);
  assert.equal(refreshExpired({ refreshToken: "R", refreshExpiresAt: now }, now), true);
  assert.equal(refreshExpired({ refreshToken: "", refreshExpiresAt: now + 1e9 }, now), true);
});

test("오류 코드: KOE 모양만, 원문은 쓰지 않는다", () => {
  assert.equal(kakaoErrorCode({ error: "invalid_grant", error_description: "원문", error_code: "KOE320" }), "KOE320");
  assert.equal(kakaoErrorCode({ error_code: "<script>" }), "");
  assert.equal(kakaoErrorCode(null), "");
});

// ---- 설정 값 ----

test("링크 주소: https만(계정 정보 없음), 키 모양", () => {
  assert.equal(validLinkUrl(" https://example.com/x "), "https://example.com/x");
  for (const bad of ["http://example.com", "javascript:alert(1)", "https://u:p@example.com", "example.com", ""]) assert.equal(validLinkUrl(bad), null, bad);
  assert.ok(validAppKey(KEY));
  for (const bad of ["", "short", "has space here", "a".repeat(200), "키값한글입니다아"]) assert.equal(validAppKey(bad), false, bad);
});

// ---- 나누기 ----

test("카카오 나누기: 200자 정확히 한 조각, 201자 두 조각, 1000자 다섯 조각, 1001자 null", () => {
  assert.deepEqual(splitKakao("가".repeat(200)), ["가".repeat(200)]);
  okParts("가".repeat(201), splitKakao("가".repeat(201)));
  assert.equal(splitKakao("가".repeat(201)).length, 2);
  const t = "a".repeat(1000);
  okParts(t, splitKakao(t));
  assert.equal(splitKakao(t).length, 5);
  assert.equal(splitKakao("a".repeat(1001)), null);
});

test("카카오 나누기: 한글 100자 아홉 줄(908자)은 5개 안에 담긴다(줄바꿈은 남은 조각에 담길 때만 쓴다)", () => {
  const t = Array.from({ length: 9 }, () => "가".repeat(100)).join("\n");
  assert.equal(t.length, 908);
  const p = splitKakao(t);
  okParts(t, p);
  assert.ok(p.length <= 5, `${p.length}개`);
  // 같은 글을 텔레그램 방식으로 200자 5개에 나누면 줄바꿈 경계 때문에 담지 못한다(카카오 나누기를 따로 둔 이유).
  assert.equal(splitWhole(t, 200, 5), null);
});

test("카카오 나누기: 넉넉하면 줄바꿈 경계를 그대로 쓰고, 이모지(서로게이트 쌍)는 가르지 않는다", () => {
  const t = `${"가".repeat(150)}\n${"나".repeat(150)}`;
  assert.deepEqual(splitKakao(t), [`${"가".repeat(150)}\n`, "나".repeat(150)]);
  const e = `${"a".repeat(199)}😀${"b".repeat(300)}`;
  okParts(e, splitKakao(e));
  assert.equal(splitKakao(e)[0].length, 199);
  const all = "😀".repeat(500);
  okParts(all, splitKakao(all));
});

test("텔레그램 splitWhole 기존 결과는 그대로", () => {
  const t = `${"a".repeat(3000)}\n\n${"b".repeat(2000)}`;
  assert.deepEqual(splitWhole(t), [`${"a".repeat(3000)}\n\n`, "b".repeat(2000)]);
  assert.deepEqual(splitWhole("a".repeat(TELEGRAM_MAX_TEXT * 2)).map((x) => x.length), [4096, 4096]);
  assert.equal(splitWhole("a".repeat(30), 10, 2), null);
});

// ---- 메시지 본문·응답 판정 ----

test("메시지 본문: 기본 텍스트 템플릿 JSON(link에 저장한 주소), 고정 주소", () => {
  assert.equal(KAKAO_MEMO_URL, "https://kapi.kakao.com/v2/api/talk/memo/default/send");
  const body = new URLSearchParams(memoBody("안녕 & = ?", "https://example.com/"));
  assert.deepEqual([...body.keys()], ["template_object"]);
  assert.deepEqual(JSON.parse(body.get("template_object")), {
    object_type: "text",
    text: "안녕 & = ?",
    link: { web_url: "https://example.com/", mobile_web_url: "https://example.com/" },
  });
});

test("응답 판정: 200·result_code 0만 성공, 401·-401은 토큰 무효, 429·-10은 쿼터", () => {
  assert.equal(classifyMemo(200, { result_code: 0 }), "ok");
  assert.equal(classifyMemo(200, { result_code: 1 }), "failed");
  assert.equal(classifyMemo(200, null), "failed");
  assert.equal(classifyMemo(401, { code: -401 }), "unauthorized");
  assert.equal(classifyMemo(400, { code: -401 }), "unauthorized");
  assert.equal(classifyMemo(429, null), "quota");
  assert.equal(classifyMemo(400, { code: -10 }), "quota");
  assert.equal(classifyMemo(500, null), "failed");
});

// ---- 조각 보내기 ----

// 토큰 저장소 흉내: 갱신하면 토큰 번호가 오른다. post는 미리 정한 응답을 차례로 돌려준다.
function partStore(replies, { refreshResult = "ok" } = {}) {
  const st = { token: "AT1", n: 1, refreshes: 0, marked: 0, posts: [] };
  const deps = {
    token: async () => ({ ok: true, token: st.token, linkUrl: "https://example.com/" }),
    refresh: async () => {
      st.refreshes++;
      if (refreshResult !== "ok") return refreshResult;
      st.n++;
      st.token = `AT${st.n}`;
      return "ok";
    },
    markNeedsLogin: async () => {
      st.marked++;
    },
    post: async (token, linkUrl, part) => {
      st.posts.push({ token, part });
      return replies.shift() ?? "ok";
    },
  };
  return { st, deps };
}

test("조각 보내기: 둘째 조각 401 → 한 번 갱신 → 그 조각 재시도 → 셋째 조각은 새 토큰", async () => {
  const { st, deps } = partStore(["ok", "unauthorized", "ok", "ok"]);
  const r = await sendKakaoParts(["a", "b", "c"], new AbortController().signal, deps);
  assert.deepEqual(r, { sent: 3, outcome: "done" });
  assert.equal(st.refreshes, 1);
  assert.deepEqual(st.posts, [
    { token: "AT1", part: "a" },
    { token: "AT1", part: "b" },
    { token: "AT2", part: "b" },
    { token: "AT2", part: "c" },
  ]);
});

test("조각 보내기: 재시도도 401이면 needs_login과 보낸 개수, 한 보내기에서 두 번째 401 조각도 needs_login", async () => {
  const a = partStore(["ok", "unauthorized", "unauthorized"]);
  assert.deepEqual(await sendKakaoParts(["a", "b", "c"], new AbortController().signal, a.deps), { sent: 1, outcome: "needs_login" });
  assert.equal(a.st.refreshes, 1);
  assert.equal(a.st.marked, 1);
  const b = partStore(["unauthorized", "ok", "unauthorized"]);
  assert.deepEqual(await sendKakaoParts(["a", "b"], new AbortController().signal, b.deps), { sent: 1, outcome: "needs_login" });
  assert.equal(b.st.refreshes, 1, "한 보내기 안에서 갱신은 한 번");
});

test("조각 보내기: 갱신이 거절되면 needs_login, 갱신 실패(연결)는 send_failed", async () => {
  const a = partStore(["unauthorized"], { refreshResult: "needs_login" });
  assert.deepEqual(await sendKakaoParts(["a"], new AbortController().signal, a.deps), { sent: 0, outcome: "needs_login" });
  const b = partStore(["ok", "unauthorized"], { refreshResult: "failed" });
  assert.deepEqual(await sendKakaoParts(["a", "b"], new AbortController().signal, b.deps), { sent: 1, outcome: "send_failed" });
});

test("조각 보내기: 쿼터 초과(429)는 다시 보내지 않고 send_failed, 실패도 재시도 없음", async () => {
  const a = partStore(["ok", "quota"]);
  assert.deepEqual(await sendKakaoParts(["a", "b", "c"], new AbortController().signal, a.deps), { sent: 1, outcome: "send_failed" });
  assert.equal(a.st.posts.length, 2, "재시도 0회");
  const b = partStore(["failed"]);
  assert.deepEqual(await sendKakaoParts(["a"], new AbortController().signal, b.deps), { sent: 0, outcome: "send_failed" });
  assert.equal(b.st.posts.length, 1);
});

test("조각 보내기: 토큰을 읽지 못하면 그 사유, 보내기 전 중단이면 aborted, 요청 중 끊겨 생긴 예외는 uncertain", async () => {
  const a = partStore([]);
  let n = 0;
  a.deps.token = async () => (++n === 2 ? { ok: false, why: "connection_changed" } : { ok: true, token: "AT1", linkUrl: "https://example.com/" });
  assert.deepEqual(await sendKakaoParts(["a", "b"], new AbortController().signal, a.deps), { sent: 1, outcome: "connection_changed" });
  const ctl = new AbortController();
  ctl.abort();
  const b = partStore([]);
  assert.deepEqual(await sendKakaoParts(["a"], ctl.signal, b.deps), { sent: 0, outcome: "aborted" });
  assert.equal(b.st.posts.length, 0);
  const ctl2 = new AbortController();
  const c = partStore([]);
  c.deps.post = async () => {
    ctl2.abort();
    throw new Error("aborted");
  };
  // 요청을 보낸 뒤 끊겼으면 그 조각이 갔는지 알 수 없다(uncertain — 다시 보내면 겹칠 수 있음).
  assert.deepEqual(await sendKakaoParts(["a", "b"], ctl2.signal, c.deps), { sent: 0, outcome: "uncertain" });
});

// ---- 준비·실행 ----

const FAR = Date.now() + 1e10;
const STATE = { restKey: KEY, linkUrl: "https://example.com/", accessToken: "AT1", refreshToken: "RT1", refreshExpiresAt: FAR, status: "idle", epoch: 4 };

function fakeStore(initial = STATE) {
  const serial = createSerial();
  let stored = { ...initial };
  let conn = new AbortController();
  return {
    read: async () => {
      const c = conn.signal;
      const s = await serial(async () => ({ ...stored }));
      return { s, conn: c, alive: !c.aborted && c === conn.signal };
    },
    disconnect() {
      conn.abort();
      conn = new AbortController();
      return serial(async () => {
        stored = { ...stored, accessToken: "", refreshToken: "", epoch: stored.epoch + 1 };
      });
    },
  };
}
const now = () => Date.now();

test("연결 상태: 로그인 없음 not_connected, needs_login·리프레시 만료는 needs_login", () => {
  assert.equal(kakaoConnState(STATE, Date.now()), "ok");
  assert.equal(kakaoConnState({ ...STATE, accessToken: "" }, Date.now()), "not_connected");
  assert.equal(kakaoConnState({ ...STATE, linkUrl: "" }, Date.now()), "not_connected");
  assert.equal(kakaoConnState({ ...STATE, status: "needs_login" }, Date.now()), "needs_login");
  assert.equal(kakaoConnState({ ...STATE, refreshExpiresAt: 1 }, Date.now()), "needs_login");
});

test("kakaoSendAllowed: 같은 세대·idle·살아 있는 같은 신호일 때만", () => {
  const conn = new AbortController().signal;
  const p = { raw: "a", safeText: "a", epoch: 4, conn };
  const read = (over = {}, alive = true, c = conn) => ({ s: { ...STATE, ...over }, conn: c, alive });
  assert.equal(kakaoSendAllowed(p, read()), true);
  assert.equal(kakaoSendAllowed(p, read({ epoch: 5 })), false);
  assert.equal(kakaoSendAllowed(p, read({ status: "needs_login" })), false);
  assert.equal(kakaoSendAllowed(p, read({ accessToken: "" })), false);
  assert.equal(kakaoSendAllowed(p, read({}, false)), false);
  assert.equal(kakaoSendAllowed(p, read({}, true, new AbortController().signal)), false);
});

test("prepareKakaoSend: 미연결·다시 로그인·가림 실패·가린 뒤 넘침은 카드 없이 끝난다", async () => {
  const mask = async (t) => t;
  assert.deepEqual(await prepareKakaoSend({ read: fakeStore({ ...STATE, accessToken: "" }).read, mask, now }, "글"), { ok: false, why: "not_connected" });
  assert.deepEqual(await prepareKakaoSend({ read: fakeStore({ ...STATE, status: "needs_login" }).read, mask, now }, "글"), { ok: false, why: "needs_login" });
  const store = fakeStore();
  assert.deepEqual(await prepareKakaoSend({ read: store.read, mask: async () => { throw new Error("x"); }, now }, "글"), { ok: false, why: "mask_failed" });
  // 원문은 1000자 이하지만 가리면서 길어져 상한을 넘는다.
  const longer = async (t) => t.replaceAll("pw", "[가린 값]");
  assert.deepEqual(await prepareKakaoSend({ read: store.read, mask: longer, now }, "pw".repeat(400)), { ok: false, why: "too_long" });
  const ok = await prepareKakaoSend({ read: store.read, mask: async (t) => t.replaceAll("Secret1", "[가린 값]"), now }, " 값 Secret1 끝 ");
  assert.equal(ok.ok, true);
  assert.equal(ok.prepared.raw, "값 Secret1 끝");
  assert.equal(ok.prepared.safeText, "값 [가린 값] 끝");
  assert.equal(ok.prepared.epoch, 4);
  assert.equal(ok.parts, 1);
});

test("prepareKakaoSend: 가리는 사이 연결을 끊으면 not_connected", async () => {
  const store = fakeStore();
  const r = await prepareKakaoSend({ read: store.read, mask: async (t) => (store.disconnect(), t), now }, "글");
  assert.deepEqual(r, { ok: false, why: "not_connected" });
});

const runDeps = (store, over = {}) => {
  const sent = [];
  return {
    sent,
    deps: {
      read: store.read,
      mask: async (t) => t,
      parts: {
        token: async () => ({ ok: true, token: "AT1", linkUrl: "https://example.com/" }),
        refresh: async () => "ok",
        markNeedsLogin: async () => {},
        post: async (token, linkUrl, part) => (sent.push(part), "ok"),
      },
      ...over,
    },
  };
};

test("runKakaoSend: 승인한 글(safeText)만 나눠 보내고 이으면 카드 글", async () => {
  const store = fakeStore();
  const text = Array.from({ length: 9 }, () => "가".repeat(100)).join("\n");
  const prep = await prepareKakaoSend({ read: store.read, mask: async (t) => t, now }, text);
  assert.equal(prep.ok, true);
  const { sent, deps } = runDeps(store);
  const r = await runKakaoSend(deps, prep.prepared, new AbortController().signal);
  assert.deepEqual(r, { ok: true, parts: sent.length });
  assert.equal(sent.join(""), prep.prepared.safeText);
});

test("runKakaoSend: 카드 대기 중 연결을 끊으면 전송 0(connection_changed), 가릴 값이 바뀌면 mask_changed", async () => {
  const store = fakeStore();
  const prep = await prepareKakaoSend({ read: store.read, mask: async (t) => t, now }, "글");
  await store.disconnect();
  const { sent, deps } = runDeps(store);
  assert.deepEqual(await runKakaoSend(deps, prep.prepared, new AbortController().signal), { ok: false, why: "connection_changed", sent: 0 });
  assert.equal(sent.length, 0);

  const store2 = fakeStore();
  const prep2 = await prepareKakaoSend({ read: store2.read, mask: async (t) => t, now }, "값 Secret2");
  const d2 = runDeps(store2, { mask: async (t) => t.replace("Secret2", "[가린 값]") });
  assert.deepEqual(await runKakaoSend(d2.deps, prep2.prepared, new AbortController().signal), { ok: false, why: "mask_changed", sent: 0 });
  assert.equal(d2.sent.length, 0);
});

test("runKakaoSend: 두 번째 401은 needs_login과 이미 보낸 개수", async () => {
  const store = fakeStore();
  const prep = await prepareKakaoSend({ read: store.read, mask: async (t) => t, now }, "a".repeat(500));
  const replies = ["ok", "unauthorized", "unauthorized"];
  const { deps } = runDeps(store);
  deps.parts.post = async () => replies.shift() ?? "ok";
  assert.deepEqual(await runKakaoSend(deps, prep.prepared, new AbortController().signal), { ok: false, why: "needs_login", sent: 1 });
});

test("오류 문구: 고정 문구, 이미 간 개수, too_long은 200자·5개 안내", () => {
  assert.ok(kakaoSendErrorText("too_long", 0).includes("200자, 5개(1000자)까지입니다. 요약해서 다시 보내세요."));
  assert.ok(kakaoSendErrorText("send_failed", 2).includes("앞의 2개 메시지는 이미 갔습니다"));
  assert.ok(kakaoSendErrorText("needs_login", 1).includes("카카오 로그인이 끝났습니다. 설정에서 다시 연결하세요"));
  assert.ok(kakaoSendErrorText("not_connected", 0).includes("카카오톡이 연결돼 있지 않습니다"));
});

// ---- 리뷰 보완(#310 코드 리뷰 P2) ----

test("카카오 나누기: 줄바꿈 우선 경계가 이모지 때문에 모자라는 글도 담는다(200·200·200·200·150)", () => {
  const t = `${"가".repeat(149)}\n${"나".repeat(199)}😀${"다".repeat(599)}`;
  assert.equal(t.length, 950);
  okParts(t, splitKakao(t));
  assert.deepEqual(splitKakao(t).map((p) => p.length), [200, 200, 200, 200, 150]);
});

test("응답 판정: 동의 철회(-402)는 consent, 조각 보내기는 needs_login으로 기록", async () => {
  assert.equal(classifyMemo(403, { code: -402, msg: "insufficient scopes" }), "consent");
  const { st, deps } = partStore(["ok", "consent"]);
  assert.deepEqual(await sendKakaoParts(["a", "b", "c"], new AbortController().signal, deps), { sent: 1, outcome: "needs_login" });
  assert.equal(st.marked, 1);
  assert.equal(st.refreshes, 0, "동의 철회는 갱신으로 고치지 않음");
});

test("오류 문구: 보내는 중 연결이 바뀌면 이미 간 개수를 알린다", () => {
  assert.ok(kakaoSendErrorText("connection_changed", 1).includes("앞의 1개 메시지는 이미 갔습니다"));
  assert.ok(kakaoSendErrorText("connection_changed", 0).includes("보내지 않았습니다"));
});

test("카카오 나누기: 긴 공백 덩어리가 있어도 담을 수 있으면 담는다(가 200 + 공백 250 + 나 200)", () => {
  const t = `${"가".repeat(200)}${" ".repeat(250)}${"나".repeat(200)}`;
  const p = splitKakao(t);
  okParts(t, p);
  assert.ok(p.length <= 5);
  assert.equal(splitKakao(" ".repeat(300)), null, "공백뿐이면 null");
  assert.equal(splitKakao(`${"가".repeat(200)}${" ".repeat(801)}`), null, "1000자를 넘으면 null");
});

test("카카오 나누기: 무작위 글(공백·줄바꿈·이모지 섞임)은 담으면 늘 계약을 지킨다", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pieces = ["가", "a", " ", "\n", "😀", "  ", "\n\n"];
  for (let k = 0; k < 300; k++) {
    let t = "";
    const len = Math.floor(rnd() * 1000);
    while (t.length < len) t += pieces[Math.floor(rnd() * pieces.length)];
    if (t.length > 1000) t = t.slice(0, isLone(t.slice(0, 1000)) ? 999 : 1000);
    const p = splitKakao(t);
    if (p) okParts(t, p);
    else assert.ok(!t.trim() || t.length > 1000, `담지 못함(${t.length}자)`);
  }
});

test("동의 내역·사용자 정보 판정: talk_message 동의, 회원번호만 본다", () => {
  assert.equal(scopeAgreed({ id: 1, scopes: [{ id: "talk_message", agreed: true }] }, "talk_message"), true);
  assert.equal(scopeAgreed({ scopes: [{ id: "talk_message", agreed: false }] }, "talk_message"), false);
  assert.equal(scopeAgreed({ scopes: [{ id: "profile_nickname", agreed: true }] }, "talk_message"), false);
  assert.equal(scopeAgreed(null, "talk_message"), false);
  assert.equal(kakaoUserOk({ id: 1234567890, kakao_account: {} }), true);
  assert.equal(kakaoUserOk({ id: "1" }), false);
  assert.equal(kakaoUserOk(null), false);
});

test("조각 보내기: 요청을 보낸 뒤 응답을 받지 못하면 uncertain(그 조각은 세지 않고 갔는지 모른다고 알림)", async () => {
  const a = partStore([]);
  let n = 0;
  a.deps.post = async () => {
    if (++n === 2) throw new Error("network");
    return "ok";
  };
  assert.deepEqual(await sendKakaoParts(["a", "b", "c"], new AbortController().signal, a.deps), { sent: 1, outcome: "uncertain" });
  const text = kakaoSendErrorText("uncertain", 1);
  assert.ok(text.includes("2번째 메시지가 갔는지 알 수 없습니다") && text.includes("앞의 1개 메시지는 이미 갔습니다"), text);
  // 토큰 읽기에서 난 예외(보내기 전)는 send_failed.
  const b = partStore([]);
  b.deps.token = async () => {
    throw new Error("x");
  };
  assert.deepEqual(await sendKakaoParts(["a"], new AbortController().signal, b.deps), { sent: 0, outcome: "send_failed" });
});
