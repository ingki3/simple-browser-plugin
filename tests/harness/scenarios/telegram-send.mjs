// send_to_telegram(#210): 패널 요청 결과를 연결한 텔레그램 채팅으로 보낸다. 모의 텔레그램 서버(telegram.mjs installTelegram)가 받은
// sendMessage로 전송 여부·받는 곳·글을 본다. 승인은 기존 판정 그대로(ask=카드에 글 전체, auto=카드 없이, task=맡긴 작업, 외부 본문 보호 중
// auto=카드), 받는 곳은 연결한 chat_id 하나, 가림·상한·턴당 3번, 카드 대기 중 연결이 바뀌면 승인해도 보내지 않는다.
import { ask, expect, waitUntil } from "../lib.mjs";
import { asks, connect, deliver, installTelegram, press, replies, waitAsk } from "./telegram.mjs";

const CHAT = 7001;
const SECRET = "Harness-Pw-2100";
const TOKEN2 = "654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// 텔레그램이 받은 sendMessage 중 승인 질문이 아닌 것(받는 곳·글).
const delivered = (h) => h.sw.evaluate(() => globalThis.__tg.sent.filter((m) => !m.reply_markup).map((m) => ({ chat: m.chat_id, text: m.text })));
const sendMessages = (h) => h.sw.evaluate(() => globalThis.__tg.calls.filter((c) => c === "sendMessage").length);
const clearTg = (h) => h.sw.evaluate(() => {
  globalThis.__tg.sent = [];
  globalThis.__tg.calls = [];
});
const sendLog = (r) => r.tools.filter((t) => t.name === "send_to_telegram");
const send = (text) => ({ tool: "send_to_telegram", args: { text } });

