// 유휴 생존(#307): 텔레그램 대화가 이어질 수 있는 동안 서비스 워커가 유휴 종료로 내려가지 않아, 5분 넘게 지난 다음 요청이
// 같은 대화(앞 요청의 맥락)로 이어지는지 본다. 대조: 같은 조건에서 대화용 참조만 끄면 워커가 실제로 유휴 종료된다(워커 식별값이 바뀜).
// - Playwright는 서비스 워커에 붙어 있어 Chrome이 워커를 유휴로 내리지 않는다. 그래서 이 시나리오는 공용 하네스 대신 rawChrome.mjs로
//   브라우저를 따로 띄우고(standalone), 준비할 때만 워커에 붙었다가 떼고 기다린다. 기다리는 동안 패널·확장 화면은 열지 않는다.
// - 워커가 다시 시작돼 대역(fetch 흉내)이 사라져도 실제 텔레그램으로 나가지 않게 api.telegram.org를 127.0.0.1로 돌리고(연결 거부),
//   그 밖의 이름은 찾지 못하게 한다(--host-resolver-rules).
// - 약 6분 걸린다(본 시나리오와 대조를 브라우저 둘로 함께 돌린다). 그래서 이름으로 고를 때만 돈다(explicit — run.mjs:
//   `npm run harness idle-survival` 또는 HARNESS_LONG=1).
import { expect, installMockModel, waitUntil } from "../lib.mjs";
import { launchRaw } from "../rawChrome.mjs";
import { connect, deliver } from "./telegram.mjs";

const RESOLVER = "--host-resolver-rules=MAP api.telegram.org 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1";
// 유휴 종료(30초)와 강제 종료(5분 — 한 이벤트·요청 처리 시간 제한)를 모두 넘기는 기다림.
const WAIT_MS = Number(process.env.HARNESS_IDLE_WAIT_MS ?? 330_000);
const PHRASE = "보라색-고래-4417";
const OPTIONS = "src/options/index.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 확장 화면에서 패널 연결(chat 포트)을 열어 지금 워커의 식별값(port_hello의 workerRun)을 읽고 닫는다. 워커가 내려가 있으면 이 연결이 깨운다.
const workerRun = (page) =>
  page.evaluate(
    () =>
      new Promise((res, rej) => {
        const port = chrome.runtime.connect({ name: "chat" });
        const t = setTimeout(() => rej(new Error("port_hello 없음")), 10_000);
        port.onMessage.addListener((m) => {
          if (m?.kind === "port_hello") {
            clearTimeout(t);
            res(m.workerRun);
            port.disconnect();
          }
        });
      }),
  );

async function readRun(b) {
  const page = await b.openPage(OPTIONS);
  try {
    return await workerRun(page);
  } finally {
    await page.close();
  }
}

// 브라우저 하나로 한 번: 연결 → 식별값 기록 → 요청 1(고유 문구)을 넣고 바로 떼기 → 기다림 → 식별값 다시 읽기.
// control이면 대화용 참조를 끄고 식별값만 돌려준다. 아니면 요청 2를 보내 그 모델 요청에 고유 문구가 있는지도 돌려준다.
async function runOne({ control }) {
  const b = await launchRaw({ args: [RESOLVER] });
  try {
    const sw = await b.attachWorker();
    expect(sw, "서비스 워커");
    await sw.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ settings: { openRouterApiKey: "sk-or-test-dummy", model: "deepseek/x", runMode: "ask" } });
    });
    await installMockModel(sw);
    await sw.evaluate(() => {
      globalThis.__modelReqs = [];
      globalThis.__badToolIds = [];
    });
    if (control) await sw.evaluate(() => globalThis.__sbpTelegram.idleHold({ off: true }));
    const page = await b.openPage(OPTIONS);
    const h = { sw, panel: page };
    await connect(h);
    // 패널(확장 화면)을 닫기 전에 식별값을 기록한다.
    const before = await workerRun(page);
    // 요청 1: 업데이트를 넣고 받기를 시작만 한 뒤(기다리지 않음) 바로 뗀다 — 요청은 DevTools 없이 처리된다.
    await sw.evaluate((text) => {
      globalThis.__steps = [{ text: "기억했습니다" }];
      const id = globalThis.__tg.nextId++;
      globalThis.__tg.updates.push({ update_id: id, message: { message_id: id, chat: { id: 7001, type: "private", username: "me" }, from: { id: 7001 }, text, date: Math.floor(Date.now() / 1000) } });
      void globalThis.__sbpTelegram.poll();
    }, `이 문구를 기억해 줘: ${PHRASE}`);
    await sw.detach();
    await page.close();
    await sleep(WAIT_MS);
    const after = await readRun(b);
    if (control) return { before, after };
    const sw2 = await b.attachWorker();
    expect(sw2, "기다린 뒤 서비스 워커");
    try {
      const page2 = await b.openPage(OPTIONS);
      const h2 = { sw: sw2, panel: page2 };
      try {
        const first = await sw2.evaluate(() => globalThis.__tg?.sent.map((m) => m.text) ?? null);
        await sw2.evaluate(() => {
          globalThis.__modelReqs = [];
          globalThis.__tg.sent = [];
          globalThis.__steps = [{ text: "문구를 압니다" }];
        });
        if (first) await deliver(h2, "아까 기억한 문구가 뭐였지?");
        const reply = first
          ? await waitUntil(async () => (await sw2.evaluate(() => globalThis.__tg.sent.map((m) => m.text))).find((t) => t === "문구를 압니다"), {
              timeoutMs: 20_000,
              intervalMs: 250,
              label: "요청 2의 답",
            })
          : null;
        const carried = await sw2.evaluate((p) => JSON.stringify(globalThis.__modelReqs.map((r) => r.body?.messages ?? [])).includes(p), PHRASE);
        return { before, after, first, reply, carried };
      } finally {
        await page2.close();
      }
    } finally {
      await sw2.detach();
    }
  } finally {
    await b.close();
  }
}

export default [
  {
    name: "텔레그램 대화가 이어질 수 있는 동안 서비스 워커가 유휴로 내려가지 않는다(5분 넘게 뒤 같은 워커·같은 대화) — 대조: 대화용 참조를 끄면 워커가 다시 시작된다",
    standalone: true,
    explicit: true,
    async run() {
      const [main, ctl] = await Promise.all([runOne({ control: false }), runOne({ control: true })]);
      console.log(`    본 시나리오 워커 ${main.before} → ${main.after}, 대조 워커 ${ctl.before} → ${ctl.after}`);
      expect(main.before === main.after, `같은 워커(${main.before} → ${main.after})`);
      expect(main.first?.includes("기억했습니다"), `요청 1의 답(${JSON.stringify(main.first)})`);
      expect(!!main.reply, "요청 2의 답");
      expect(main.carried, "요청 2의 모델 요청에 요청 1의 고유 문구가 있음(같은 대화)");
      // 대조가 실패하면(워커가 그대로) 이 환경에서는 유휴 종료가 일어나지 않아 위 결과가 아무것도 증명하지 않는다.
      expect(ctl.before !== ctl.after, `대조: 대화용 참조를 끄면 워커가 유휴 종료된다(${ctl.before} → ${ctl.after})`);
    },
  },
];
