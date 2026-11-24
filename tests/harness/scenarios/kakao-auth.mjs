// 카카오 인증(#310)의 지금 동작을 고정하는 특성 시험(#319 PR ①): 갱신 경쟁, 갱신 중 끊기·키 바꾸기·재연결, 갱신 실패 종류,
// 두 번째 401·동의 철회, 불확실 결과, 설정 메시지 발신자 검사, 연결 실패 분기, 권한 회수 뒤 보내기·비밀 누출.
// 제품 코드는 고치지 않는다. 대역은 kakao-send.mjs의 installKakao(가짜 키·토큰, 실제 카카오로 요청하지 않음)를 쓴다.
// 규칙:
// - 단언은 저장 상태(chrome.storage.local의 kakao) / 돌려준 응답 / 요청 횟수(대역 기록)를 나눠 적는다.
// - 실패 문구에 응답 전체·토큰·키 값을 넣지 않는다(하네스가 실패 문구를 그대로 출력한다). 필드 이름과 채널만 남긴다.
// - 보류 중에 보내는 메시지는 바로 await하지 않는다. 마감 타이머와 경쟁시켜 "제한 시간 안에 끝났는가"로 판정하고,
//   finally에서 보류를 모두 풀고 붙잡아 둔 Promise를 회수한다(직렬 큐 회귀가 생겨도 시험이 멈추지 않고 실패로 끝나게).
import { expect, waitUntil } from "../lib.mjs";
import { connect, installKakao, KAKAO_FAKE } from "./kakao-send.mjs";

const { KEY, CLIENT_SECRET, LINK } = KAKAO_FAKE;

const optSend = (opt, m) => opt.evaluate((msg) => chrome.runtime.sendMessage(msg), m);
const kk = (h) => h.sw.evaluate(() => globalThis.__kk);
const setKk = (h, patch) => h.sw.evaluate((p) => Object.assign(globalThis.__kk, p), patch);
const release = (h, name) => h.sw.evaluate((n) => globalThis.__kkRelease(n), name);
// 저장 상태에서 비밀이 아닌 필드만 읽는다(토큰·키 값은 시나리오로 가져오지 않는다).
const storedInfo = (h) =>
  h.sw.evaluate(async () => {
    const k = (await chrome.storage.local.get("kakao")).kakao ?? null;
    if (!k) return null;
    return { status: k.status, epoch: k.epoch, hasAccess: !!k.accessToken, hasRefresh: !!k.refreshToken, accessExpiresAt: k.accessExpiresAt, refreshExpiresAt: k.refreshExpiresAt };
  });
// 저장 상태 전체를 워커 안에 붙잡아 두고, 뒤에 같은지 여부만 받는다.
const snapshot = (h) =>
  h.sw.evaluate(async () => {
    globalThis.__kkSnap = JSON.stringify((await chrome.storage.local.get("kakao")).kakao ?? null);
  });
const sameAsSnapshot = (h) => h.sw.evaluate(async () => JSON.stringify((await chrome.storage.local.get("kakao")).kakao ?? null) === globalThis.__kkSnap);
// 저장된 토큰 필드를 워커 안에서 비교한다(값은 내보내지 않는다).
const keepRefreshToken = (h) =>
  h.sw.evaluate(async () => {
    globalThis.__kkRefreshSnap = (await chrome.storage.local.get("kakao")).kakao?.refreshToken ?? "";
  });
const refreshTokenSame = (h) => h.sw.evaluate(async () => ((await chrome.storage.local.get("kakao")).kakao?.refreshToken ?? "") === globalThis.__kkRefreshSnap);
const patchStored = (h, patch) =>
  h.sw.evaluate(async (p) => {
    const k = (await chrome.storage.local.get("kakao")).kakao;
    const next = { ...k };
    for (const [key, ms] of Object.entries(p)) next[key] = Date.now() + ms;
    await chrome.storage.local.set({ kakao: next });
  }, patch);
// 액세스 토큰 만료를 10초 뒤로(갱신 여유 60초 안 — 보내기 전에 갱신한다).
const nearExpiry = (h) => patchStored(h, { accessExpiresAt: 10_000 });

const DEADLINE = Symbol("deadline");
// p가 ms 안에 끝났는지. 끝났으면 { done: true, v }, 아니면 { done: false }(p는 계속 돈다 — finally에서 회수).
const within = (p, ms) => {
  let timer;
  const t = new Promise((r) => (timer = setTimeout(() => r(DEADLINE), ms)));
  return Promise.race([p, t]).then((v) => {
    clearTimeout(timer);
    return v === DEADLINE ? { done: false } : { done: true, v };
  });
};
const brief = (r) => (r && r.done === false ? "마감 안에 끝나지 않음" : `ok=${(r?.v ?? r)?.ok}`);

