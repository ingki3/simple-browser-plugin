// send_to_kakao(#310): 패널 요청 결과를 로그인한 사용자 자신의 카카오톡 "나와의 채팅"으로 보낸다.
// 서비스 워커의 fetch로 kauth.kakao.com(토큰 발급·갱신)·kapi.kakao.com(나에게 보내기)을 흉내 내고, chrome.identity
// (launchWebAuthFlow·getRedirectURL)는 하네스가 워커 전역에 대역을 설치한다(일반 빌드 그대로 — 시험 빌드 전용 코드 없음). 실제 카카오로는
// 요청하지 않고 키·토큰은 모두 가짜 값이다. 대역은 돌아올 주소를 보류했다가 나중에 풀 수 있다(늦게 끝난 로그인).
// 공용 워커를 쓰는 시나리오는 끝나면 chrome.identity 대역을 지운다(settings 시나리오가 "권한을 받기 전에는 identity 없음"을 본다).
import { expect, waitUntil } from "../lib.mjs";

const KEY = "fakeKakaoRestKey0000aaaa";
const CLIENT_SECRET = "fakeKakaoSecret0000bbbb";
const LINK = "https://example.com/";
const SECRET = "Harness-Pw-2100";
// kakao-auth.mjs(#319)가 같은 가짜 값을 쓴다.
export const KAKAO_FAKE = { KEY, CLIENT_SECRET, LINK };

