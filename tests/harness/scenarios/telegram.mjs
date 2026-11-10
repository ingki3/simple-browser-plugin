// 텔레그램 연동(#139): 서비스 워커의 fetch로 api.telegram.org를 흉내 낸다(받을 업데이트·보낸 메시지를 전역에 둔다).
// 확인 코드 연결 → 요청 → 최종 답만, 허용 밖 채팅·오래된 메시지 무시, 원격 요청은 전역 실행 방식과 관계없이 '처음에 승인 받고
// 끝까지 실행'(요청마다 텔레그램 버튼으로 한 번 맡길지 묻는다 — 묻기를 끄면 auto 판정이고 카드가 필요한 동작은 거절), 반복 작업 알림은 켰을 때 제목만(확인 결과 요약은 따로 켤 때만, #209).
import { ask, expect, waitUntil } from "../lib.mjs";
import { checkRemoteHandoffRefused, installHandoffObserver, markTurnStart, remoteTabAt, restoreHandoffObserver } from "../handoffObserve.mjs";

const TOKEN = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHAT = 7001;

export async function installTelegram(h) {
  await h.sw.evaluate(() => {
    globalThis.__tg = { updates: [], sent: [], calls: [], nextId: 1 };
    const prev = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (!u.startsWith("https://api.telegram.org/")) return prev(url, init);
      const method = u.split("/").pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      globalThis.__tg.calls.push(method);
      const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
      if (method === "getMe") return ok({ id: 1, is_bot: true, username: "test_bot" });
      if (method === "sendMessage") {
        // rateLimitNext(#145): 다음 한 번은 429(retry_after 2초)로 거절한다.
        if (globalThis.__tg.rateLimitNext) {
          globalThis.__tg.rateLimitNext = false;
          globalThis.__tg.limited = (globalThis.__tg.limited ?? 0) + 1;
          return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429, headers: { "content-type": "application/json" } });
        }
        // failAfter(#210): 그만큼 받은 뒤 다음 한 번은 500으로 거절한다(중간 조각 실패).
        if (typeof globalThis.__tg.failAfter === "number") {
          if (globalThis.__tg.failAfter <= 0) {
            globalThis.__tg.failAfter = undefined;
            globalThis.__tg.failed = (globalThis.__tg.failed ?? 0) + 1;
            return new Response(JSON.stringify({ ok: false, error_code: 500, description: "서버 오류 원문" }), { status: 500, headers: { "content-type": "application/json" } });
          }
          globalThis.__tg.failAfter -= 1;
        }
        // holdReply(#145): 승인 질문이 아닌 글의 응답을 늦춘다(중단 신호를 따른다).
        if (!body.reply_markup && globalThis.__tg.holdReply) {
          globalThis.__tg.holding = true;
          await Promise.race([
            globalThis.__tg.holdReply,
            new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
          ]);
          globalThis.__tg.holding = false;
        }
        globalThis.__tg.sent.push(body);
        const id = globalThis.__tg.sent.length;
        // 승인 질문(#185): 버튼 데이터를 남기고, holdAsk가 있으면 응답을 늦춘다(버튼이 응답보다 먼저 오는 경우).
        if (body.reply_markup) {
          (globalThis.__tg.asks ??= []).push(body);
          if (globalThis.__tg.holdAsk) {
            // 실제 fetch처럼 중단 신호를 따른다.
            await Promise.race([
              globalThis.__tg.holdAsk,
              new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
            ]);
          }
        }
        return ok({ message_id: id });
      }
      if (method === "editMessageText" || method === "answerCallbackQuery") (globalThis.__tg.edits ??= []).push({ method, body });
      if (method === "getUpdates") {
        const take = () => globalThis.__tg.updates.filter((x) => x.update_id >= (body.offset ?? 0));
        if (!take().length && body.timeout) await new Promise((r) => setTimeout(r, 300));
        // 기다리는 사이 들어온 업데이트도 돌려준다(버리지 않음).
        const ready = take();
        globalThis.__tg.updates = [];
        return ok(ready);
      }
      return ok(true);
    };
  });
}

// 업데이트 하나를 넣고 받기를 부른다.
export async function deliver(h, text, { chat = CHAT, from = chat, ageS = 0 } = {}) {
  await h.sw.evaluate(
    async ({ text, chat, from, ageS }) => {
      const id = globalThis.__tg.nextId++;
      globalThis.__tg.updates.push({ update_id: id, message: { message_id: id, chat: { id: chat, type: "private", username: "me" }, from: { id: from }, text, date: Math.floor(Date.now() / 1000) - ageS } });
      await globalThis.__sbpTelegram.poll();
    },
    { text, chat, from, ageS },
  );
}

// 버튼 누르기(callback_query). chat·from을 바꿔 다른 채팅·다른 사람의 누름을 흉내 낸다.
export async function press(h, data, { chat = CHAT, from = chat, poll = true } = {}) {
  await h.sw.evaluate(
    async ({ data, chat, from, poll }) => {
      const id = globalThis.__tg.nextId++;
      globalThis.__tg.updates.push({ update_id: id, callback_query: { id: `q${id}`, data, from: { id: from }, message: { message_id: 1, chat: { id: chat, type: "private" } } } });
      if (poll) await globalThis.__sbpTelegram.poll();
    },
    { data, chat, from, poll },
  );
}

export const asks = (h) => h.sw.evaluate(() => (globalThis.__tg.asks ?? []).map((b) => ({ text: b.text, yes: b.reply_markup.inline_keyboard[0][0].callback_data, no: b.reply_markup.inline_keyboard[0][1].callback_data })));

// read()가 n개 이상을 돌려줄 때까지 기다려 그 목록을 돌려준다(#262 — 예전엔 모자라도 그대로 돌려줬다). 안 되면 지금 개수를 담아 실패.
const waitCount = (read, n, ms, intervalMs, what) =>
  waitUntil(
    async () => {
      const list = await read();
      return list.length >= n && list;
    },
    { timeoutMs: ms, intervalMs, label: `텔레그램 ${what} ${n}개`, detail: async () => `지금 ${(await read()).length}개` },
  );