export default [
  {
    name: "send_to_telegram: 연결하지 않았으면 카드 없이 고정 문구로 실패하고 보내지 않는다",
    async run(h) {
      await installTelegram(h);
      const r = await h.turn([send("요약입니다"), { text: "끝" }]);
      expect(r.cards === 0 && !r.stoppedAtCard, `카드 없음(${r.cards})`);
      const [t] = sendLog(r);
      expect(t && String(t.error).includes("텔레그램이 연결돼 있지 않습니다") && t.result === undefined, `실패 문구(${JSON.stringify(t)})`);
      expect((await sendMessages(h)) === 0, "전송 0");
    },
  },
  {
    name: "send_to_telegram(ask): 카드에 보낼 글 전체를 보이고, 승인하면 연결한 chat_id로 그 글이 가고, 거절하면 보내지 않는다",
    async run(h) {
      await connect(h);
      const text = `오늘 요약\n- 첫째 줄\n- 둘째 줄 ${"가".repeat(600)} 끝 표시`;
      let cardText = "";
      const r = await h.turn([send(text), { text: "보냈습니다" }], {
        onCard: async (card) => {
          cardText = await card.innerText();
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1, `카드 1개(${r.cards})`);
      expect(cardText.includes("텔레그램으로 보내기") && cardText.includes("@me") && cardText.includes("끝 표시") && cardText.includes("- 둘째 줄"), `카드에 글 전체(${cardText.slice(0, 200)})`);
      const got = await delivered(h);
      expect(got.length === 1 && got[0].chat === CHAT && got[0].text === text, `연결한 채팅으로 그 글(${JSON.stringify(got).slice(0, 200)})`);
      const [t] = sendLog(r);
      expect(t?.result?.sent === true && t.result.parts === 1 && !JSON.stringify(t).includes("끝 표시"), `결과는 고정 값(${JSON.stringify(t)})`);
      expect((await h.panel.locator(".tool-result").last().innerText()).includes("텔레그램으로 보냄(1개 메시지)"), "패널 결과 줄");

      await clearTg(h);
      const r2 = await h.turn([send("거절할 글"), { text: "안 보냄" }], { onCard: (card) => card.locator(".btn-cancel").click() });
      expect(r2.cards === 1 && sendLog(r2).at(-1)?.error === "user_cancelled", `거절(${JSON.stringify(sendLog(r2))})`);
      expect((await sendMessages(h)) === 0, "거절하면 전송 0");
    },
  },
  {
    name: "send_to_telegram(auto): 카드 없이 보내고, 4096자 넘는 글은 잘림 없이 여러 조각으로(이으면 원문)",
    async run(h) {
      await connect(h);
      await h.settings({ runMode: "auto" });
      const text = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
      const r = await h.turn([send(text), { text: "보냈습니다" }]);
      expect(r.cards === 0, `카드 없음(${r.cards})`);
      const got = await delivered(h);
      expect(got.length === 2 && got.every((m) => m.chat === CHAT) && got.map((m) => m.text).join("") === text, `두 조각(${got.map((m) => m.text.length).join(",")})`);
      expect(sendLog(r)[0]?.result?.parts === 2, `결과 2조각(${JSON.stringify(sendLog(r)[0]?.result)})`);
    },
  },
  {
    name: "send_to_telegram(task): 맡기기 카드 한 번 뒤 보낸다",
    async run(h) {
      await connect(h);
      await h.settings({ runMode: "task" });
      const seen = [];
      const r = await h.turn([send("맡긴 뒤 보낼 글"), { text: "보냈습니다" }], {
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1 && seen[0].includes("작업 맡기기"), `맡기기 카드 하나(${r.cards} / ${seen[0]?.slice(0, 120)})`);
      const got = await delivered(h);
      expect(got.length === 1 && got[0].text === "맡긴 뒤 보낼 글" && got[0].chat === CHAT, `보냄(${JSON.stringify(got)})`);
    },
  },
  {
    name: "send_to_telegram(auto): 외부 본문 보호 중이면 카드로 묻는다",
    pages: { "/s": `<title>목록</title><main><a href="/doc">문서</a><p id=out></p></main>`, "/doc": `<title>문서</title><main><p>외부 문서 본문</p></main>` },
    async run(h) {
      await connect(h);
      await h.settings({ runMode: "auto" });
      const seen = [];
      const r = await h.turn([{ tool: "read_linked_pages", args: { urls: [`${h.base}/doc`] } }, send("보호 중 보낼 글"), { text: "끝" }], {
        path: "/s",
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      const tg = seen.find((t) => t.includes("텔레그램으로 보내기"));
      expect(tg && tg.includes("외부 문서 내용을 읽은 대화라 자동 실행하지 않음") && tg.includes("보호 중 보낼 글"), `보호 중 카드(${seen.map((s) => s.slice(0, 80)).join(" | ")})`);
      const got = await delivered(h);
      expect(got.length === 1 && got[0].text === "보호 중 보낼 글", `승인 뒤 보냄(${JSON.stringify(got)})`);
    },
  },
  {
    name: "send_to_telegram: 한 요청에 3번까지(4번째는 거절), chat_id 인자는 스키마가 거절(카드·전송 없음)",
    async run(h) {
      await connect(h);
      await h.settings({ runMode: "auto" });
      const r = await h.turn([send("1"), send("2"), send("3"), send("4"), { text: "끝" }]);
      const log = sendLog(r);
      expect(log.length === 4 && log.slice(0, 3).every((t) => t.result?.sent === true) && String(log[3].error).includes("최대 3번"), `4번째 거절(${JSON.stringify(log)})`);
      expect((await delivered(h)).map((m) => m.text).join(",") === "1,2,3", "세 번만 감");

      await clearTg(h);
      await h.settings({ runMode: "ask" });
      const r2 = await h.turn([{ tool: "send_to_telegram", args: { text: "다른 곳으로", chat_id: 1234 } }, { text: "끝" }]);
      const t = sendLog(r2).at(-1);
      expect(r2.cards === 0 && String(t?.error).includes("인자 검증 실패"), `chat_id 거절(${JSON.stringify(t)})`);
      expect((await sendMessages(h)) === 0, "전송 0");
    },
  },
  {
    name: "send_to_telegram: 카드 대기 중 끊고 다시 연결하거나 토큰을 바꾸면 승인해도 보내지 않는다",
    async run(h) {
      await connect(h);
      // 끊고 다시 연결(같은 토큰 저장 → 확인 코드로 다시 연결, 세대가 바뀐다).
      const r = await h.turn([send("옛 연결로 보낼 글"), { text: "끝" }], {
        onCard: async (card) => {
          await ask(h, { kind: "telegram_disconnect" });
          await connect(h);
          await card.locator(".btn-approve").click();
        },
      });
      const [t] = sendLog(r);
      expect(r.cards === 1 && String(t?.error).includes("텔레그램 연결이 바뀌어"), `다시 연결 → 거절(${JSON.stringify(t)})`);
      expect((await delivered(h)).length === 0, `전송 0(${JSON.stringify(await delivered(h))})`);

      // 토큰 바꾸기(다른 봇) — 연결 대기 상태가 되고 세대가 바뀐다.
      await clearTg(h);
      const r2 = await h.turn([send("토큰 바꾸기 전 글"), { text: "끝" }], {
        onCard: async (card) => {
          const saved = await ask(h, { kind: "telegram_save_token", token: TOKEN2 });
          expect(saved.ok, "토큰 바꿈");
          await card.locator(".btn-approve").click();
        },
      });
      expect(String(sendLog(r2).at(-1)?.error).includes("텔레그램 연결이 바뀌어"), `토큰 바꾸기 → 거절(${JSON.stringify(sendLog(r2))})`);
      expect((await sendMessages(h)) === 0, "전송 0");
    },
  },
  {
    name: "send_to_telegram: 중간 조각이 실패하면 실패로 알리고 앞의 조각은 이미 갔다고 적는다(텔레그램 오류 원문 없음)",
    async run(h) {
      await connect(h);
      await h.settings({ runMode: "auto" });
      await h.sw.evaluate(() => {
        globalThis.__tg.failAfter = 1;
      });
      const r = await h.turn([send(`${"a".repeat(2600)}\n\n${"b".repeat(2600)}\n\n${"c".repeat(2600)}`), { text: "끝" }]);
      const [t] = sendLog(r);
      expect(String(t?.error).includes("텔레그램으로 보내지 못했습니다") && String(t.error).includes("앞의 1개 메시지는 이미 갔습니다"), `부분 실패 문구(${JSON.stringify(t)})`);
      expect(!JSON.stringify(t).includes("서버 오류 원문") && !JSON.stringify(t).includes("AAAA"), "오류 원문·토큰 없음");
      const got = await delivered(h);
      expect(got.length === 1 && got[0].text.startsWith("aaa"), `한 조각만 감(${got.length})`);
      expect((await h.sw.evaluate(() => globalThis.__tg.failed)) === 1, "두 번째 조각에서 실패");
    },
  },
  {
    name: "send_to_telegram: 텔레그램 원격 요청에서는 작업을 맡긴 뒤에도 거절한다(보낸 것은 최종 답뿐)",
    pages2: { "/": `<title>shop</title><p>상품</p>` },
    async run(h) {
      await connect(h);
      await h.sw.evaluate(() => {
        globalThis.__steps = [
          { tool: "confirm_task", args: { summary: "요약을 텔레그램으로", risks: [] } },
          { tool: "send_to_telegram", args: { text: "원격에서 맡긴 뒤 보내기" } },
          { text: "못 보냄" },
        ];
        globalThis.__toolLog = [];
        globalThis.__tg.asks = [];
      });
      await deliver(h, "요약해서 텔레그램으로 보내 줘");
      const [q] = await waitAsk(h);
      await press(h, q.yes);
      await waitUntil(async () => (await replies(h)).length >= 1, { timeoutMs: 20_000, label: "최종 답" });
      const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => ({ name: t.name, error: t.error ?? null })));
      const tg = log.find((t) => t.name === "send_to_telegram");
      expect(tg && tg.error === "remote_needs_approval", `맡긴 뒤에도 거절(${JSON.stringify(log)})`);
      const texts = await replies(h);
      expect(texts.length === 1 && !texts.some((t) => t.includes("원격에서 맡긴 뒤 보내기")), `최종 답만(${JSON.stringify(texts)})`);
      expect((await asks(h)).length === 1, "맡기기 질문 하나뿐");
    },
  },
  {
    name: "send_to_telegram: 자동 로그인 값은 카드·보낸 글 모두 가린다(새 워커 — 가림 목록을 미리 넣음)",
    isolate: true,
    onWorker: (sw) => sw.evaluate((v) => chrome.storage.session.set({ loginSecrets: { t1: [v] } }).then(() => true), SECRET),
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
      const got = await delivered(h);
      expect(got.length === 1 && got[0].text === "로그인 값 [가린 값] 이 보임", `가린 글로 보냄(${JSON.stringify(got)})`);
      const pendingArgs = await h.panel.evaluate(() => document.body.innerText.includes("Harness-Pw-2100"));
      expect(!pendingArgs, "패널 화면에 값 없음");
    },
  },
];
