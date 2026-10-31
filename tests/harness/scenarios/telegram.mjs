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

// 버튼 누르기(callback_query). chat·from을 바꿔 다른 채팅·다른 사람의 누름을 흉내 낸다.
async function press(h, data, { chat = CHAT, from = chat, poll = true } = {}) {
  await h.sw.evaluate(
    async ({ data, chat, from, poll }) => {
      const id = globalThis.__tg.nextId++;
      globalThis.__tg.updates.push({ update_id: id, callback_query: { id: `q${id}`, data, from: { id: from }, message: { message_id: 1, chat: { id: chat, type: "private" } } } });
      if (poll) await globalThis.__sbpTelegram.poll();
    },
    { data, chat, from, poll },
  );
}

const asks = (h) => h.sw.evaluate(() => (globalThis.__tg.asks ?? []).map((b) => ({ text: b.text, yes: b.reply_markup.inline_keyboard[0][0].callback_data, no: b.reply_markup.inline_keyboard[0][1].callback_data })));

async function waitAsk(h, n = 1, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const a = await asks(h);
    if (a.length >= n) return a;
    await h.panel.waitForTimeout(200);
  }
  return asks(h);
}

// 텔레그램으로 보낸 글 중 승인 질문이 아닌 것(최종 답·안내).
const replies = (h) => h.sw.evaluate(() => globalThis.__tg.sent.filter((m) => !m.reply_markup).map((m) => m.text));

async function waitReply(h, n = 1, ms = 20_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await replies(h);
    if (r.length >= n) return r;
    await h.panel.waitForTimeout(250);
  }
  return replies(h);
}

const toolLog = (h) => h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));

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
      // 결제는 승인이 필요해 텔레그램 버튼으로 묻는다(#185) — 거절한다.
      const [q] = await waitAsk(h, 1, 20_000);
      expect(q?.text.includes("'결제하기'"), `결제 질문(${q?.text})`);
      await press(h, q.no);
      const s = await waitReply(h);
      const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
      expect(log[1] === "click_element:ok", `일반 클릭은 맡기기 카드 없이 자동(${log.join(", ")})`);
      expect(log.some((l) => l === "click_element:remote_user_denied"), `결제는 거절(${log.join(", ")})`);
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
      // 텔레그램은 승인을 버튼으로 물을 수 있어(#185) 주소가 없어도 사이트를 골라 가라고 안내한다.
      expect(note.includes("사이트 주소가 없다") && note.includes("승인을 묻는다") && !note.includes("승인 없이 이동할 수 있다"), `주소 없음 안내(${note.slice(0, 400)})`);
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
      expect(a && a.text.includes(`주소: ${h.base}/news`) && a.text.includes("승인이 필요합니다"), `질문(${a?.text})`);
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
      const next = await waitReply(h, 1, 5000);
      await h.sw.evaluate(() => {
        globalThis.__tg.holdAsk = null;
        globalThis.__tg.releaseAsk();
      });
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
    name: "원격 승인(#185): 클릭 질문에는 모델용 글만, 표제가 잘린 대상은 묻지 않는다",
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
      await h.sw.evaluate((url) => {
        const realCreate = chrome.tabs.create.bind(chrome.tabs);
        chrome.tabs.create = (p) => realCreate(p?.url === "chrome://newtab/" ? { ...p, url } : p);
        globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "결제하기" }, { text: "끝" }];
        globalThis.__toolLog = [];
      }, `${h.base2}/`);
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
      expect((await asks(h)).length === 0 && log.includes("click_element:remote_needs_approval"), `잘린 표제는 묻지 않음(${log.join(",")})`);

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
      expect((await asks(h)).length === 0 && log2.includes("click_element:remote_needs_approval"), `순회가 멈춘 행은 묻지 않음(${log2.join(",")})`);

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
      expect((await asks(h)).length === 0 && log3.includes("click_element:remote_needs_approval"), `비어 있는 잘린 문맥도 묻지 않음(${log3.join(",")})`);

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
      expect((await asks(h)).length === 0 && log4.includes("click_element:remote_needs_approval"), `잘린 빈 표제도 묻지 않음(${log4.join(",")})`);
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