export const waitAsk = (h, n = 1, ms = 15_000) => waitCount(() => asks(h), n, ms, 200, "승인 질문");

// 텔레그램으로 보낸 글 중 승인 질문이 아닌 것(최종 답·안내).
export const replies = (h) => h.sw.evaluate(() => globalThis.__tg.sent.filter((m) => !m.reply_markup).map((m) => m.text));

const waitReply = (h, n = 1, ms = 20_000) => waitCount(() => replies(h), n, ms, 250, "답");

const toolLog = (h) => h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));

const sent = (h) => h.sw.evaluate(() => globalThis.__tg.sent.map((m) => m.text));

export async function connect(h) {
  await installTelegram(h);
  const saved = await ask(h, { kind: "telegram_save_token", token: TOKEN });
  expect(saved.ok && saved.data.botName === "@test_bot" && !("token" in saved.data), `토큰 저장(${JSON.stringify(saved)})`);
  const pair = await ask(h, { kind: "telegram_pair" });
  const code = pair.data.pairingCode;
  expect(/^\d{6}$/.test(code), "확인 코드");
  await deliver(h, "000000", { chat: 9999 });
  await deliver(h, code);
  const st = await ask(h, { kind: "telegram_status" });
  expect(st.data.connected && st.data.chatLabel === "@me", `연결(${JSON.stringify(st.data)})`);
  await h.sw.evaluate(() => {
    globalThis.__tg.sent = [];
  });
}

// 시험 서버 주소(localhost·IP)는 요청 글의 사이트로 인정하지 않으므로, 원격 대화의 새 작업 탭을 시험 페이지로 연다.
async function startTabAt(h, url) {
  await h.sw.evaluate((url) => {
    const realCreate = chrome.tabs.create.bind(chrome.tabs);
    // 다 읽힌 뒤 돌려준다 — 실제 새 탭 화면처럼 시작 주소를 바로 읽을 수 있게(느린 CI에서 빈 주소로 읽히던 경합).
    chrome.tabs.create = async (p) => {
      if (p?.url !== "chrome://newtab/") return realCreate(p);
      const tab = await realCreate({ ...p, url });
      for (let i = 0; i < 50; i++) {
        const t = await chrome.tabs.get(tab.id);
        if (t.url === url && !t.pendingUrl && t.status === "complete") return t;
        await new Promise((r) => setTimeout(r, 100));
      }
      return tab;
    };
  }, url);
}

// 지난 요청의 작업 탭을 옮긴다(사용자가 옮긴 것처럼) — 같은 대화의 다음 요청이 그 탭을 새 탭 화면으로 되돌려 쓰지 않고
// 새 작업 탭(startTabAt의 시험 페이지)을 열게.
async function moveWorkTabs(h) {
  await h.sw.evaluate(async (base) => {
    for (const t of await chrome.tabs.query({})) if (t.url?.startsWith(base)) await chrome.tabs.update(t.id, { url: `${base}/?moved=${t.id}` });
  }, h.base2);
  await h.panel.waitForTimeout(500);
}

const tabTitles = (h) => h.sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.title).join("|"));

const waitSent = (h, n, ms = 15_000) => waitCount(() => sent(h), n, ms, 250, "보낸 글");

// 원격 요청에서 쓰지 않는 도구(#263 단계 0 — chatAgent.ts REMOTE_BLOCKED_TOOLS, remember_page는 위 시나리오가 따로 본다).
// send_to_telegram(#210): 원격 요청이 연결한 텔레그램으로 글을 내보내지 않는다(작업을 맡긴 뒤는 telegram-send.mjs가 본다).
// 인자는 해석을 통과하는 가짜 값이다(차단은 해석 뒤·승인 앞에서 한다). telegram·mcp 시나리오가 함께 쓴다.
export const remoteBlockedCalls = (h) => [
  { tool: "sign_in", args: { id: "f0-blocked" } },
  { tool: "open_saved_link", args: { id: "saved-blocked" } },
  {
    tool: "schedule_repeat_task",
    args: { title: "막힘 확인", url: `${h.base2}/watch`, check: "열렸는지", then: "알려 줘", intervalMinutes: 30 },
  },
  { tool: "send_to_telegram", args: { text: "원격에서 보내기 시도" } },
];

// 한 원격 요청(턴)의 결과를 본다: 차단 도구는 승인 경로(카드·원격 질문)에 닿기 전에 취소된다.
// - 모델에 간 결과: remote_needs_approval(원격 안내 note 포함), 마지막 요청은 도구 없는 마무리(tool_choice none)
// - 카드 대기 가로채기(remote:refuse)·반복 작업 대기(tool:awaiting_repeat)·로그인 정보 조회 로그가 없다(그 경로로 갔다면 같은 오류라도 이 줄이 남는다)
// - 패널에 카드 없음, 반복 작업·이동 없음
// from: 턴 전의 { logs, hits } 길이(h.logs·h.hits는 하네스가 시나리오 사이에 비우지 않으므로 이 턴 몫만 본다).
export async function checkRemoteBlocked(h, tool, from) {
  const t = await h.sw.evaluate((name) => [...globalThis.__toolLog].reverse().find((x) => x.name === name) ?? null, tool);
  expect(t && t.error === "remote_needs_approval" && t.result === undefined && String(t.note ?? "").includes("원격(텔레그램·MCP)"), `${tool} 원격 차단 결과(${JSON.stringify(t)})`);
  const last = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1)?.body?.tool_choice ?? null);
  expect(last === "none", `${tool} 뒤 마무리 요청(${JSON.stringify(last)})`);
  const lines = h.logs.slice(from.logs);
  const bad = lines.filter((l) => /\[SBP (remote:refuse|remote:ask|remote:task_needed|tool:awaiting_[a-z]+|tool:auto_approved|tool:remote_approved|tool:task_run|tool:handoff|login:)/.test(l));
  expect(!bad.length, `${tool}: 승인·실행 경로에 닿지 않음(${bad.join(" | ")})`);
  expect((await h.panel.locator(".tool-pending").count()) === 0, `${tool}: 패널 카드 없음`);
  const tasks = await h.sw.evaluate(async () => (await chrome.storage.local.get("repeatTasks")).repeatTasks ?? []);
  expect(!tasks.length, `${tool}: 반복 작업 없음(${tasks.length})`);
  expect(!h.hits.slice(from.hits).some((x) => x.includes("/watch")), `${tool}: 확인할 페이지를 열지 않음`);
}