// 워커에 카카오 대역을 건다(fetch 감싸기는 한 번만 — 다른 시나리오의 텔레그램 대역과 겹쳐도 그대로 이어지게). 기록은 매번 비운다.
// #319: 인증 특성 시험(kakao-auth.mjs)이 쓰는 필드를 더했다. 더한 필드의 기본값은 모두 "지금과 같은 응답"이다.
// - holdRefresh / holdMemo: 갱신·메모 응답을 __kkRelease("refresh" | "memo")까지 보류한다. 보류된 요청은 모두 같은 해제 Promise를
//   기다린다(요청이 여러 건이어도 한 번에 풀린다). 보류는 실제 fetch와 달리 abort 신호로 풀리지 않으니 시나리오 끝에서 반드시 푼다.
// - refreshReplies / tokenReplies: 갱신·코드 교환 응답 큐({ status, body } 또는 "network" = fetch 거부). 비면 지금 응답.
// - memoReplies: { status, body } 말고도 "throw"(요청을 기록한 뒤 거부)·"raw"(200 + JSON이 아닌 본문)를 넣을 수 있다.
// - flowReject / flowAnswer("error" | "origin") / redirectUrl: 로그인 창 거부, 돌아올 주소 바꾸기, getRedirectURL 값 바꾸기.
// - refreshUsedLatest / stateEchoed: 대역이 안에서 계산한 일치 여부만 내보낸다(토큰·state 값은 시나리오로 나가지 않는다).
// - kakaoReads: chrome.storage.local.get("kakao") 횟수(보내기가 저장 상태를 읽었는지 — 제품 코드를 고치지 않고 본다).
export async function installKakao(h) {
  await h.sw.evaluate(() => {
    // 앞 시나리오가 남긴 보류는 풀고 새 게이트를 만든다(게이트는 __kk 밖에 둔다 — __kk는 값만 담아 그대로 읽어 온다).
    const mkGate = () => {
      let open;
      const promise = new Promise((r) => (open = r));
      return { promise, open };
    };
    for (const g of Object.values(globalThis.__kkGates ?? {})) g.open();
    globalThis.__kkGates = { refresh: mkGate(), memo: mkGate() };
    globalThis.__kkRelease = (name) => {
      globalThis.__kkGates[name].open();
      globalThis.__kkGates[name] = mkGate();
    };
    if (!globalThis.__kkGetInstalled) {
      globalThis.__kkGetInstalled = true;
      const origGet = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = (...a) => {
        if (a[0] === "kakao" && globalThis.__kk) globalThis.__kk.kakaoReads += 1;
        return origGet(...a);
      };
    }
    globalThis.__kk = {
      holdRefresh: false,
      refreshWaiting: 0,
      holdMemo: false,
      memoWaiting: 0,
      refreshReplies: [],
      tokenReplies: [],
      flowReject: false,
      flowAnswer: null,
      redirectUrl: null,
      lastRefreshIssued: null,
      refreshUsedLatest: null,
      stateEchoed: null,
      kakaoReads: 0,
      tokenReqs: [],
      memo: [],
      flows: [],
      held: [],
      refreshes: 0,
      memoReplies: [],
      hold: false,
      badState: false,
      tokenScope: "profile_nickname talk_message",
      refreshFail: false,
      codeSeq: 0,
      // 사용자 정보 조회(연결 확정)·동의 내역 조회(토큰 응답에 scope가 없을 때).
      userMe: 0,
      userMeFail: false,
      scopeReqs: 0,
      scopesAgreed: true,
      // 동의 내역 조회를 500으로 답한다(조회 실패 — 다시 시도 안내).
      scopesFail: false,
      // 코드 교환 응답을 __kk.releaseToken()까지 보류한다(교환 중 끊기).
      holdToken: false,
      releaseToken: null,
    };
    if (!globalThis.__kkFetchInstalled) {
      globalThis.__kkFetchInstalled = true;
      const prev = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        const kk = globalThis.__kk;
        const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (u === "https://kauth.kakao.com/oauth/token") {
          const p = new URLSearchParams(String(init?.body ?? ""));
          kk.tokenReqs.push({ grant: p.get("grant_type"), clientId: p.get("client_id"), hasSecret: p.has("client_secret"), code: p.get("code"), redirect: p.get("redirect_uri"), method: init?.method });
          if (p.get("grant_type") === "authorization_code") {
            if (kk.holdToken) await new Promise((r) => (kk.releaseToken = r));
            const tr = kk.tokenReplies.shift();
            if (tr === "network") throw new TypeError("Failed to fetch");
            if (tr) return json(tr.status, tr.body);
            kk.lastRefreshIssued = `fake-refresh-${p.get("code")}`;
            return json(200, {
              token_type: "bearer",
              access_token: `fake-access-${p.get("code")}`,
              expires_in: 21599,
              refresh_token: `fake-refresh-${p.get("code")}`,
              refresh_token_expires_in: 5183999,
              // tokenScope가 null이면 scope를 빼고 답한다(필수 항목이 아님).
              ...(kk.tokenScope === null ? {} : { scope: kk.tokenScope }),
            });
          }
          if (p.get("grant_type") === "refresh_token") {
            kk.refreshes += 1;
            kk.refreshUsedLatest = p.get("refresh_token") === kk.lastRefreshIssued;
            if (kk.holdRefresh) {
              kk.refreshWaiting += 1;
              await globalThis.__kkGates.refresh.promise;
            }
            // 보류를 풀 때도 큐의 다음 항목으로 답한다(kk는 처음 붙잡은 기록 — 보류 사이 대역을 다시 설치하지 않는다).
            const rr = kk.refreshReplies.shift();
            if (rr === "network") throw new TypeError("Failed to fetch");
            if (rr) {
              if (rr.status === 200 && typeof rr.body?.refresh_token === "string") kk.lastRefreshIssued = rr.body.refresh_token;
              return json(rr.status, rr.body);
            }
            if (kk.refreshFail) return json(400, { error: "invalid_grant", error_description: "카카오 오류 원문", error_code: "KOE322" });
            // 토큰 이름은 기록을 비워도 이어지는 번호(조각마다 어느 토큰을 썼는지 구분).
            globalThis.__kkTokenSeq = (globalThis.__kkTokenSeq ?? 0) + 1;
            return json(200, { token_type: "bearer", access_token: `fake-access-refreshed-${globalThis.__kkTokenSeq}`, expires_in: 21599 });
          }
          return json(400, { error: "unsupported_grant_type" });
        }
        if (u.startsWith("https://kapi.kakao.com/v2/user/me")) {
          kk.userMe += 1;
          return kk.userMeFail ? json(401, { code: -401, msg: "사용자 정보 원문" }) : json(200, { id: 1234567890, kakao_account: { profile: { nickname: "가짜 이름" } } });
        }
        if (u.startsWith("https://kapi.kakao.com/v2/user/scopes")) {
          kk.scopeReqs += 1;
          if (kk.scopesFail) return json(500, { msg: "서버 오류 원문" });
          return json(200, { id: 1234567890, scopes: [{ id: "talk_message", display_name: "카카오톡 메시지 전송", type: "PRIVACY", using: true, agreed: kk.scopesAgreed, revocable: true }] });
        }
        if (u.startsWith("https://kapi.kakao.com/") || u.startsWith("https://kauth.kakao.com/")) {
          const p = new URLSearchParams(String(init?.body ?? ""));
          const auth = init?.headers?.authorization ?? init?.headers?.Authorization ?? "";
          let template = null;
          try {
            template = JSON.parse(p.get("template_object") ?? "null");
          } catch {}
          kk.memo.push({ url: u, method: init?.method, auth, keys: [...p.keys()], template });
          if (kk.holdMemo) {
            kk.memoWaiting += 1;
            await globalThis.__kkGates.memo.promise;
          }
          const r = kk.memoReplies.shift() ?? { status: 200, body: { result_code: 0 } };
          if (r === "throw") throw new TypeError("Failed to fetch");
          if (r === "raw") return new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
          return json(r.status, r.body);
        }
        return prev(url, init);
      };
    }
    // identity 대역: 돌아올 주소는 인증 주소의 state·redirect_uri로 만든다(badState면 다른 state). hold면 __kk.held의 함수로 풀 때까지 보류.
    chrome.identity = {
      getRedirectURL: () => globalThis.__kk.redirectUrl ?? `https://${chrome.runtime.id}.chromiumapp.org/`,
      launchWebAuthFlow: async ({ url }) => {
        const kk = globalThis.__kk;
        const a = new URL(url);
        kk.flows.push({ origin: a.origin, path: a.pathname, clientId: a.searchParams.get("client_id"), scope: a.searchParams.get("scope"), redirect: a.searchParams.get("redirect_uri") });
        kk.stateEchoed = !!a.searchParams.get("state");
        if (kk.flowReject) throw new Error("The user did not approve access.");
        const code = `C${++kk.codeSeq}`;
        const state = kk.badState ? "wrong-state" : a.searchParams.get("state");
        if (kk.flowAnswer === "error") return `${a.searchParams.get("redirect_uri")}?error=access_denied&state=${state}`;
        if (kk.flowAnswer === "origin") return `https://other.example/?code=${code}&state=${state}`;
        const answer = `${a.searchParams.get("redirect_uri")}?code=${code}&state=${state}`;
        if (!kk.hold) return answer;
        return new Promise((resolve) => kk.held.push({ code, release: () => resolve(answer) }));
      },
    };
  });
}

