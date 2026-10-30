// 텔레그램 연동(#139): 서비스 워커의 fetch로 api.telegram.org를 흉내 낸다(받을 업데이트·보낸 메시지를 전역에 둔다).
// 확인 코드 연결 → 요청 → 최종 답만, 허용 밖 채팅·오래된 메시지 무시, 원격 요청은 전역 실행 방식과 관계없이 auto 판정이되
// 승인 카드가 필요한 동작(결제)은 패널 카드 없이 거절하고 도구 없이 마무리, 반복 작업 알림은 켰을 때 제목만.
import { expect } from "../lib.mjs";

const TOKEN = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHAT = 7001;

async function installTelegram(h) {
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
        globalThis.__tg.sent.push(body);
        return ok({ message_id: globalThis.__tg.sent.length });
      }
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
async function deliver(h, text, { chat = CHAT, from = chat, ageS = 0 } = {}) {
  await h.sw.evaluate(
    async ({ text, chat, from, ageS }) => {
      const id = globalThis.__tg.nextId++;
      globalThis.__tg.updates.push({ update_id: id, message: { message_id: id, chat: { id: chat, type: "private", username: "me" }, from: { id: from }, text, date: Math.floor(Date.now() / 1000) - ageS } });
      await globalThis.__sbpTelegram.poll();
    },
    { text, chat, from, ageS },
  );
}

const sent = (h) => h.sw.evaluate(() => globalThis.__tg.sent.map((m) => m.text));
const ask = (h, msg) => h.panel.evaluate(async (m) => chrome.runtime.sendMessage(m), msg);

async function connect(h) {
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

async function waitSent(h, n, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const s = await sent(h);
    if (s.length >= n) return s;
    await h.panel.waitForTimeout(250);
  }
  return sent(h);
}

export default [
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
    name: "원격 요청은 전역이 '처음에 승인'이어도 auto 판정(일반 클릭 자동), 결제는 카드 없이 거절 후 마무리",
    pages2: {
      "/": `<title>shop</title><button onclick="document.title='결제됨'">결제하기</button><button onclick="document.title='적용됨'">적용</button>`,
    },
    async run(h) {
      await h.settings({ runMode: "task" });
      await connect(h);
      // 시험 서버 주소(localhost·IP)는 요청 글의 사이트로 인정하지 않으므로, 원격 대화의 새 작업 탭을 시험 페이지로 연다.
      await h.sw.evaluate((url) => {
        const realCreate = chrome.tabs.create.bind(chrome.tabs);
        chrome.tabs.create = (p) => realCreate(p?.url === "chrome://newtab/" ? { ...p, url } : p);
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "적용" }, { tool: "find_clickables", args: {} }, { click: "결제하기" }, { text: "여기까지" }];
        globalThis.__toolLog = [];
      }, `${h.base2}/`);
      await deliver(h, "적용 누르고 결제해 줘");
      const s = await waitSent(h, 1, 20_000);
      const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
      expect(log[1] === "click_element:ok", `일반 클릭은 맡기기 카드 없이 자동(${log.join(", ")})`);
      expect(log.some((l) => l === "click_element:remote_needs_approval"), `결제는 거절(${log.join(", ")})`);
      expect(s.length === 1 && s[0] === "정리", `도구 없이 마무리한 답만(${JSON.stringify(s)})`);
      expect((await h.panel.locator(".tool-pending").count()) === 0, "패널에 카드 없음");
      const titles = await h.sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.title).join("|"));
      expect(titles.includes("적용됨") && !titles.includes("결제됨"), `적용은 눌리고 결제는 눌리지 않음(${titles})`);
    },
  },
  {
    name: "원격 요청에서는 remember_page를 쓰지 않는다(패널 카드 없음)",
    pages2: { "/": `<title>shop</title><p>상품</p>` },
    async run(h) {
      await connect(h);
      await h.sw.evaluate((url) => {
        const realCreate = chrome.tabs.create.bind(chrome.tabs);
        chrome.tabs.create = (p) => realCreate(p?.url === "chrome://newtab/" ? { ...p, url } : p);
        globalThis.__steps = [{ tool: "remember_page", args: {} }, { text: "못 함" }];
        globalThis.__toolLog = [];
      }, `${h.base2}/?q=1`);
      await deliver(h, "이 페이지 기억해줘");
      await waitSent(h, 1, 20_000);
      const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
      expect(log[0]?.startsWith("remember_page:") && !log[0].endsWith(":ok"), `거절(${log.join(", ")})`);
      expect((await h.panel.locator(".page-offer").count()) === 0, "패널에 저장 카드 없음");
    },
  },
  {
    name: "원격 안내에 요청 글에 적은 사이트를 알린다(없으면 주소를 함께 보내 달라고 답하게)",
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
      await deliver(h, "news.naver.com 경제 뉴스 정리해줘");
      await waitSent(h, 1);
      let note = await lastUser();
      expect(note.includes("https://news.naver.com") && note.includes("승인 없이 이동할 수 있다"), `적은 사이트 안내(${note.slice(0, 400)})`);
      await h.sw.evaluate(() => {
        globalThis.__tg.sent = [];
        globalThis.__modelReqs = [];
        globalThis.__steps = [{ text: "주소를 알려 주세요" }];
      });
      await deliver(h, "오늘 경제 뉴스 정리해줘");
      await waitSent(h, 1);
      note = await lastUser();
      expect(note.includes("사이트 주소가 없어") && !note.includes("승인 없이 이동할 수 있다"), `주소 없음 안내(${note.slice(0, 400)})`);
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
];