export default [
  {
    name: "원격 요청이 직접 조작할 사이트에서 클릭하면 손 넘기기 카드 대신 거절로 풀리고 표시·감시를 거둔다(텔레그램, 묻기 끔 — #263 단계 5)",
    pages2: { "/m": `<title>예매</title><main><button style="width:160px;height:50px" onclick="document.getElementById('out').textContent='눌림'">조회하기</button><p id=out></p></main>` },
    async run(h) {
      await connect(h);
      expect((await ask(h, { kind: "telegram_set_ask", on: false })).ok, "묻기 끔");
      await h.settings({ manualSites: [h.base2] });
      const url = `${h.base2}/m`;
      const unTab = await remoteTabAt(h, url);
      await installHandoffObserver(h);
      try {
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "조회하기" }, { text: "못 함" }];
          globalThis.__toolLog = [];
          globalThis.__modelReqs = [];
          globalThis.__tg.asks = [];
        });
        const from = h.logs.length;
        await markTurnStart(h);
        await deliver(h, "조회하기 눌러 줘");
        // 대기 등록이 거절 타이머 뒤로 밀리면 거절이 닿지 않아 손 넘기기가 끝나지 않는다(만료는 이 한도보다 길다).
        await waitReply(h, 1, 8_000);
        expect((await asks(h)).length === 0, "텔레그램 승인 질문 없음");
        await checkRemoteHandoffRefused(h, { from, url });
      } finally {
        await restoreHandoffObserver(h);
        await unTab();
      }
    },
  },
  {
    name: "명령 응답(#145): 429로 기다리는 중 연결을 끊으면 다시 보내지 않는다",
    async run(h) {
      await connect(h);
      await h.sw.evaluate(() => {
        globalThis.__tg.rateLimitNext = true;
      });
      const pending = deliver(h, "/help");
      await h.panel.waitForTimeout(500);
      const off = await ask(h, { kind: "telegram_disconnect" });
      expect(off.ok, "연결 끊기");
      await pending;
      await h.panel.waitForTimeout(2500);
      const s = await sent(h);
      expect((await h.sw.evaluate(() => globalThis.__tg.limited)) === 1 && !s.some((t) => t.includes("텔레그램 연동")), `다시 보내지 않음(${JSON.stringify(s)})`);
    },
  },
  {
    name: "답 보내기(#145·#222): 보내는 동안 서비스 워커를 붙잡고(알람과 20초마다 확장 API 호출), 끝나면 놓는다 — 열린 설정 화면의 최근 요청도 바뀐다",
    async run(h) {
      await connect(h);
      const opts = await h.openOptions("model");
      // 확장 API 호출(getPlatformInfo)을 센다(#222 — 30초 알람이 1분으로 올림되는 Chrome 116~119에서도 붙잡는지).
      await h.sw.evaluate(() => {
        const orig = chrome.runtime.getPlatformInfo.bind(chrome.runtime);
        globalThis.__pings = 0;
        chrome.runtime.getPlatformInfo = (...a) => {
          globalThis.__pings += 1;
          return orig(...a);
        };
      });
      await h.sw.evaluate(() => {
        globalThis.__tg.holdReply = new Promise((r) => (globalThis.__tg.release = r));
        globalThis.__steps = [{ text: "붙잡은 답" }];
      });
      await deliver(h, "느린 답 요청");
      await waitUntil(() => h.sw.evaluate(() => globalThis.__tg.holding), { timeoutMs: 15_000, intervalMs: 200, label: "답을 보내는 중" });
      const during = await h.sw.evaluate(async () => !!(await chrome.alarms.get("openrouter-heartbeat")));
      expect(during, "보내는 동안 keepalive 알람");
      const pings = () => h.sw.evaluate(() => globalThis.__pings);
      const first = await pings();
      expect(first >= 1, `붙잡자마자 확장 API 호출(${first})`);
      await h.panel.waitForTimeout(21_000);
      const later = await pings();
      expect(later >= first + 1, `20초 뒤 다시 호출(${first}→${later})`);
      await h.sw.evaluate(() => {
        globalThis.__tg.holdReply = null;
        globalThis.__tg.release();
      });
      const r = await waitReply(h, 1);
      expect(r.includes("붙잡은 답"), `답(${JSON.stringify(r)})`);
      await waitUntil(async () => !(await h.sw.evaluate(async () => !!(await chrome.alarms.get("openrouter-heartbeat")))), { timeoutMs: 5000, intervalMs: 200, label: "끝나면 keepalive를 놓음" });
      const released = await pings();
      await h.panel.waitForTimeout(21_000);
      expect((await pings()) === released, "놓은 뒤에는 호출하지 않음");
      // 오래 열어 둔 설정 화면이 최근 요청(recent)을 다시 읽는다.
      await waitUntil(async () => (await opts.locator("body").innerText()).includes("느린 답 요청"), { timeoutMs: 5000, intervalMs: 200, label: "설정 화면의 최근 요청" });
    },
  },
  {
    name: "확인 코드로 연결하고, 요청에는 최종 답만 보낸다(허용 밖 채팅·오래된 메시지는 실행하지 않음)",
    async run(h) {
      await connect(h);
      await deliver(h, "몰래 시키기", { chat: 9999 });
      await deliver(h, "오래된 요청", { ageS: 3600 });
      let s = await waitSent(h, 1, 3000);
      expect(s.length === 1 && s[0].includes("오래된 요청이라"), `오래된 메시지 안내만(${JSON.stringify(s)})`);
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__steps = [{ text: "오늘은 맑습니다." }];
      });
      await deliver(h, "날씨 알려 줘");
      s = await waitSent(h, 1);
      expect(s.length === 1 && s[0] === "오늘은 맑습니다.", `최종 답(${JSON.stringify(s)})`);
      const st = await ask(h, { kind: "telegram_status" });
      expect(st.data.recent[0]?.status === "done", "최근 요청 기록");
      expect((await h.panel.locator(".bubble-user").count()) === 0, "패널 대화에는 보이지 않음");
    },
  },
  {
    name: "원격 요청은 전역이 auto여도 '처음에 승인 받고 끝까지 실행': confirm_task를 텔레그램으로 한 번 묻고, 맡기면 결제까지 묻지 않음, 다음 요청은 다시 묻는다",
    pages2: {
      "/": `<title>shop</title><button onclick="document.title='결제됨'">결제하기</button><button onclick="document.title='적용됨'">적용</button>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      await connect(h);
      await startTabAt(h, `${h.base2}/`);
      await h.sw.evaluate(() => {
        globalThis.__steps = [
          { tool: "confirm_task", args: { summary: "적용을 누른 뒤 결제", risks: ["결제가 진행됩니다"] } },
          { tool: "find_clickables", args: {} },
          { click: "적용" },
          { tool: "find_clickables", args: {} },
          { click: "결제하기" },
          { text: "다 했습니다" },
        ];
        globalThis.__toolLog = [];
      });
      await deliver(h, "적용 누르고 결제해 줘");
      const [q] = await waitAsk(h, 1, 20_000);
      expect(
        q?.text.startsWith("승인이 필요합니다: 작업 맡기기") && q.text.includes("요청: 적용 누르고 결제해 줘") && q.text.includes("할 일: 적용을 누른 뒤 결제") && q.text.includes("- 결제가 진행됩니다"),
        `맡기기 질문(${q?.text})`,
      );
      await h.panel.waitForTimeout(300);
      expect((await toolLog(h)).length === 0, "승인 전에는 실행 안 함");
      await press(h, q.yes);
      const r = await waitReply(h);
      const log = await toolLog(h);
      expect(r[0] === "다 했습니다", `최종 답(${JSON.stringify(r)})`);
      expect(log.join(",") === "confirm_task:ok,find_clickables:ok,click_element:ok,find_clickables:ok,click_element:ok", `묻지 않고 끝까지(${log.join(", ")})`);
      expect((await asks(h)).length === 1, "질문은 한 번");
      expect((await h.panel.locator(".tool-pending").count()) === 0, "패널에 카드 없음");
      expect((await tabTitles(h)).includes("결제됨"), "결제까지 눌림");

      // 같은 대화의 다음 요청: 맡긴 작업은 그 요청까지만 — 맡기지 않고 부른 첫 동작으로 다시 묻는다. 거절하면 하지 않는다.
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "적용" }, { text: "안 함" }];
        globalThis.__toolLog = [];
      });
      await moveWorkTabs(h);
      await deliver(h, "적용 다시 눌러 줘");
      const all = await waitAsk(h, 2);
      const q2 = all[1];
      expect(q2?.text.includes("작업 맡기기") && q2.text.includes("첫 동작: 클릭") && q2.text.includes("'적용'") && !q2.text.includes("할 일:"), `다시 묻기(${q2?.text})`);
      await press(h, q2.no);
      const r2 = await waitReply(h);
      const log2 = await toolLog(h);
      // (첫 기록은 앞 요청의 마지막 도구 결과다 — 모의 모델이 요청마다 마지막 결과를 남긴다.)
      expect(log2.at(-1) === "click_element:remote_user_denied" && !(await tabTitles(h)).includes("적용됨"), `거절(${log2.join(",")})`);
      expect(r2.length === 1 && r2[0] === "정리", `도구 없이 마무리(${JSON.stringify(r2)})`);
    },
  },
  {
    name: "원격 task: confirm_task를 거절하면 하지 않고, 맡긴 뒤 묻기를 껐다 켜면 맡긴 작업이 풀려 다시 묻는다",
    pages2: { "/": `<title>shop</title><button onclick="document.title='적용됨'">적용</button>` },
    async run(h) {
      await connect(h);
      await startTabAt(h, `${h.base2}/`);
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ tool: "confirm_task", args: { summary: "적용 누르기", risks: [] } }, { text: "안 함" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "적용 눌러 줘");
      const [q] = await waitAsk(h);
      expect(q?.text.includes("이 작업의 위험: 모델이 따로 적지 않음"), `위험 없음 문구(${q?.text})`);
      await press(h, q.no);
      const r = await waitReply(h);
      expect((await toolLog(h)).join(",") === "confirm_task:remote_user_denied" && r[0] === "정리", `거절(${(await toolLog(h)).join(",")} / ${JSON.stringify(r)})`);

      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__steps = [
          { tool: "confirm_task", args: { summary: "적용 누르기", risks: [] } },
          { tool: "find_clickables", args: {}, delayMs: 1500 },
          { click: "적용" },
          { text: "안 함" },
        ];
        globalThis.__toolLog = [];
      });
      await moveWorkTabs(h);
      await deliver(h, "적용 눌러 줘");
      const a = await waitAsk(h, 2);
      await press(h, a[1].yes);
      // 맡긴 직후(다음 모델 응답을 기다리는 사이) 묻기를 껐다 켠다.
      await h.panel.waitForTimeout(300);
      expect((await ask(h, { kind: "telegram_set_ask", on: false })).ok, "끔");
      expect((await ask(h, { kind: "telegram_set_ask", on: true })).ok, "켬");
      const b = await waitAsk(h, 3);
      expect(b[2]?.text.includes("첫 동작: 클릭") && b[2].text.includes("'적용'"), `다시 묻기(${b[2]?.text})`);
      await press(h, b[2].no);
      await waitReply(h);
      const log = await toolLog(h);
      expect(log.includes("click_element:remote_user_denied") && !log.includes("click_element:ok"), `되살아나지 않음(${log.join(",")})`);
      expect(!(await tabTitles(h)).includes("적용됨"), "누르지 않음");
    },
  },
  {
    name: "원격 요청에서는 remember_page를 쓰지 않는다(패널 카드 없음)",
    pages2: { "/": `<title>shop</title><p>상품</p>` },
    async run(h) {
      await connect(h);
      await startTabAt(h, `${h.base2}/?q=1`);
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ tool: "remember_page", args: {} }, { text: "못 함" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "이 페이지 기억해줘");
      await waitSent(h, 1, 20_000);
      const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
      expect(log[0]?.startsWith("remember_page:") && !log[0].endsWith(":ok"), `거절(${log.join(", ")})`);
      expect((await h.panel.locator(".page-offer").count()) === 0, "패널에 저장 카드 없음");
    },
  },
  {
    name: "원격 요청에서는 sign_in·open_saved_link·schedule_repeat_task·send_to_telegram을 쓰지 않는다(텔레그램 질문·패널 카드 없음)",
    pages2: { "/": `<title>shop</title><p>상품</p>` },
    async run(h) {
      await connect(h);
      await startTabAt(h, `${h.base2}/?q=1`);
      let n = 0;
      for (const call of remoteBlockedCalls(h)) {
        await h.sw.evaluate((c) => {
          globalThis.__steps = [c, { text: "못 함" }];
          globalThis.__toolLog = [];
        }, call);
        const from = { logs: h.logs.length, hits: h.hits.length };
        await deliver(h, `${call.tool} 해 줘`);
        n += 1;
        await waitSent(h, n, 20_000);
        await checkRemoteBlocked(h, call.tool, from);
      }
      expect((await asks(h)).length === 0, "텔레그램 승인 질문 없음");
    },
  },
  {
    name: "원격 안내: 물을 수 있으면 작업 맡기기 안내, 묻기를 끄면 요청 글에 적은 사이트를 알린다(없으면 주소를 함께 보내 달라고 답하게)",
    async run(h) {
      await connect(h);
      // 이번 요청의 원격 안내(원격 요청 표시가 있는 마지막 사용자 메시지)를 읽는다.
      const lastUser = () =>
        h.sw.evaluate(() => {
          const msgs = globalThis.__modelReqs.flatMap((r) => r.body?.messages ?? []);
          const text = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
          const u = [...msgs].reverse().find((m) => m.role === "user" && text(m).includes("원격 요청"));
          return u ? text(u) : "";
        });
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
        globalThis.__steps = [{ text: "정리" }];
      });
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      await waitSent(h, 1);
      let note = await lastUser();
      expect(note.includes("처음에 승인 받고 끝까지 실행") && note.includes("confirm_task") && note.includes("알맞은 사이트를 골라"), `맡기기 안내(${note.slice(0, 400)})`);
      const taskNote = await h.sw.evaluate(() =>
        globalThis.__modelReqs.flatMap((r) => r.body?.messages ?? []).some((m) => m.role === "user" && String(m.content).startsWith("실행 방식: 처음에 승인 받고 끝까지 실행")),
      );
      expect(taskNote, "요청마다 붙는 실행 방식 안내");
      expect((await ask(h, { kind: "telegram_set_ask", on: false })).ok, "묻기 끔");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__modelReqs = [];
        globalThis.__steps = [{ text: "정리" }];
      });
      await deliver(h, "news.naver.com 경제 뉴스 정리해줘");
      await waitSent(h, 1);
      note = await lastUser();
      expect(note.includes("https://news.naver.com") && note.includes("승인 없이 이동할 수 있다") && !note.includes("confirm_task"), `적은 사이트 안내(${note.slice(0, 400)})`);
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__modelReqs = [];
        globalThis.__steps = [{ text: "주소를 알려 주세요" }];
      });
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      await waitSent(h, 1);
      note = await lastUser();
      expect(note.includes("사이트 주소가 없어 다른 사이트로는 이동할 수 없다"), `주소 없음 안내(${note.slice(0, 400)})`);
    },
  },
  {
    name: "원격 승인(#185): 주소 없는 요청의 이동은 텔레그램 버튼으로 묻고, 승인하면 이동한다(다른 채팅·지난 id·중복은 무시)",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      await connect(h);
      await h.sw.evaluate((url) => {
        globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "정리했습니다" }];
        globalThis.__toolLog = [];
      }, `${h.base}/news`);
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      const [a] = await waitAsk(h);
      // confirm_task 없이 부른 이동: 작업 맡기기 질문에 첫 동작(주소)을 보인다.
      expect(a && a.text.includes("승인이 필요합니다: 작업 맡기기") && a.text.includes(`첫 동작: 페이지 이동\n주소: ${h.base}/news`), `질문(${a?.text})`);
      // 다른 채팅·다른 사람·모양이 틀린 데이터·지난 id는 승인으로 보지 않는다.
      await press(h, a.yes, { chat: 9999 });
      await press(h, a.yes, { from: 4242 });
      await press(h, a.yes.replace(/:y$/, ":maybe"));
      await press(h, "a:AAAAAAAAAAAAAAAAAAAAAA:y");
      await h.panel.waitForTimeout(500);
      expect((await toolLog(h)).length === 0, `아직 실행 안 함(${(await toolLog(h)).join(",")})`);
      await press(h, a.yes);
      const r = await waitReply(h);
      expect(r[0] === "정리했습니다", `최종 답(${JSON.stringify(r)})`);
      const log = await toolLog(h);
      expect(log[0] === "navigate_to_url:ok", `승인 후 이동(${log.join(",")})`);
      const titles = await h.sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.title).join("|"));
      expect(titles.includes("뉴스 페이지"), `뉴스 페이지로 감(${titles})`);
      // 끝난 질문의 버튼을 다시 누르면 "끝난 질문"으로만 답한다.
      await press(h, a.yes);
      const answers = await h.sw.evaluate(() => (globalThis.__tg.edits ?? []).filter((e) => e.method === "answerCallbackQuery").map((e) => e.body.text));
      expect(answers.at(-1) === "이미 끝난 질문입니다.", `중복 누름(${JSON.stringify(answers)})`);
      const edited = await h.sw.evaluate(() => (globalThis.__tg.edits ?? []).filter((e) => e.method === "editMessageText").map((e) => e.body.text));
      expect(edited.some((t) => t.endsWith("→ 승인함")), `질문 메시지에 결과 표시(${JSON.stringify(edited)})`);
    },
  },
  {
    name: "원격 승인(#185): 거절하면 이동하지 않고 답을 마무리한다, 버튼이 질문 전송 응답보다 먼저 와도 반영",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      await connect(h);
      await h.sw.evaluate((url) => {
        globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "하지 않았습니다" }];
        globalThis.__toolLog = [];
        let release;
        globalThis.__tg.holdAsk = new Promise((r) => (release = r));
        globalThis.__tg.releaseAsk = release;
      }, `${h.base}/news`);
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      const [a] = await waitAsk(h);
      // sendMessage가 아직 응답하지 않은 동안 거절을 누른다.
      await press(h, a.no);
      await h.sw.evaluate(() => globalThis.__tg.releaseAsk());
      const r = await waitReply(h);
      // 거절하면 도구 없이 마무리한다(모의 모델의 마무리 답).
      expect(r.length === 1 && r[0] === "정리", `마무리 답(${JSON.stringify(r)})`);
      const log = await toolLog(h);
      expect(log.length === 1 && log[0] === "navigate_to_url:remote_user_denied", `거절 기록·이동 안 함(${log.join(",")})`);
    },
  },
  {
    name: "원격 승인(#185): 기다리는 중 /stop이면 질문을 거두고, 설정을 끄면 묻지 않고 거절한다",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      await connect(h);
      await h.sw.evaluate((url) => {
        globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "멈춤" }];
        globalThis.__toolLog = [];
      }, `${h.base}/news`);
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      const [a] = await waitAsk(h);
      await deliver(h, "/stop");
      await h.panel.waitForTimeout(500);
      const edited = await h.sw.evaluate(() => (globalThis.__tg.edits ?? []).filter((e) => e.method === "editMessageText").map((e) => e.body.text));
      expect(edited.some((t) => t.endsWith("→ 취소됨")), `질문 거둠(${JSON.stringify(edited)})`);
      await press(h, a.yes);
      await h.panel.waitForTimeout(500);
      const stopped = await toolLog(h);
      expect(!stopped.includes("navigate_to_url:ok"), `멈춘 뒤 누름은 무시(${stopped.join(",")})`);

      // 질문 전송 응답이 오지 않는 동안 /stop: 응답을 기다리지 않고 슬롯이 비어 다음 요청을 바로 받는다.
      await h.sw.evaluate((url) => {
        let release;
        globalThis.__tg.holdAsk = new Promise((r) => (release = r));
        globalThis.__tg.releaseAsk = release;
        globalThis.__tg.asks = [];
        globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "멈춤" }];
      }, `${h.base}/news`);
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      await waitAsk(h);
      await deliver(h, "/stop");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__steps = [{ text: "바로 받음" }];
      });
      await h.panel.waitForTimeout(300);
      await deliver(h, "다음 요청");
      let next;
      try {
        next = await waitReply(h, 1, 5000);
      } finally {
        // 기다림이 실패해도 붙잡은 질문 응답을 놓는다(#262 — 예전엔 기다림이 실패하지 않아 늘 여기까지 왔다).
        await h.sw.evaluate(() => {
          globalThis.__tg.holdAsk = null;
          globalThis.__tg.releaseAsk();
        });
      }
      expect(next.includes("바로 받음"), `멈춘 뒤 바로 다음 요청(${JSON.stringify(next)})`);

      const off = await ask(h, { kind: "telegram_set_ask", on: false });
      expect(off.ok && off.data.askApproval === false, "설정 끔");
      await h.sw.evaluate((url) => {
        globalThis.__tg.sent = [];
        globalThis.__tg.asks = [];
        globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "못 함" }];
        globalThis.__toolLog = [];
      }, `${h.base}/news`);
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      const r = await waitReply(h);
      expect(r.length >= 1 && (await asks(h)).length === 0, `묻지 않음(${JSON.stringify(r)})`);
      const log = await toolLog(h);
      // (앞에서 멈춘 턴의 중단 기록이 늦게 남을 수 있다.)
      expect(log.includes("navigate_to_url:remote_needs_approval") && !log.includes("navigate_to_url:ok"), `거절(${log.join(",")})`);
    },
  },
  {
    name: "원격 승인(#185): 맡기지 않고 부른 클릭의 질문에는 모델용 글만, 표제가 잘린 대상은 묻지 않고 맡기라고 돌려준다 — 맡기면 그 대상도 누른다",
    pages2: {
      "/": `<title>shop</title><ul>
        <li><h3>상품 A</h3><span contenteditable>내가 쓴 비밀 메모</span><button onclick="document.title='결제됨'">결제하기</button></li>
        <li><h3>상품 B</h3><button>담기</button></li><li><h3>상품 C</h3><button>담기</button></li></ul>
        <section aria-label="${"긴표제".repeat(30)}"><ul><li>행 하나 <button onclick="document.title='눌림2'">결제 진행</button></li><li>행 둘</li><li>행 셋</li></ul></section>
        <ol><li>상품 D<span>${" ".repeat(4500)}</span>금액 9,900원 <button>결제 확정</button></li><li>다른 행</li><li>또 다른 행</li></ol>
        <ol><li><span>${" ".repeat(4500)}</span>상품 X · 9,900,000원 <button>최종 결제</button></li><li>다른 행</li><li>또 다른 행</li></ol>
        <p id="price"><span>${" ".repeat(4500)}</span>가격 1,000,000원</p>
        <ol aria-labelledby="price"><li>상품 Y <button>바로 구매</button></li><li>다른 행</li><li>또 다른 행</li></ol>`,
    },
    async run(h) {
      await connect(h);
      await startTabAt(h, `${h.base2}/`);
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "결제하기" }, { text: "끝" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "상품 A 결제해 줘");
      const [a] = await waitAsk(h);
      expect(a && a.text.includes("'결제하기'") && a.text.includes(`페이지: ${h.base2}`), `클릭 질문(${a?.text})`);
      expect(!a.text.includes("비밀 메모"), `편집 영역 글자 없음(${a.text})`);
      await press(h, a.no);
      await waitReply(h);

      await deliver(h, "/new");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__tg.asks = [];
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "결제 진행" }, { text: "못 함" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "결제 진행 눌러 줘");
      await waitReply(h);
      const log = await toolLog(h);
      expect((await asks(h)).length === 0 && log.includes("click_element:remote_task_not_confirmed"), `잘린 표제는 묻지 않음(${log.join(",")})`);

      // 공백이 길어 순회 한도에서 멈춘 행(뒤쪽 금액이 빠짐)도 잘린 것으로 본다.
      await deliver(h, "/new");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__tg.asks = [];
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "결제 확정" }, { text: "못 함" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "결제 확정 눌러 줘");
      await waitReply(h);
      const log2 = await toolLog(h);
      expect((await asks(h)).length === 0 && log2.includes("click_element:remote_task_not_confirmed"), `순회가 멈춘 행은 묻지 않음(${log2.join(",")})`);

      // 앞쪽 공백만으로 한도에 닿아 행 문맥이 비어도 잘린 것으로 본다.
      await deliver(h, "/new");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__tg.asks = [];
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "최종 결제" }, { text: "못 함" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "최종 결제 눌러 줘");
      await waitReply(h);
      const log3 = await toolLog(h);
      expect((await asks(h)).length === 0 && log3.includes("click_element:remote_task_not_confirmed"), `비어 있는 잘린 문맥도 묻지 않음(${log3.join(",")})`);

      // 행 밖 표제(aria-labelledby)가 잘린 채 비어도 잘린 것으로 본다.
      await deliver(h, "/new");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__tg.asks = [];
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "바로 구매" }, { text: "못 함" }];
        globalThis.__toolLog = [];
      });
      await deliver(h, "바로 구매 눌러 줘");
      await waitReply(h);
      const log4 = await toolLog(h);
      expect((await asks(h)).length === 0 && log4.includes("click_element:remote_task_not_confirmed"), `잘린 빈 표제도 묻지 않음(${log4.join(",")})`);

      // 맡기면(원래 문제: 원격 질문을 만들 수 없는 대상) 더 묻지 않고 누른다. 질문·모델 요청에 편집 영역 글자는 없다.
      await deliver(h, "/new");
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__tg.asks = [];
        globalThis.__modelReqs = [];
        globalThis.__steps = [
          { tool: "confirm_task", args: { summary: "결제 진행 누르기", risks: ["결제"] } },
          { tool: "find_clickables", args: {} },
          { click: "결제 진행" },
          { text: "눌렀습니다" },
        ];
        globalThis.__toolLog = [];
      });
      await deliver(h, "결제 진행 눌러 줘");
      const [t] = await waitAsk(h);
      await press(h, t.yes);
      const done = await waitReply(h);
      const log5 = await toolLog(h);
      expect(done[0] === "눌렀습니다" && log5.includes("click_element:ok") && (await asks(h)).length === 1, `맡긴 뒤 누름(${log5.join(",")} / ${JSON.stringify(done)})`);
      expect((await tabTitles(h)).includes("눌림2"), "잘린 표제 대상이 눌림");
      const leaked = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs).includes("비밀 메모") || JSON.stringify(globalThis.__tg.asks).includes("비밀 메모"));
      expect(!leaked, "편집 영역 글자는 모델·텔레그램으로 가지 않음");
    },
  },
  {
    name: "/stop·/help 명령, 연결 끊기 뒤에는 받지 않음, 반복 작업 알림은 켰을 때 제목만",
    pages: { "/watch": `<title>공연</title><button>예매하기</button><div id=out></div>` },
    async run(h) {
      await connect(h);
      await deliver(h, "/stop");
      await deliver(h, "/help");
      let s = await waitSent(h, 2, 3000);
      expect(s[0] === "진행 중인 요청이 없습니다." && s[1].includes("/stop"), `명령(${JSON.stringify(s)})`);
      await ask(h, { kind: "telegram_set_notify", on: true });
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__draft = { verdict: "met", reason: "비밀 이유" };
      });
      await h.turn(
        [{ tool: "schedule_repeat_task", args: { title: "공연 예매", url: `${h.base}/watch`, check: "예매 열림", then: "예약", intervalMinutes: 10 } }, { text: "등록" }],
        { path: "/watch", approve: true },
      );
      s = await waitSent(h, 1, 10_000);
      expect(s.length === 1 && s[0].includes("‘공연 예매’") && !s[0].includes("비밀 이유") && !s[0].includes("예약"), `알림은 제목만(${JSON.stringify(s)})`);
      await ask(h, { kind: "telegram_disconnect" });
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__tg.calls = [];
      });
      await deliver(h, "끊은 뒤 요청");
      const calls = await h.sw.evaluate(() => globalThis.__tg.calls);
      expect(!calls.includes("getUpdates") && (await sent(h)).length === 0, `끊은 뒤에는 받지 않음(${calls.join(",")})`);
    },
  },
  {
    name: "반복 작업 알림 요약(#209): 꺼짐이면 지금 글 그대로(이름만), 켜면 이름+요약, 알림을 끄면 요약이 켜져 있어도 안 보냄, 토큰 바꾸기는 유지·지우기는 기본값",
    pages: { "/watch": `<title>공연</title><button>예매하기</button><div id=out></div>` },
    async run(h) {
      await connect(h);
      const st0 = (await ask(h, { kind: "telegram_status" })).data;
      expect(st0.notifyRepeatSummary === false, `요약 기본 꺼짐(${JSON.stringify(st0)})`);
      await ask(h, { kind: "telegram_set_notify", on: true });
      await fireRepeat(h, "공연 A", "예매 버튼이 눌리는 상태입니다");
      let s = await waitSent(h, 1, 10_000);
      expect(s.length === 1 && s[0] === noticeName("공연 A"), `요약 꺼짐은 이름만, 지금 글 그대로(${JSON.stringify(s)})`);

      const on = await ask(h, { kind: "telegram_set_notify_summary", on: true });
      expect(on.ok && on.data.notifyRepeatSummary === true && on.data.notifyRepeat === true, `요약 켬(${JSON.stringify(on)})`);
      await fireRepeat(h, "공연 B", "예매 버튼이 눌리는 상태입니다");
      s = await waitSent(h, 1, 10_000);
      expect(s.length === 1 && s[0] === `${noticeName("공연 B")}\n\n확인 결과: 예매 버튼이 눌리는 상태입니다`, `요약 켬은 이름+요약(${JSON.stringify(s)})`);
      expect(!s[0].includes("예약"), "할 일은 보내지 않음");

      // 알림을 끄면(요약은 켜진 채) 아무것도 보내지 않는다.
      const off = await ask(h, { kind: "telegram_set_notify", on: false });
      expect(off.data.notifyRepeat === false && off.data.notifyRepeatSummary === true, `알림만 끔(${JSON.stringify(off.data)})`);
      await fireRepeat(h, "공연 C", "예매 버튼이 눌리는 상태입니다");
      await waitUntil(async () => (await repeatTasks(h)).some((t) => t.title === "공연 C" && t.status === "triggered"), { timeoutMs: 10_000, label: "공연 C 조건 맞음" });
      await h.panel.waitForTimeout(1500);
      expect((await sent(h)).length === 0, `알림 꺼짐 + 요약 켜짐이면 전송 0(${JSON.stringify(await sent(h))})`);

      const again = await ask(h, { kind: "telegram_save_token", token: TOKEN });
      expect(again.data.notifyRepeatSummary === true, `토큰 바꾸기는 요약 설정 유지(${JSON.stringify(again.data)})`);
      const cleared = await ask(h, { kind: "telegram_clear" });
      expect(cleared.data.notifyRepeatSummary === false && cleared.data.notifyRepeat === false, `토큰 지우기는 기본값(${JSON.stringify(cleared.data)})`);
    },
  },
  {
    name: "반복 작업 알림 요약(#209): 자동 로그인 값이 든 요약은 가려서 보낸다(새 워커 — 가림 목록을 미리 넣음)",
    isolate: true,
    // 가림 목록(loginSecrets 모듈 캐시)이 채워지기 전에 세션 저장소에 값을 넣는다.
    onWorker: (sw) => sw.evaluate((v) => chrome.storage.session.set({ loginSecrets: { t1: [v] } }).then(() => true), NOTICE_SECRET_VALUE),
    pages: { "/watch": `<title>공연</title><button>예매하기</button><div id=out></div>` },
    async run(h) {
      await connect(h);
      await ask(h, { kind: "telegram_set_notify", on: true });
      await ask(h, { kind: "telegram_set_notify_summary", on: true });
      await fireRepeat(h, "공연 D", `로그인 값 ${NOTICE_SECRET_VALUE} 이 화면에 보임`);
      const s = await waitSent(h, 1, 10_000);
      expect(s.length === 1 && s[0].startsWith(`${noticeName("공연 D")}\n\n확인 결과: `), `이름+요약(${JSON.stringify(s)})`);
      expect(!s[0].includes(NOTICE_SECRET_VALUE) && s[0].includes("[가린 값]"), `자동 로그인 값은 가림(${JSON.stringify(s)})`);
    },
  },
];

// 반복 작업 알림 요약(#209) 시나리오의 자동 로그인 값(가림 목록에 미리 넣는다).
const NOTICE_SECRET_VALUE = "Harness-Pw-7731";

const noticeName = (title) => `반복 작업 ‘${title}’의 조건이 맞았습니다. 패널에서 ‘이어서 진행’을 누르세요.`;

const repeatTasks = (h) => h.panel.evaluate(async () => (await chrome.runtime.sendMessage({ kind: "repeat_list" })).data);

// 반복 작업 하나를 등록한다. 첫 확인(바로 돈다)이 reason과 함께 조건이 맞았다고 답한다.
async function fireRepeat(h, title, reason) {
  await h.sw.evaluate((reason) => {
    globalThis.__tg.sent = [];
    globalThis.__draft = { verdict: "met", reason };
  }, reason);
  await h.turn([{ tool: "schedule_repeat_task", args: { title, url: `${h.base}/watch`, check: "예매 열림", then: "예약", intervalMinutes: 10 } }, { text: "등록" }], { path: "/watch", approve: true });
}