const removeIdentity = (h) => h.sw.evaluate(() => {
  delete chrome.identity;
});

// 공용 워커에서 돌고 끝나면 identity 대역을 지운다.
const withKakao = (fn) => async (h) => {
  try {
    await fn(h);
  } finally {
    await removeIdentity(h).catch(() => {});
  }
};

const optSend = (opt, m) => opt.evaluate((msg) => chrome.runtime.sendMessage(msg), m);
const kk = (h) => h.sw.evaluate(() => globalThis.__kk);
const clearKk = (h) => h.sw.evaluate(() => {
  globalThis.__kk.memo = [];
  globalThis.__kk.tokenReqs = [];
  globalThis.__kk.flows = [];
  globalThis.__kk.refreshes = 0;
});
const memoTexts = async (h) => (await kk(h)).memo.map((m) => m.template?.text);
const stored = (h) => h.sw.evaluate(async () => (await chrome.storage.local.get("kakao")).kakao ?? null);
// 같은 대화의 다음 턴은 첫 요청에 앞 턴의 마지막 도구 결과가 실려 __toolLog 맨 앞에 다시 남는다 — 이번 턴 몫은 끝에서 센다.
const sendLog = (r) => r.tools.filter((t) => t.name === "send_to_kakao");
const lastSend = (r) => sendLog(r).at(-1);
const send = (text) => ({ tool: "send_to_kakao", args: { text } });

// 설정 페이지를 열어 키를 저장하고 카카오 로그인으로 연결한다(대역 설치 포함). 기록은 비우고 설정 페이지를 돌려준다.
export async function connect(h, opt) {
  opt ??= await h.openOptions("model");
  await installKakao(h);
  const saved = await optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: CLIENT_SECRET, linkUrl: LINK });
  expect(saved?.ok && saved.data.hasKey && saved.data.linkSet && !saved.data.connected, `키 저장(${JSON.stringify(saved)})`);
  expect(!JSON.stringify(saved).includes(KEY) && !JSON.stringify(saved).includes(CLIENT_SECRET), "상태에 키·시크릿 없음");
  const c = await optSend(opt, { kind: "kakao_connect" });
  expect(c?.ok && c.data.connected && c.data.connectedAt > 0, `연결(${JSON.stringify(c)})`);
  expect(Object.keys(c.data).sort().join(",") === "connected,connectedAt,hasKey,linkSet,needsLogin", `허용한 필드만(${Object.keys(c.data)})`);
  expect((await kk(h)).userMe === 1, "연결 확정에 사용자 정보 조회 한 번");
  expect(!JSON.stringify(await stored(h)).includes("가짜 이름"), "사용자 정보는 저장하지 않음");
  await clearKk(h);
  return opt;
}

// 도구 결과·패널·로그에 키·시크릿·토큰 문자열이 없는지.
async function noSecrets(h, r) {
  const panelText = await h.panel.evaluate(() => document.body.innerText);
  const blobs = [JSON.stringify(r.tools), panelText, h.logs.join("\n")];
  for (const s of [KEY, CLIENT_SECRET, "fake-access-", "fake-refresh-"]) {
    expect(!blobs.some((b) => b.includes(s)), `비밀이 새지 않음(${s})`);
  }
}