// 붙잡아 둔 Promise를 모으고, 끝에서 보류를 모두 푼 뒤 회수한다. identity 대역도 지운다(공용 워커).
const guarded = (fn) => async (h) => {
  const pending = [];
  const track = (p) => {
    const q = Promise.resolve(p).catch(() => undefined);
    pending.push(q);
    return q;
  };
  try {
    await fn(h, track);
  } finally {
    await h.sw
      .evaluate(() => {
        const k = globalThis.__kk;
        if (k) {
          k.holdRefresh = false;
          k.holdMemo = false;
          k.hold = false;
          k.holdToken = false;
          k.releaseToken?.();
          for (const x of k.held ?? []) x.release?.();
        }
        globalThis.__kkRelease?.("refresh");
        globalThis.__kkRelease?.("memo");
      })
      .catch(() => {});
    await within(Promise.allSettled(pending), 10_000);
    await h.sw
      .evaluate(() => {
        delete chrome.identity;
      })
      .catch(() => {});
  }
};

// 응답·화면·로그에 가짜 키·시크릿·토큰·코드가 없는지. 실패 문구에는 무엇이 어느 채널에 있었는지만 남긴다.
const LEAK_MARKS = [
  ["REST 키", KEY],
  ["클라이언트 시크릿", CLIENT_SECRET],
  ["액세스 토큰", "fake-access-"],
  ["리프레시 토큰", "fake-refresh-"],
  ["인가 코드(주소 꼴)", "code="],
  ["인가 코드", "fake-code-"],
];
// 인가 코드를 고유한 값으로 발급하게 한다(짧은 기본값 "C1"은 다른 글자와 구별할 수 없다). 이후 누출 검사는 그 값 자체를 찾는다.
const uniqueCodes = (h) => setKk(h, { codePrefix: "fake-code-" });
async function expectNoLeak(h, opt, responses) {
  const channels = {
    응답: JSON.stringify(responses),
    "설정 화면": opt ? await opt.evaluate(() => document.body.innerText) : "",
    패널: await h.panel.evaluate(() => document.body.innerText),
    "워커 로그": h.logs.join("\n"),
  };
  for (const [channel, blob] of Object.entries(channels)) {
    for (const [label, mark] of LEAK_MARKS) expect(!blob.includes(mark), `비밀이 새지 않음(${label} / ${channel})`);
  }
}

// 이미 대역이 걸린 상태에서 키 저장 + 연결을 메시지로만 한다(대역을 다시 설치하지 않는다 — 보류·기록이 이어진다). 기록은 비운다.
async function reconnect(h, opt) {
  await setKk(h, { holdRefresh: false, holdMemo: false, refreshReplies: [], memoReplies: [], refreshFail: false });
  const saved = await optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: CLIENT_SECRET, linkUrl: LINK });
  expect(saved?.ok === true, `키 저장(${brief(saved)})`);
  const c = await optSend(opt, { kind: "kakao_connect" });
  expect(c?.ok === true && c.data.connected === true, `연결(${brief(c)})`);
  await setKk(h, { memo: [], tokenReqs: [], flows: [], refreshes: 0, refreshWaiting: 0, memoWaiting: 0 });
}

// 누출 검사를 하는 시나리오의 연결: 첫 로그인 창을 열기 전에 고유한 인가 코드 접두사를 건다(연결 도우미 connect는 기본 "C"로 발급한다).
async function connectUnique(h) {
  const opt = await h.openOptions("model");
  await installKakao(h);
  await uniqueCodes(h);
  await reconnect(h, opt);
  return opt;
}

const testSend = (opt) => optSend(opt, { kind: "kakao_test_send" });
const TEST_FAIL = "카카오톡으로 시험 메시지를 보내지 못했습니다";
const NEEDS_LOGIN = "카카오 로그인이 끝났습니다. 다시 연결하세요.";