export default [
  {
    name: "send_to_kakao: 연결하지 않았으면 카드 없이 고정 문구로 실패하고 보내지 않는다",
    run: withKakao(async (h) => {
      await installKakao(h);
      const r = await h.turn([send("요약입니다"), { text: "끝" }]);
      expect(r.cards === 0 && !r.stoppedAtCard, `카드 없음(${r.cards})`);
      const t = lastSend(r);
      expect(t && String(t.error).includes("카카오톡이 연결돼 있지 않습니다") && t.result === undefined, `실패 문구(${JSON.stringify(t)})`);
      expect((await kk(h)).memo.length === 0, "전송 0");
    }),
  },
  {
    name: "send_to_kakao(ask): 카드에 가린 글 전체, 승인하면 고정 주소로 조각 수만큼 가고 이으면 카드 글, 거절하면 0",
    run: withKakao(async (h) => {
      await connect(h);
      // 한글 100자 아홉 줄(908자) — 5개 안에 담긴다.
      const lines = Array.from({ length: 9 }, (_, i) => `${i}${"가".repeat(99)}`);
      const text = lines.join("\n");
      let cardText = "";
      const r = await h.turn([send(text), { text: "보냈습니다" }], {
        onCard: async (card) => {
          cardText = await card.innerText();
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1, `카드 1개(${r.cards})`);
      expect(cardText.includes("카카오톡으로 보내기") && cardText.includes("내 카카오톡(나와의 채팅)") && cardText.includes("5개 메시지") && cardText.includes(lines[8]), `카드에 글 전체(${cardText.slice(0, 200)})`);
      const st = await kk(h);
      expect(st.memo.length === 5, `5조각(${st.memo.length})`);
      expect(st.memo.every((m) => m.url === "https://kapi.kakao.com/v2/api/talk/memo/default/send" && m.method === "POST" && m.auth === "Bearer fake-access-C1"), `고정 주소·토큰(${JSON.stringify(st.memo.map((m) => [m.url, m.auth]))})`);
      expect(st.memo.every((m) => m.keys.join(",") === "template_object" && m.template.object_type === "text" && m.template.link.web_url === LINK && m.template.link.mobile_web_url === LINK && m.template.text.length <= 200), "기본 텍스트 템플릿·저장한 링크");
      expect(st.memo.map((m) => m.template.text).join("") === text, "이으면 카드 글");
      const t = lastSend(r);
      expect(t?.result?.sent === true && t.result.parts === 5 && !JSON.stringify(t).includes(lines[8]), `결과는 고정 값(${JSON.stringify(t)})`);
      expect((await h.panel.locator(".tool-result").last().innerText()).includes("카카오톡으로 보냄(5개 메시지)"), "패널 결과 줄");
      await noSecrets(h, r);

      await clearKk(h);
      const r2 = await h.turn([send("거절할 글"), { text: "안 보냄" }], { onCard: (card) => card.locator(".btn-cancel").click() });
      expect(r2.cards === 1 && sendLog(r2).at(-1)?.error === "user_cancelled", `거절(${JSON.stringify(sendLog(r2))})`);
      expect((await kk(h)).memo.length === 0, "거절하면 전송 0");
    }),
  },
  {
    name: "send_to_kakao: auto는 카드 없이, task는 맡기기 카드 한 번, 외부 본문 보호 중 auto는 카드",
    pages: { "/s": `<title>목록</title><main><a href="/doc">문서</a><p id=out></p></main>`, "/doc": `<title>문서</title><main><p>외부 문서 본문</p></main>` },
    run: withKakao(async (h) => {
      await connect(h);
      await h.settings({ runMode: "auto" });
      const r = await h.turn([send("자동으로 보낼 글"), { text: "보냈습니다" }]);
      expect(r.cards === 0 && (await memoTexts(h)).join("|") === "자동으로 보낼 글", `auto 카드 없이(${r.cards} / ${await memoTexts(h)})`);

      await clearKk(h);
      const seen = [];
      const r2 = await h.turn([{ tool: "read_linked_pages", args: { urls: [`${h.base}/doc`] } }, send("보호 중 보낼 글"), { text: "끝" }], {
        path: "/s",
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      const kc = seen.find((t) => t.includes("카카오톡으로 보내기"));
      expect(r2.cards >= 1 && kc && kc.includes("외부 문서 내용을 읽은 대화라 자동 실행하지 않음") && kc.includes("보호 중 보낼 글"), `보호 중 카드(${seen.map((s) => s.slice(0, 80)).join(" | ")})`);
      expect((await memoTexts(h)).join("|") === "보호 중 보낼 글", "승인 뒤 보냄");

      await clearKk(h);
      await h.settings({ runMode: "task" });
      const seen2 = [];
      const r3 = await h.turn([send("맡긴 뒤 보낼 글"), { text: "보냈습니다" }], {
        onCard: async (card) => {
          seen2.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      expect(r3.cards === 1 && seen2[0].includes("작업 맡기기"), `맡기기 카드 하나(${r3.cards} / ${seen2[0]?.slice(0, 120)})`);
      expect((await memoTexts(h)).join("|") === "맡긴 뒤 보낼 글", "맡긴 뒤 보냄");
    }),
  },
  {
    name: "send_to_kakao: 한 요청에 3번까지(4번째 거절, 텔레그램과 따로 셈), 받는 곳·링크 인자는 스키마가 거절(카드·전송 0)",
    run: withKakao(async (h) => {
      await connect(h);
      await h.settings({ runMode: "auto" });
      const r = await h.turn([send("1"), send("2"), send("3"), send("4"), { tool: "send_to_telegram", args: { text: "tg" } }, { text: "끝" }]);
      const log = sendLog(r);
      expect(log.length === 4 && log.slice(0, 3).every((t) => t.result?.sent === true) && String(log[3].error).includes("최대 3번"), `4번째 거절(${JSON.stringify(log)})`);
      expect((await memoTexts(h)).join(",") === "1,2,3", "세 번만 감");
      const tg = r.tools.find((t) => t.name === "send_to_telegram");
      expect(tg && !String(tg.error).includes("최대"), `텔레그램은 따로 셈(${JSON.stringify(tg)})`);

      await clearKk(h);
      await h.settings({ runMode: "ask" });
      for (const extra of [{ linkUrl: "https://evil.example/" }, { receiver_uuids: ["friend"] }, { to: "friend" }]) {
        const r2 = await h.turn([{ tool: "send_to_kakao", args: { text: "다른 곳으로", ...extra } }, { text: "끝" }]);
        const t = sendLog(r2).at(-1);
        expect(r2.cards === 0 && String(t?.error).includes("인자 검증 실패"), `${Object.keys(extra)} 거절(${JSON.stringify(t)})`);
      }
      expect((await kk(h)).memo.length === 0, "전송 0");
    }),
  },
  {
    name: "send_to_kakao: 카드 대기 중 연결을 끊거나 다시 연결하거나 키를 바꾸면 승인해도 보내지 않는다",
    run: withKakao(async (h) => {
      const opt = await connect(h);
      const cases = [
        ["끊기", () => optSend(opt, { kind: "kakao_disconnect" })],
        ["다시 연결", () => optSend(opt, { kind: "kakao_connect" })],
        ["키 바꾸기", () => optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: "", linkUrl: LINK })],
      ];
      for (const [what, change] of cases) {
        const r = await h.turn([send(`${what} 전 글`), { text: "끝" }], {
          onCard: async (card) => {
            const res = await change();
            expect(res?.ok, `${what}(${JSON.stringify(res)})`);
            await card.locator(".btn-approve").click();
          },
        });
        const t = lastSend(r);
        expect(r.cards === 1 && String(t?.error).includes("카카오 연결이 바뀌어"), `${what} → 거절(${JSON.stringify(t)})`);
        expect((await kk(h)).memo.length === 0, `${what}: 전송 0`);
        // 다음 경우를 위해 다시 연결한다.
        if (what !== "다시 연결") {
          if (what === "키 바꾸기") await optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: CLIENT_SECRET, linkUrl: LINK });
          const c = await optSend(opt, { kind: "kakao_connect" });
          expect(c?.ok && c.data.connected, `다시 연결(${JSON.stringify(c)})`);
        }
        await clearKk(h);
      }
    }),
  },
  {
    name: "send_to_kakao: 만료된 액세스 토큰은 갱신 뒤, 401은 한 번 갱신해 그 조각만 다시, 갱신이 거절되면 다시 로그인 필요",
    run: withKakao(async (h) => {
      const opt = await connect(h);
      await h.settings({ runMode: "auto" });
      // 1) 만료가 가까운 토큰 → 보내기 전에 갱신.
      await h.sw.evaluate(async () => {
        const k = (await chrome.storage.local.get("kakao")).kakao;
        await chrome.storage.local.set({ kakao: { ...k, accessExpiresAt: Date.now() + 10_000 } });
      });
      const r1 = await h.turn([send("만료 전 갱신"), { text: "끝" }]);
      let st = await kk(h);
      expect(lastSend(r1)?.result?.sent === true && st.refreshes === 1 && st.memo.length === 1 && /^Bearer fake-access-refreshed-\d+$/.test(st.memo[0].auth), `갱신 뒤 보냄(${JSON.stringify({ r: st.refreshes, a: st.memo.map((m) => m.auth) })})`);
      expect(st.tokenReqs.at(-1)?.grant === "refresh_token" && st.tokenReqs.at(-1).hasSecret && st.tokenReqs.at(-1).clientId === KEY, "갱신 요청 본문");

      // 2) 둘째 조각이 401 → 한 번 갱신하고 그 조각만 다시, 셋째 조각은 새 토큰.
      await clearKk(h);
      await h.sw.evaluate(() => {
        globalThis.__kk.memoReplies = [{ status: 200, body: { result_code: 0 } }, { status: 401, body: { msg: "this access token does not exist", code: -401 } }];
      });
      const text = `${"a".repeat(200)}${"b".repeat(200)}${"c".repeat(100)}`;
      const r2 = await h.turn([send(text), { text: "끝" }]);
      st = await kk(h);
      expect(lastSend(r2)?.result?.parts === 3 && st.refreshes === 1, `401 뒤 성공(${JSON.stringify(lastSend(r2))} / ${st.refreshes})`);
      const auths = st.memo.map((m) => m.auth);
      expect(auths[0] === auths[1] && auths[1] !== auths[2] && auths[2] === auths[3] && /refreshed/.test(auths[2]) && st.memo.map((m) => m.template.text[0]).join("") === "abbc", `조각·토큰 순서(${st.memo.map((m) => `${m.template.text[0]}:${m.auth}`).join(",")})`);

      // 3) 429는 다시 보내지 않는다.
      await clearKk(h);
      await h.sw.evaluate(() => {
        globalThis.__kk.memoReplies = [{ status: 429, body: { code: -10, msg: "쿼터 원문" } }];
      });
      const r3 = await h.turn([send("쿼터"), { text: "끝" }]);
      expect(String(lastSend(r3)?.error).includes("카카오톡으로 보내지 못했습니다") && (await kk(h)).memo.length === 1 && !JSON.stringify(sendLog(r3)).includes("쿼터 원문"), `429 재시도 없음(${JSON.stringify(sendLog(r3))})`);

      // 4) 401 → 갱신 거절(400) → 다시 로그인 필요.
      await clearKk(h);
      await h.sw.evaluate(() => {
        globalThis.__kk.memoReplies = [{ status: 401, body: { code: -401 } }];
        globalThis.__kk.refreshFail = true;
      });
      const r4 = await h.turn([send("로그인 끝"), { text: "끝" }]);
      const t4 = lastSend(r4);
      expect(String(t4?.error).includes("카카오 로그인이 끝났습니다. 설정에서 다시 연결하세요") && !JSON.stringify(t4).includes("카카오 오류 원문"), `needs_login 문구(${JSON.stringify(t4)})`);
      expect((await stored(h)).status === "needs_login", "저장 상태 needs_login");
      const status = await optSend(opt, { kind: "kakao_status" });
      expect(status.ok && status.data.needsLogin && !status.data.connected, `설정 상태(${JSON.stringify(status)})`);
      // 다시 로그인 필요 상태에서는 카드 없이 같은 문구로 끝난다.
      await clearKk(h);
      const r5 = await h.turn([send("다시"), { text: "끝" }]);
      expect(r5.cards === 0 && String(lastSend(r5)?.error).includes("카카오 로그인이 끝났습니다") && (await kk(h)).memo.length === 0, `연결 필요(${JSON.stringify(sendLog(r5))})`);
      await noSecrets(h, r4);
    }),
  },
  {
    name: "카카오 연결: state 불일치·talk_message 미동의면 연결하지 않고, 설정 페이지 밖(패널·content script)의 연결·시험 전송은 거절",
    pages: { "/src/options/index.html": `<title>가짜 설정</title><p>웹 문서</p>` },
    run: withKakao(async (h) => {
      const opt = await h.openOptions("model");
      await installKakao(h);
      await optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: CLIENT_SECRET, linkUrl: LINK });
      await h.sw.evaluate(() => {
        globalThis.__kk.badState = true;
      });
      const bad = await optSend(opt, { kind: "kakao_connect" });
      expect(bad?.ok === false && bad.error.includes("응답이 올바르지 않아") && (await kk(h)).tokenReqs.length === 0, `state 불일치(${JSON.stringify(bad)})`);
      expect(!(await stored(h)).accessToken, "저장 안 됨");
      await h.sw.evaluate(() => {
        globalThis.__kk.badState = false;
        globalThis.__kk.tokenScope = "profile_nickname";
      });
      const noScope = await optSend(opt, { kind: "kakao_connect" });
      expect(noScope?.ok === false && noScope.error.includes("카카오톡 메시지 전송에 동의해야 합니다"), `동의 없음(${JSON.stringify(noScope)})`);
      expect(!(await stored(h)).accessToken, "저장 안 됨(동의 없음)");
      // 토큰 응답에 scope가 없으면 동의 내역 조회로 확인한다: 동의하지 않았으면 연결하지 않는다.
      await h.sw.evaluate(() => {
        globalThis.__kk.tokenScope = null;
        globalThis.__kk.scopesAgreed = false;
      });
      // 동의 내역 조회가 실패하면(500) 동의를 요청하지 않고 다시 시도하라고 한다.
      await h.sw.evaluate(() => {
        globalThis.__kk.scopesFail = true;
      });
      const lookupFail = await optSend(opt, { kind: "kakao_connect" });
      expect(lookupFail?.ok === false && lookupFail.error.includes("동의 내역을 확인하지 못해") && !lookupFail.error.includes("동의해야") && !lookupFail.error.includes("원문"), `조회 실패(${JSON.stringify(lookupFail)})`);
      expect(!(await stored(h)).accessToken, "저장 안 됨(조회 실패)");
      await h.sw.evaluate(() => {
        globalThis.__kk.scopesFail = false;
        globalThis.__kk.scopeReqs = 0;
      });
      const noScopeField = await optSend(opt, { kind: "kakao_connect" });
      expect(noScopeField?.ok === false && noScopeField.error.includes("동의해야 합니다") && (await kk(h)).scopeReqs === 1, `scope 없음·미동의(${JSON.stringify(noScopeField)})`);
      expect(!(await stored(h)).accessToken, "저장 안 됨(동의 내역 미동의)");
      // 사용자 정보 조회가 실패하면 연결하지 않는다(카카오 원문 없음).
      await h.sw.evaluate(() => {
        globalThis.__kk.scopesAgreed = true;
        globalThis.__kk.userMeFail = true;
      });
      const meFail = await optSend(opt, { kind: "kakao_connect" });
      expect(meFail?.ok === false && meFail.error.includes("계정 연결을 확인하지 못해") && !meFail.error.includes("원문"), `사용자 정보 실패(${JSON.stringify(meFail)})`);
      expect(!(await stored(h)).accessToken, "저장 안 됨(사용자 정보 실패)");
      // scope가 없어도 동의 내역에서 동의했으면 연결된다.
      await h.sw.evaluate(() => {
        globalThis.__kk.userMeFail = false;
      });
      const viaScopes = await optSend(opt, { kind: "kakao_connect" });
      expect(viaScopes?.ok && viaScopes.data.connected, `동의 내역으로 연결(${JSON.stringify(viaScopes)})`);
      await optSend(opt, { kind: "kakao_disconnect" });
      const flows = (await kk(h)).flows;
      expect(flows.every((f) => f.origin === "https://kauth.kakao.com" && f.path === "/oauth/authorize" && f.clientId === KEY && f.scope === "talk_message" && f.redirect === `https://${h.extId}.chromiumapp.org/`), `인증 주소(${JSON.stringify(flows)})`);

      // 정상 연결 뒤, 설정 페이지에서 보낸 시험 전송은 고정 문구로 간다.
      await h.sw.evaluate(() => {
        globalThis.__kk.tokenScope = "talk_message";
        globalThis.__kk.userMe = 0;
      });
      const ok = await optSend(opt, { kind: "kakao_connect" });
      expect((await kk(h)).userMe === 1, "연결 확정에 사용자 정보 조회");
      expect(ok?.ok && ok.data.connected, `연결(${JSON.stringify(ok)})`);
      await clearKk(h);
      const test1 = await optSend(opt, { kind: "kakao_test_send" });
      expect(test1?.ok && (await memoTexts(h)).join("|") === "간편 브라우저 도우미 연결 시험", `시험 전송(${JSON.stringify(test1)})`);

      // 패널에서 보낸 연결·시험 전송은 거절(OAuth·전송 0).
      await clearKk(h);
      for (const kind of ["kakao_connect", "kakao_test_send", "kakao_status", "kakao_save_keys", "kakao_disconnect"]) {
        const r = await h.panel.evaluate((m) => chrome.runtime.sendMessage(m), { kind, restKey: "x", linkUrl: LINK });
        expect(r?.ok === false && r.error === "허용되지 않은 요청", `패널 ${kind} 거절(${JSON.stringify(r)})`);
      }
      // 웹 문서(content script) — 경로를 설정 페이지와 같게(/src/options/index.html#model) 맞춰 경로만 비교하는 회귀도 잡는다.
      await h.tab.goto(`${h.base}/src/options/index.html#model`);
      await h.tab.waitForTimeout(300);
      const res = await h.sw.evaluate(async (base) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url ?? "").startsWith(`${base}/src/options/`));
        const [out] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async () => {
            const r = [];
            for (const kind of ["kakao_connect", "kakao_test_send", "kakao_status"]) r.push(await chrome.runtime.sendMessage({ kind }));
            return r;
          },
        });
        return out.result;
      }, h.base);
      expect(Array.isArray(res) && res.length === 3 && res.every((x) => x?.ok === false && x.error === "허용되지 않은 요청"), `content script 거절(${JSON.stringify(res)})`);
      const st = await kk(h);
      expect(st.flows.length === 0 && st.tokenReqs.length === 0 && st.memo.length === 0, `OAuth·전송 0(${JSON.stringify({ f: st.flows.length, t: st.tokenReqs.length, m: st.memo.length })})`);
      expect((await stored(h)).accessToken, "연결은 그대로");
    }),
  },
  {
    name: "카카오 연결: 로그인 창이 열린 채로도 연결 끊기는 끝나고, 늦게 끝난 옛 로그인은 저장되지 않으며, 역순 완료에서는 마지막 시도만 저장",
    run: withKakao(async (h) => {
      const opt = await h.openOptions("model");
      await installKakao(h);
      await optSend(opt, { kind: "kakao_save_keys", restKey: KEY, clientSecret: CLIENT_SECRET, linkUrl: LINK });
      await h.sw.evaluate(() => {
        globalThis.__kk.hold = true;
      });
      const held = (n) => waitUntil(async () => (await h.sw.evaluate(() => globalThis.__kk.held.length)) >= n, { label: `보류한 로그인 ${n}개` });
      const release = (code) => h.sw.evaluate((c) => globalThis.__kk.held.find((x) => x.code === c).release(), code);

      // 1) A 보류 → 끊기가 바로 끝난다 → A를 풀면 저장되지 않는다.
      const a = optSend(opt, { kind: "kakao_connect" });
      await held(1);
      const t0 = Date.now();
      const d = await optSend(opt, { kind: "kakao_disconnect" });
      expect(d?.ok && Date.now() - t0 < 3000, `끊기가 끝남(${Date.now() - t0}ms, ${JSON.stringify(d)})`);
      await release("C1");
      const ra = await a;
      expect(ra?.ok === false && ra.error.includes("이 로그인은 쓰지 않았습니다"), `늦은 로그인 거절(${JSON.stringify(ra)})`);
      expect(!(await stored(h)).accessToken, "저장 안 됨");

      // 2) B 보류, C 보류 → C 먼저 완료(저장) → B 나중 완료(버림). 저장은 C의 토큰.
      const b = optSend(opt, { kind: "kakao_connect" });
      await held(2);
      const c = optSend(opt, { kind: "kakao_connect" });
      await held(3);
      await release("C3");
      const rc = await c;
      expect(rc?.ok && rc.data.connected, `마지막 시도 저장(${JSON.stringify(rc)})`);
      await release("C2");
      const rb = await b;
      expect(rb?.ok === false, `앞 시도 거절(${JSON.stringify(rb)})`);
      const s = await stored(h);
      expect(s.accessToken === "fake-access-C3" && s.refreshToken === "fake-refresh-C3", `C의 토큰(${s.accessToken})`);

      // 3) 코드 교환 응답을 기다리는 사이 끊으면, 교환이 끝나도 뒤따르는 사용자 정보 조회를 부르지 않고 저장하지 않는다.
      await h.sw.evaluate(() => {
        globalThis.__kk.hold = false;
        globalThis.__kk.holdToken = true;
        globalThis.__kk.userMe = 0;
      });
      const before = (await kk(h)).tokenReqs.length;
      const e = optSend(opt, { kind: "kakao_connect" });
      await waitUntil(async () => (await kk(h)).tokenReqs.length > before, { label: "코드 교환 요청" });
      const d2 = await optSend(opt, { kind: "kakao_disconnect" });
      expect(d2?.ok, "교환 중 끊기");
      await h.sw.evaluate(() => {
        globalThis.__kk.holdToken = false;
        globalThis.__kk.releaseToken?.();
      });
      const re = await e;
      expect(re?.ok === false && re.error.includes("이 로그인은 쓰지 않았습니다"), `교환 뒤 거절(${JSON.stringify(re)})`);
      expect((await kk(h)).userMe === 0, "사용자 정보 조회를 부르지 않음");
      expect(!(await stored(h)).accessToken, "저장 안 됨(교환 중 끊기)");
    }),
  },
  {
    name: "send_to_kakao: 텔레그램·MCP 원격 차단은 공유 시험(remoteBlockedCalls)에 들어 있다",
    async run(h) {
      const { remoteBlockedCalls } = await import("./telegram.mjs");
      expect(remoteBlockedCalls(h).some((c) => c.tool === "send_to_kakao"), "원격 차단 목록에 send_to_kakao");
    },
  },
  {
    name: "send_to_kakao: 자동 로그인 값은 카드·보낸 글 모두 가리고, 가린 뒤 넘치는 글은 카드 없이 too_long(새 워커 — 가림 목록을 미리 넣음)",
    isolate: true,
    onWorker: (sw) => sw.evaluate((v) => chrome.storage.session.set({ loginSecrets: { t1: [v, "Pw9x"] } }).then(() => true), SECRET),
    async run(h) {
      await connect(h);
      let cardText = "";
      const r = await h.turn([send(`로그인 값 ${SECRET} 이 보임`), { text: "끝" }], {
        onCard: async (card) => {
          cardText = await card.innerText();
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1 && !cardText.includes(SECRET) && cardText.includes("[가린 값]"), `카드는 가린 글(${cardText.slice(0, 160)})`);
      expect((await memoTexts(h)).join("|") === "로그인 값 [가린 값] 이 보임", `가린 글로 보냄(${await memoTexts(h)})`);
      expect(!(await h.panel.evaluate((s) => document.body.innerText.includes(s), SECRET)), "패널 화면에 값 없음");

      // 원문 1000자(스키마 통과)지만 가리면 1400자 → 카드 없이 too_long.
      await clearKk(h);
      const r2 = await h.turn([send("Pw9x ".repeat(200)), { text: "끝" }]);
      const t = lastSend(r2);
      expect(r2.cards === 0 && String(t?.error).includes("카카오톡은 한 메시지 200자, 5개(1000자)까지입니다. 요약해서 다시 보내세요."), `too_long(${JSON.stringify(t)})`);
      // 원문 1001자는 스키마가 거절.
      const r3 = await h.turn([send("a".repeat(1001)), { text: "끝" }]);
      expect(r3.cards === 0 && String(lastSend(r3)?.error).includes("인자 검증 실패"), `1001자 거절(${JSON.stringify(sendLog(r3))})`);
      expect((await kk(h)).memo.length === 0, "전송 0");
    },
  },
  {
    name: "카카오 연결 권한: 기본 빌드는 identity가 선택 권한이고, 거절하면 연결하지 않으며, 허용 뒤 연결돼도 Google 도구는 꺼진 그대로",
    isolate: true,
    async run(h) {
      const mf = await h.sw.evaluate(() => chrome.runtime.getManifest());
      expect(!(mf.permissions ?? []).includes("identity") && (mf.optional_permissions ?? []).includes("identity") && !mf.oauth2, `권한(${JSON.stringify({ p: mf.permissions, o: mf.optional_permissions })})`);
      expect(await h.sw.evaluate(() => typeof chrome.identity === "undefined"), "권한 전 identity 없음");
      const opt = await h.openOptions("model");
      expect((await opt.locator("code", { hasText: `https://${h.extId}.chromiumapp.org/` }).count()) === 1, "권한 없이도 리다이렉트 URI가 보인다");
      // 키 칸에 넣고 저장(화면 동작) — 저장 뒤 칸은 가려진다.
      await opt.getByLabel("REST API 키").fill(KEY);
      await opt.getByLabel("메시지 링크 주소").fill(LINK);
      await opt.locator(".field", { hasText: "카카오톡 나에게 보내기" }).getByRole("button", { name: "저장" }).click();
      await opt.getByRole("button", { name: "카카오 연결" }).waitFor({ timeout: 5000 });
      expect(!(await opt.evaluate((k) => document.body.innerText.includes(k) || [...document.querySelectorAll("input")].some((i) => i.value === k), KEY)), "저장 뒤 키가 보이지 않음");

      // 1) 권한 거절 → 연결 메시지를 보내지 않는다.
      await opt.evaluate(() => {
        chrome.permissions.request = async () => false;
      });
      const before = h.logs.length;
      await opt.getByRole("button", { name: "카카오 연결" }).click();
      await opt.getByText("권한이 없어 연결하지 않았습니다.").waitFor({ timeout: 5000 });
      await opt.waitForTimeout(300);
      expect(!h.logs.slice(before).some((l) => l.startsWith("[SBP kakao:connect]")), `연결 시도 없음(${h.logs.slice(before).join(" | ")})`);
      expect(!(await h.sw.evaluate(async () => (await chrome.storage.local.get("kakao")).kakao?.accessToken)), "연결 안 됨");

      // 1-1) 권한 요청이 예외를 던져도 같은 안내로 끝나고 연결 메시지를 보내지 않는다(#319 특성 시험).
      await opt.evaluate(() => {
        chrome.permissions.request = async () => {
          throw new Error("This function must be called during a user gesture");
        };
      });
      const beforeThrow = h.logs.length;
      await opt.getByRole("button", { name: "카카오 연결" }).click();
      await opt.getByText("권한이 없어 연결하지 않았습니다.").waitFor({ timeout: 5000 });
      await opt.waitForTimeout(300);
      expect(!h.logs.slice(beforeThrow).some((l) => l.startsWith("[SBP kakao:connect]")), "권한 요청 예외: 연결 시도 없음");
      expect(!(await opt.evaluate(() => document.body.innerText.includes("user gesture"))), "권한 요청 예외의 글은 화면에 없음");

      // 2) 권한 허용(대역 — 워커에 identity를 건다) → 연결된다.
      await installKakao(h);
      await opt.evaluate(() => {
        chrome.permissions.request = async () => true;
      });
      await opt.getByRole("button", { name: "카카오 연결" }).click();
      await opt.getByText("● 연결됨", { exact: false }).waitFor({ timeout: 5000 });
      const g = await optSend(opt, { kind: "google_status" });
      expect(g?.ok && g.data.configured === false && g.data.connected === false, `Google 도구는 꺼진 그대로(${JSON.stringify(g)})`);
      // 패널 요청에도 Google 도구가 실리지 않는다.
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.turn([{ text: "끝" }]);
      const tools = await h.sw.evaluate(() => (globalThis.__modelReqs ?? []).flatMap((q) => (q.body?.tools ?? []).map((t) => t.function?.name ?? t.name)));
      expect(tools.includes("send_to_kakao") && !tools.some((n) => String(n).startsWith("google_")), `도구 목록(${tools.filter((n) => /kakao|google/.test(n)).join(",")})`);
    },
  },
];