export default [
  {
    name: "카카오 인증 H1: 같은 세대의 동시 보내기 둘은 갱신을 한 번만 하고, 풀면 둘 다 새 토큰으로 간다",
    run: guarded(async (h, track) => {
      const opt = await connect(h);
      await nearExpiry(h);
      await setKk(h, { holdRefresh: true });
      const p1 = track(testSend(opt));
      await waitUntil(async () => (await kk(h)).refreshWaiting >= 1, { label: "첫 보내기의 갱신 요청이 대역에 도착" });
      const p2 = track(testSend(opt));
      // 둘째 보내기가 만료 임박 상태를 읽고 갱신까지 갔는지는 저장 큐의 순서로 본다(고정 지연·읽기 횟수 세기 없이).
      // 같은 설정 탭에서 뒤에 보낸 상태 조회는 둘째 보내기보다 늦게 도착하고, 저장 큐는 들어온 순서대로 돈다. 둘째 보내기는
      // 큐를 거쳐 상태를 읽고(시작할 때·토큰을 고를 때) 갱신에 합류하므로, 상태 조회를 차례로 몇 번 끝내면 그 읽기들과 —
      // 합치기가 빠졌다면 따로 시작한 갱신의 읽기·요청까지 — 모두 그 앞에서 끝난다. 읽는 횟수가 달라져도 넉넉하게 네 번 거친다.
      for (let i = 0; i < 4; i++) {
        const st = await within(optSend(opt, { kind: "kakao_status" }), 3000);
        expect(st.done && st.v?.ok === true, `보류 중에도 상태 조회가 끝남(${i + 1}번째, ${brief(st)})`);
      }
      const mid = await kk(h);
      expect(mid.refreshes === 1 && mid.refreshWaiting === 1, `보류 중 갱신 요청 1회(요청 ${mid.refreshes} / 대기 ${mid.refreshWaiting})`);
      expect(mid.memo.length === 0, `갱신 전에는 메모 0(${mid.memo.length})`);
      await setKk(h, { holdRefresh: false });
      await release(h, "refresh");
      const [r1, r2] = [await within(p1, 5000), await within(p2, 5000)];
      expect(r1.done && r1.v?.ok === true && r2.done && r2.v?.ok === true, `둘 다 성공(${brief(r1)} / ${brief(r2)})`);
      const end = await kk(h);
      expect(end.refreshes === 1, `갱신 요청은 끝까지 1회(${end.refreshes})`);
      expect(end.memo.length === 2, `메모 2회(${end.memo.length})`);
      expect(end.memo[0].auth === end.memo[1].auth && /^Bearer fake-access-refreshed-\d+$/.test(end.memo[0].auth), "둘 다 같은 새 토큰");

      // 둘째 보내기가 정말 같은 갱신에 합류했는지: 보류한 갱신을 실패(500)로 푼다. 합류했다면 둘 다 그 한 번의 실패로 끝난다(갱신 1회).
      // 둘째가 첫째 뒤에 줄만 서 있었다면(보내기끼리 직렬화되는 회귀) 첫째가 끝난 뒤 따로 갱신해 갱신이 2회가 되고 성공한다.
      await reconnect(h, opt);
      await nearExpiry(h);
      await setKk(h, { holdRefresh: true, refreshReplies: [{ status: 500, body: { msg: "서버 오류 원문" } }] });
      const q1 = track(testSend(opt));
      await waitUntil(async () => (await kk(h)).refreshWaiting >= 1, { label: "첫 보내기의 갱신 요청이 대역에 도착(실패로 풀기)" });
      const q2 = track(testSend(opt));
      for (let i = 0; i < 4; i++) {
        const st = await within(optSend(opt, { kind: "kakao_status" }), 3000);
        expect(st.done && st.v?.ok === true, `보류 중에도 상태 조회가 끝남(실패로 풀기 ${i + 1}번째, ${brief(st)})`);
      }
      await setKk(h, { holdRefresh: false });
      await release(h, "refresh");
      const [f1, f2] = [await within(q1, 5000), await within(q2, 5000)];
      expect(f1.done && f1.v?.ok === false && String(f1.v.error).startsWith(TEST_FAIL), `첫째: 갱신 실패로 끝남(${brief(f1)})`);
      expect(f2.done && f2.v?.ok === false && String(f2.v.error).startsWith(TEST_FAIL), `둘째: 같은 갱신의 실패로 끝남(${brief(f2)})`);
      const failed = await kk(h);
      expect(failed.refreshes === 1 && failed.memo.length === 0, `실패한 갱신 1회를 둘이 함께 씀(갱신 ${failed.refreshes} / 메모 ${failed.memo.length})`);
    }),
  },
  {
    name: "카카오 인증 H2: 갱신을 기다리는 사이 끊기·재연결·키 바꾸기는 바로 끝나고, 늦게 끝난 옛 갱신(성공·400·401)은 새 상태를 건드리지 않는다",
    run: guarded(async (h, track) => {
      const opt = await connectUnique(h);
      const responses = [];
      const changes = {
        끊기: () => optSend(opt, { kind: "kakao_disconnect" }),
        // 재연결은 연결 도우미(connect)를 다시 부르지 않는다: 대역을 다시 설치하면 보류 중인 갱신을 잃고 키 저장으로 세대가 한 번 더 오른다.
        재연결: () => optSend(opt, { kind: "kakao_connect" }),
        "키 바꾸기": () => optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: "", linkUrl: LINK }),
      };
      const replies = {
        성공: { status: 200, body: { token_type: "bearer", access_token: "fake-access-old-refresh", expires_in: 21599, refresh_token: "fake-refresh-old-refresh", refresh_token_expires_in: 5183999 } },
        400: { status: 400, body: { error: "invalid_grant", error_description: "카카오 오류 원문", error_code: "KOE322" } },
        401: { status: 401, body: { error: "invalid_client", error_description: "카카오 오류 원문", error_code: "KOE010" } },
      };
      const cases = [
        ["끊기", "성공"],
        ["끊기", "400"],
        ["끊기", "401"],
        ["재연결", "성공"],
        ["재연결", "400"],
        ["재연결", "401"],
        ["키 바꾸기", "성공"],
        ["키 바꾸기", "400"],
      ];
      for (const [change, reply] of cases) {
        const what = `${change} / 옛 갱신 ${reply}`;
        await reconnect(h, opt);
        await nearExpiry(h);
        await setKk(h, { holdRefresh: true, refreshReplies: [replies[reply]] });
        const pSend = track(testSend(opt));
        await waitUntil(async () => (await kk(h)).refreshWaiting >= 1, { label: `${what}: 갱신 요청이 대역에 도착` });
        const before = await storedInfo(h);
        const rc = await within(track(changes[change]()), 3000);
        expect(rc.done && rc.v?.ok === true, `${what}: 변경이 3초 안에 끝남(${brief(rc)})`);
        responses.push(rc.v);
        const afterChange = await storedInfo(h);
        expect(afterChange.epoch === before.epoch + 1, `${what}: 세대 +1(${before.epoch} → ${afterChange.epoch})`);
        const hasTokens = change === "재연결";
        expect(
          afterChange.status === "idle" && afterChange.hasAccess === hasTokens && afterChange.hasRefresh === hasTokens,
          `${what}: 변경 직후 저장 상태(status ${afterChange.status}, 액세스 ${afterChange.hasAccess}, 리프레시 ${afterChange.hasRefresh})`,
        );
        await snapshot(h);
        // 옛 갱신을 푼다.
        await setKk(h, { holdRefresh: false });
        await release(h, "refresh");
        const rs = await within(pSend, 5000);
        expect(rs.done && rs.v?.ok === false, `${what}: 보류됐던 보내기는 실패 응답(${brief(rs)})`);
        responses.push(rs.v);
        // 저장 큐를 한 번 더 거쳐(옛 갱신의 저장 시도가 끝난 뒤) 비교한다.
        const st = await optSend(opt, { kind: "kakao_status" });
        responses.push(st);
        expect(await sameAsSnapshot(h), `${what}: 옛 갱신이 끝난 뒤 저장 상태(세대·status·토큰·만료)가 변경 직후와 같다`);
        const end = await kk(h);
        expect(end.refreshes === 1, `${what}: 갱신 요청 1회(${end.refreshes})`);
        expect(end.memo.length === 0, `${what}: 메모 요청 0(${end.memo.length})`);
        expect(st?.ok === true && st.data.needsLogin === false && st.data.connected === (change === "재연결"), `${what}: 상태 응답(needsLogin ${st?.data?.needsLogin}, connected ${st?.data?.connected})`);
      }
      await expectNoLeak(h, opt, responses);
    }),
  },
  {
    name: "카카오 인증 H3: 갱신 응답에 새 리프레시 토큰이 오면 저장을 바꾸고 다음 갱신에 그 값을 쓰며, 없으면 그대로 둔다",
    run: guarded(async (h) => {
      const opt = await connect(h);
      const before = await storedInfo(h);
      await keepRefreshToken(h);
      await nearExpiry(h);
      await setKk(h, { refreshReplies: [{ status: 200, body: { token_type: "bearer", access_token: "fake-access-rotated-1", expires_in: 21599, refresh_token: "fake-refresh-rotated-1", refresh_token_expires_in: 5183999 } }] });
      const r1 = await testSend(opt);
      expect(r1?.ok === true, `새 리프레시 토큰이 온 갱신 뒤 보냄(${brief(r1)})`);
      let st = await kk(h);
      expect(st.refreshes === 1 && st.refreshUsedLatest === true, `갱신 1회, 연결 때 받은 리프레시 토큰 사용(${st.refreshes} / ${st.refreshUsedLatest})`);
      const rotated = await storedInfo(h);
      expect(!(await refreshTokenSame(h)), "저장된 리프레시 토큰이 바뀜");
      expect(rotated.refreshExpiresAt > before.refreshExpiresAt, "리프레시 만료 시각이 바뀜");
      expect(rotated.status === "idle" && rotated.epoch === before.epoch, `세대·status는 그대로(${rotated.epoch} / ${rotated.status})`);

      // 다음 갱신은 새 리프레시 토큰을 쓴다. 이번 응답에는 리프레시 토큰이 없다(대역 기본) → 저장값 그대로.
      await keepRefreshToken(h);
      await nearExpiry(h);
      const r2 = await testSend(opt);
      expect(r2?.ok === true, `둘째 갱신 뒤 보냄(${brief(r2)})`);
      st = await kk(h);
      expect(st.refreshes === 2 && st.refreshUsedLatest === true, `둘째 갱신은 새 리프레시 토큰 사용(${st.refreshes} / ${st.refreshUsedLatest})`);
      const kept = await storedInfo(h);
      expect(await refreshTokenSame(h), "리프레시 토큰이 없는 응답: 저장된 리프레시 토큰 그대로");
      expect(kept.refreshExpiresAt === rotated.refreshExpiresAt, "리프레시 만료 시각 그대로");
    }),
  },
  {
    name: "카카오 인증 H4: 갱신 실패 종류 — 500·형식 이상·연결 실패는 일반 실패(저장 idle), 400·401은 needs_login 저장, 리프레시 만료는 요청 없이 실패(저장은 idle 그대로)",
    run: guarded(async (h) => {
      const opt = await connectUnique(h);
      const responses = [];
      // (가) 일반 실패: 시험 전송 안내, 갱신 1회, 메모 0, 저장 status idle.
      const soft = {
        500: { status: 500, body: { msg: "서버 오류 원문" } },
        "형식 이상": { status: 200, body: { token_type: "bearer" } },
        "연결 실패": "network",
      };
      for (const [what, reply] of Object.entries(soft)) {
        await reconnect(h, opt);
        await nearExpiry(h);
        await setKk(h, { refreshReplies: [reply] });
        const r = await testSend(opt);
        responses.push(r);
        expect(r?.ok === false && String(r.error).startsWith(TEST_FAIL), `갱신 ${what}: 시험 전송 실패 안내(${brief(r)})`);
        const st = await kk(h);
        expect(st.refreshes === 1 && st.memo.length === 0, `갱신 ${what}: 갱신 1회·메모 0(${st.refreshes} / ${st.memo.length})`);
        const s = await storedInfo(h);
        expect(s.status === "idle" && s.hasAccess, `갱신 ${what}: 저장 status idle(${s.status})`);
      }
      // (나) 갱신 거절: needs_login을 저장한다.
      const hard = {
        400: { status: 400, body: { error: "invalid_grant", error_description: "카카오 오류 원문", error_code: "KOE322" } },
        401: { status: 401, body: { error: "invalid_client", error_description: "카카오 오류 원문", error_code: "KOE010" } },
      };
      for (const [what, reply] of Object.entries(hard)) {
        await reconnect(h, opt);
        await nearExpiry(h);
        await setKk(h, { refreshReplies: [reply] });
        const r = await testSend(opt);
        responses.push(r);
        expect(r?.ok === false && r.error === NEEDS_LOGIN, `갱신 ${what}: 다시 연결 안내(${brief(r)})`);
        const st = await kk(h);
        expect(st.refreshes === 1 && st.memo.length === 0, `갱신 ${what}: 갱신 1회·메모 0(${st.refreshes} / ${st.memo.length})`);
        expect((await storedInfo(h)).status === "needs_login", `갱신 ${what}: 저장 status needs_login`);
        const status = await optSend(opt, { kind: "kakao_status" });
        responses.push(status);
        expect(status?.ok === true && status.data.needsLogin === true && status.data.connected === false, `갱신 ${what}: 상태 응답(needsLogin ${status?.data?.needsLogin})`);
      }
      // (다) 저장된 리프레시 만료 시각이 지났으면: 갱신 요청 없이 실패하고, 상태 조회는 needsLogin이지만 저장 status는 idle 그대로다
      // (보내기 경로는 토큰을 고를 때 먼저 걸러 저장에 쓰지 않는다).
      await reconnect(h, opt);
      await patchStored(h, { refreshExpiresAt: -1000 });
      const r = await testSend(opt);
      responses.push(r);
      expect(r?.ok === false && r.error === NEEDS_LOGIN, `리프레시 만료: 다시 연결 안내(${brief(r)})`);
      const st = await kk(h);
      expect(st.refreshes === 0 && st.memo.length === 0, `리프레시 만료: 갱신 0회·메모 0(${st.refreshes} / ${st.memo.length})`);
      const status = await optSend(opt, { kind: "kakao_status" });
      responses.push(status);
      expect(status?.ok === true && status.data.needsLogin === true && status.data.connected === false, `리프레시 만료: 상태 응답(needsLogin ${status?.data?.needsLogin})`);
      expect((await storedInfo(h)).status === "idle", "리프레시 만료: 저장 status는 idle 그대로");
      expect(!JSON.stringify(responses).includes("원문"), "응답에 카카오 오류 원문 없음");
      await expectNoLeak(h, opt, responses);
    }),
  },
  {
    name: "카카오 인증 H5: 갱신 뒤 다시 401·동의 철회(-402)는 needs_login을 저장하고, 갱신을 기다리는 사이 기록된 needs_login은 늦은 갱신 성공이 되살리지 않는다",
    run: guarded(async (h, track) => {
      const opt = await connect(h);
      const unauthorized = { status: 401, body: { msg: "this access token does not exist", code: -401 } };
      const consent = { status: 403, body: { msg: "동의 철회 원문", code: -402 } };
      // (가) 메모 401 → 갱신 성공 → 다시 401.
      await setKk(h, { memoReplies: [unauthorized, unauthorized] });
      const r1 = await testSend(opt);
      expect(r1?.ok === false && r1.error === NEEDS_LOGIN, `두 번째 401: 다시 연결 안내(${brief(r1)})`);
      let st = await kk(h);
      expect(st.refreshes === 1 && st.memo.length === 2, `두 번째 401: 갱신 1회·메모 2회(${st.refreshes} / ${st.memo.length})`);
      expect(st.memo[0].auth !== st.memo[1].auth && /refreshed/.test(st.memo[1].auth), "둘째 메모는 갱신한 토큰");
      expect((await storedInfo(h)).status === "needs_login", "두 번째 401: 저장 status needs_login");

      // (나) 동의 철회는 갱신하지 않고 바로 needs_login.
      await reconnect(h, opt);
      await setKk(h, { memoReplies: [consent] });
      const r2 = await testSend(opt);
      expect(r2?.ok === false && r2.error === NEEDS_LOGIN && !String(r2.error).includes("원문"), `동의 철회: 다시 연결 안내(${brief(r2)})`);
      st = await kk(h);
      expect(st.refreshes === 0 && st.memo.length === 1, `동의 철회: 갱신 0회·메모 1회(${st.refreshes} / ${st.memo.length})`);
      expect((await storedInfo(h)).status === "needs_login", "동의 철회: 저장 status needs_login");

      // (다) 같은 세대 안 경쟁: A의 메모 401로 시작된 갱신을 보류한 사이 B가 동의 철회를 받아 needs_login을 기록한다.
      // 그 뒤 갱신이 성공으로 끝나도 status는 needs_login 그대로다.
      await reconnect(h, opt);
      await setKk(h, { holdRefresh: true, memoReplies: [unauthorized, consent] });
      const pA = track(testSend(opt));
      await waitUntil(async () => (await kk(h)).refreshWaiting >= 1, { label: "A의 갱신 요청이 대역에 도착" });
      const rB = await within(track(testSend(opt)), 3000);
      expect(rB.done && rB.v?.ok === false && rB.v.error === NEEDS_LOGIN, `B: 동의 철회로 실패(${brief(rB)})`);
      expect((await storedInfo(h)).status === "needs_login", "B가 needs_login을 기록");
      await setKk(h, { holdRefresh: false });
      await release(h, "refresh");
      const rA = await within(pA, 5000);
      expect(rA.done && rA.v?.ok === false && rA.v.error === NEEDS_LOGIN, `A: 갱신 뒤에도 다시 연결 안내(${brief(rA)})`);
      await optSend(opt, { kind: "kakao_status" });
      const end = await storedInfo(h);
      expect(end.status === "needs_login", `늦은 갱신 성공이 needs_login을 되살리지 않음(${end.status})`);
      st = await kk(h);
      expect(st.refreshes === 1 && st.memo.length === 2, `같은 세대 경쟁: 갱신 1회·메모 2회(${st.refreshes} / ${st.memo.length})`);
    }),
  },
  {
    name: "카카오 인증 H6: 요청을 보낸 뒤 응답을 받지 못했거나 본문이 깨졌으면 '갔는지 알 수 없음'으로 끝나고 다시 보내지 않는다",
    run: guarded(async (h) => {
      const opt = await connect(h);
      await h.settings({ runMode: "auto" });
      const okReply = { status: 200, body: { result_code: 0 } };
      const text = `${"a".repeat(200)}${"b".repeat(100)}`;
      const lastSend = (r) => r.tools.filter((t) => t.name === "send_to_kakao").at(-1);
      for (const bad of ["throw", "raw"]) {
        await setKk(h, { memo: [], refreshes: 0, memoReplies: [okReply, bad] });
        const r = await h.turn([{ tool: "send_to_kakao", args: { text } }, { text: "끝" }]);
        const t = lastSend(r);
        expect(String(t?.error).includes("2번째 메시지가 갔는지 알 수 없습니다") && t.result === undefined, `둘째 조각 ${bad}: 불확실 문구`);
        const st = await kk(h);
        expect(st.memo.length === 2 && st.refreshes === 0, `둘째 조각 ${bad}: 메모 2회(재전송 없음)·갱신 0(${st.memo.length} / ${st.refreshes})`);
        expect(st.memo.map((m) => m.template.text[0]).join("") === "ab", `둘째 조각 ${bad}: 조각 순서`);
        expect((await storedInfo(h)).status === "idle", `둘째 조각 ${bad}: 저장 status idle`);
      }
      // 시험 전송은 항상 한 조각이다 — 첫 요청에서 불확실 결과를 본다.
      for (const bad of ["throw", "raw"]) {
        await setKk(h, { memo: [], refreshes: 0, memoReplies: [bad] });
        const r = await testSend(opt);
        expect(r?.ok === false && String(r.error).includes("시험 메시지가 왔는지 카카오톡에서 확인하세요"), `시험 전송 ${bad}: 확인 안내(${brief(r)})`);
        const st = await kk(h);
        expect(st.memo.length === 1 && st.refreshes === 0, `시험 전송 ${bad}: 메모 1회(${st.memo.length})`);
        expect((await storedInfo(h)).status === "idle", `시험 전송 ${bad}: 저장 status idle`);
      }
    }),
  },
  {
    name: "카카오 인증 H7: kakao_* 여섯 메시지는 설정 페이지에서만 받는다 — 패널·같은 경로의 웹 문서·쿼리를 붙인 설정 페이지는 거절(요청·저장 변화 0), 해시만 다르면 허용",
    pages: { "/src/options/index.html": `<title>가짜 설정</title><p>웹 문서</p>` },
    run: guarded(async (h) => {
      const opt = await connect(h);
      await snapshot(h);
      const KINDS = ["kakao_status", "kakao_save_keys", "kakao_connect", "kakao_disconnect", "kakao_clear", "kakao_test_send"];
      const msgs = KINDS.map((kind) => ({ kind, restKey: KEY, clientSecret: "", linkUrl: LINK }));
      const sendAll = (page) =>
        page.evaluate(async (list) => {
          const out = [];
          for (const m of list) out.push(await chrome.runtime.sendMessage(m));
          return out;
        }, msgs);
      const rejected = (res) => Array.isArray(res) && res.length === KINDS.length && res.every((x) => x?.ok === false && x.error === "허용되지 않은 요청");
      const which = (res) => (Array.isArray(res) ? KINDS.filter((_, i) => !(res[i]?.ok === false && res[i]?.error === "허용되지 않은 요청")).join(",") : "응답 없음");

      // (a) 사이드 패널.
      const fromPanel = await sendAll(h.panel);
      expect(rejected(fromPanel), `패널: 전부 거절(거절되지 않은 것: ${which(fromPanel)})`);

      // (b) 웹 문서의 content script — 경로를 설정 페이지와 같게 맞춘다(경로만 비교하는 회귀를 잡는다).
      await h.tab.goto(`${h.base}/src/options/index.html#model`);
      await h.tab.waitForTimeout(300);
      const fromContent = await h.sw.evaluate(
        async ({ base, list }) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((t) => (t.url ?? "").startsWith(`${base}/src/options/`));
          const [out] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            args: [list],
            func: async (ms) => {
              const r = [];
              for (const m of ms) r.push(await chrome.runtime.sendMessage(m));
              return r;
            },
          });
          return out.result;
        },
        { base: h.base, list: msgs },
      );
      expect(rejected(fromContent), `content script: 전부 거절(거절되지 않은 것: ${which(fromContent)})`);

      // (c) 쿼리를 붙여 연 설정 페이지: 발신자 주소에서 해시만 떼므로 설정 페이지 주소와 다르다.
      const withQuery = await h.ctx.newPage();
      await withQuery.goto(`${h.optionsUrl}?from=harness#model`);
      await withQuery.waitForTimeout(400);
      const fromQuery = await sendAll(withQuery);
      await withQuery.close();
      expect(rejected(fromQuery), `쿼리 붙은 설정 페이지: 전부 거절(거절되지 않은 것: ${which(fromQuery)})`);

      const st = await kk(h);
      expect(st.flows.length === 0 && st.tokenReqs.length === 0 && st.memo.length === 0 && st.refreshes === 0, `로그인 창·토큰·메모 요청 0(${st.flows.length} / ${st.tokenReqs.length} / ${st.memo.length} / ${st.refreshes})`);
      expect(await sameAsSnapshot(h), "저장값(세대 포함) 불변");

      // 해시만 다른 설정 페이지는 허용.
      const otherHash = await h.openOptions("telegram");
      const ok = await optSend(otherHash, { kind: "kakao_status" });
      await otherHash.close();
      expect(ok?.ok === true && ok.data.connected === true, `해시만 다른 설정 페이지는 허용(${brief(ok)})`);
      const ok2 = await optSend(opt, { kind: "kakao_status" });
      expect(ok2?.ok === true && ok2.data.connected === true, `설정 페이지는 허용(${brief(ok2)})`);
    }),
  },
  {
    name: "카카오 인증 H8: 연결 실패 분기 — 권한 없음·키 없음·리다이렉트 URI 불일치·창 닫음·error 주소·다른 출처·코드 교환 400·연결 실패는 고정 문구로 끝나고 저장·세대가 그대로다",
    run: guarded(async (h) => {
      const opt = await h.openOptions("model");
      await installKakao(h);
      await uniqueCodes(h);
      const responses = [];
      const reqs = async () => {
        const s = await kk(h);
        return { flows: s.flows.length, tokens: s.tokenReqs.length, userMe: s.userMe };
      };
      // 실패 뒤: 토큰 저장 없음, 세대 불변.
      const failsWith = async (what, includes, want) => {
        const before = await storedInfo(h);
        const r0 = await reqs();
        const r = await optSend(opt, { kind: "kakao_connect" });
        responses.push(r);
        expect(r?.ok === false && String(r.error).includes(includes), `${what}: 고정 문구(${brief(r)})`);
        const after = await storedInfo(h);
        expect(!after?.hasAccess && !after?.hasRefresh && (after?.epoch ?? 0) === (before?.epoch ?? 0), `${what}: 액세스·리프레시 토큰 저장 없음·세대 불변(액세스 ${!!after?.hasAccess} / 리프레시 ${!!after?.hasRefresh} / 세대 ${before?.epoch} → ${after?.epoch})`);
        const r1 = await reqs();
        const got = { flows: r1.flows - r0.flows, tokens: r1.tokens - r0.tokens, userMe: r1.userMe - r0.userMe };
        expect(got.flows === want.flows && got.tokens === want.tokens && got.userMe === 0, `${what}: 요청 수(로그인 창 ${got.flows} / 토큰 ${got.tokens} / 사용자 정보 ${got.userMe})`);
      };

      // 키가 없으면 로그인 창을 열지 않는다.
      await failsWith("키 없음", "먼저 REST API 키와 메시지 링크 주소(https)를 저장하세요.", { flows: 0, tokens: 0 });
      const saved = await optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: CLIENT_SECRET, linkUrl: LINK });
      responses.push(saved);
      expect(saved?.ok === true, `키 저장(${brief(saved)})`);

      // identity 권한이 없으면(대역 없음) 권한 안내.
      await h.sw.evaluate(() => {
        globalThis.__kkIdentity = chrome.identity;
        delete chrome.identity;
      });
      await failsWith("권한 없음", "권한이 없어 연결하지 않았습니다.", { flows: 0, tokens: 0 });
      await h.sw.evaluate(() => {
        chrome.identity = globalThis.__kkIdentity;
      });

      await setKk(h, { redirectUrl: "https://other.chromiumapp.org/" });
      await failsWith("리다이렉트 URI 불일치", "리다이렉트 URI가 설정에 보이는 값과 달라 연결하지 않았습니다.", { flows: 0, tokens: 0 });
      await setKk(h, { redirectUrl: null, flowReject: true });
      await failsWith("창 닫음", "카카오 로그인을 끝내지 못했습니다.", { flows: 1, tokens: 0 });
      await setKk(h, { flowReject: false, flowAnswer: "error" });
      await failsWith("error 주소", "카카오 로그인이 끝나지 않았습니다(취소했거나 동의하지 않음).", { flows: 1, tokens: 0 });
      await setKk(h, { flowAnswer: "origin" });
      await failsWith("다른 출처 주소", "카카오 로그인 응답이 올바르지 않아 연결하지 않았습니다.", { flows: 1, tokens: 0 });
      await setKk(h, { flowAnswer: null, tokenReplies: [{ status: 400, body: { error: "invalid_client", error_description: "카카오 오류 원문", error_code: "KOE010" } }] });
      await failsWith("코드 교환 400", "카카오 토큰을 받지 못했습니다(KOE010).", { flows: 1, tokens: 1 });
      await setKk(h, { tokenReplies: ["network"] });
      await failsWith("코드 교환 연결 실패", "카카오에 연결하지 못했습니다. 인터넷 연결을 확인하세요.", { flows: 1, tokens: 1 });
      expect(!JSON.stringify(responses).includes("원문"), "응답에 카카오 오류 원문 없음");

      // 정상 연결: 로그인 주소에 state가 실려 있었다.
      const before = await storedInfo(h);
      const ok = await optSend(opt, { kind: "kakao_connect" });
      responses.push(ok);
      expect(ok?.ok === true && ok.data.connected === true, `정상 연결(${brief(ok)})`);
      expect((await kk(h)).stateEchoed === true, "로그인 주소에 state가 있다");
      const after = await storedInfo(h);
      expect(after.hasAccess && after.hasRefresh && after.epoch === before.epoch + 1, `연결 저장·세대 +1(${before.epoch} → ${after.epoch})`);
      await expectNoLeak(h, opt, responses);
    }),
  },
  {
    name: "카카오 인증 H9: 연결 뒤 identity 권한이 사라져도 보내기·갱신은 되고, 응답·화면·로그에 키·시크릿·토큰이 없다",
    run: guarded(async (h) => {
      const opt = await connectUnique(h);
      const responses = [];
      await h.sw.evaluate(() => {
        delete chrome.identity;
      });
      const r1 = await testSend(opt);
      responses.push(r1);
      expect(r1?.ok === true && (await kk(h)).memo.length === 1, `identity 없이 보내기(${brief(r1)})`);
      await nearExpiry(h);
      const r2 = await testSend(opt);
      responses.push(r2);
      const st = await kk(h);
      expect(r2?.ok === true && st.refreshes === 1 && st.memo.length === 2, `identity 없이 갱신 뒤 보내기(${brief(r2)} / 갱신 ${st.refreshes} / 메모 ${st.memo.length})`);
      // 연결은 권한이 있어야 한다(지금 연결은 그대로 둔다).
      const c = await optSend(opt, { kind: "kakao_connect" });
      responses.push(c);
      expect(c?.ok === false && String(c.error).includes("권한이 없어 연결하지 않았습니다."), `identity 없이 연결은 거절(${brief(c)})`);
      const status = await optSend(opt, { kind: "kakao_status" });
      responses.push(status);
      expect(status?.ok === true && status.data.connected === true, `연결은 그대로(${brief(status)})`);
      await opt.reload();
      await opt.waitForTimeout(400);
      await expectNoLeak(h, opt, responses);
    }),
  },
];
