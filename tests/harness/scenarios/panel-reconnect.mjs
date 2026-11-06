// 패널 연결 끊김(#243). 끊김은 하네스 전역 __sbpPorts.dropPanelPorts()로 만든다: 백그라운드 쪽 정리(쉬던 대화 보관) →
// (forget이면 보관함 비우기) → 연결 끊기를 한 번에 하므로, 패널의 재연결은 그 뒤에야 일어난다.
// - 같은 워커 60초 안 재연결은 기록만 잇고 대화 허락·맡긴 작업은 지운다. 외부 본문 보호·디버깅 취소 선택은 남는다.
// - 즉석 재연결(끊긴 직후 보낸 요청)도 리스너·heartbeat·resume을 설치한 하나의 연결로 간다(고치기 전에는 리스너 없는 임시 포트로 가
//   승인 카드가 패널에 뜨지 않았다 — 이 파일의 첫 시나리오로 확인).
// - 잇지 못하면 안내(새 요청 전 반복 유실은 한 번), 진행 중 끊김이면 패널의 응답 중 표시·미결 카드를 정리한다.
import { expect, Fail } from "../lib.mjs";

const PAGE = `<title>T</title><main><article><p>번역할 문단입니다. 이 글은 시험용입니다.</p></article>
<button style="width:200px;height:60px" onclick="document.getElementById('out').textContent='눌림'">확인</button>
<a href="/doc">문서</a><p id=out></p></main>`;
const DOC = `<title>문서</title><main><p>외부 문서 본문</p></main>`;
const pages = { "/t": PAGE, "/doc": DOC };
const findC = { tool: "find_clickables", args: {} };
const clickOk = [findC, { click: "확인" }];
const LOST = "앞 대화를 이어 가지 못했습니다";

// 패널의 예약 재연결(500ms 타이머)을 늦춘다 — 즉석 전송을 예약 재연결 전에 확실히 하려고(패널 코드는 그대로).
async function slowReconnect(h, ms = 8000) {
  await h.panel.evaluate((ms) => {
    const st = window.setTimeout.bind(window);
    window.setTimeout = (fn, delay, ...a) => st(fn, delay === 500 ? ms : delay, ...a);
  }, ms);
}

async function waitFor(cond, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Fail(`${what}: ${ms}ms 안에 되지 않음`);
}

const count = (arr, needle) => arr.filter((l) => l.includes(needle)).length;

// 끊고, 패널이 끊김을 처리할 때까지 기다린다. reconnect면 다시 붙어 resume 답(있으면)까지 기다린다.
async function drop(h, { forget = false, reconnect = true } = {}) {
  const disc = count(h.panelLogs, "port:disconnect");
  const conn = count(h.panelLogs, "port:connect]");
  const n = await h.sw.evaluate((o) => globalThis.__sbpPorts.dropPanelPorts(o), { forget });
  expect(n >= 1, `끊을 패널 연결이 있어야 한다(${n})`);
  await waitFor(async () => count(h.panelLogs, "port:disconnect") > disc, 3000, "패널이 끊김을 처리");
  if (!reconnect) return;
  await waitFor(async () => count(h.panelLogs, "port:connect]") > conn, 3000, "패널이 다시 연결");
  await new Promise((r) => setTimeout(r, 300));
}

const lostCount = (h) => h.panel.locator(".msg-info").filter({ hasText: LOST }).count();
const lastReq = (h) => h.sw.evaluate(() => JSON.stringify((globalThis.__modelReqs ?? []).at(-1)?.body?.messages ?? []));

export default [
  {
    name: "끊긴 직후(예약 재연결 전) 보낸 요청도 하나의 연결로 가고, 승인 카드가 뜨고 승인하면 실행되며 앞 기록을 잇는다",
    pages,
    async run(h) {
      await h.turn([], { path: "/t", text: "첫 요청 A1" });
      await slowReconnect(h);
      const bgConnBefore = count(h.logs, "[SBP port:connect]");
      await drop(h, { reconnect: false });
      const r = await h.turn(clickOk, { noReload: true, approve: true, maxWaitMs: 6000, text: "둘째" });
      expect(r.cards === 1, `승인 카드가 패널에 떠야 한다(cards=${r.cards})`);
      expect(r.out === "눌림", `승인 뒤 실행(out='${r.out}')`);
      expect(count(h.panelLogs, "port:connect] 즉석") === 1, `즉석 연결 한 번(${h.panelLogs.filter((l) => l.includes("port:connect")).join(" | ")})`);
      expect(count(h.logs, "[SBP port:connect]") - bgConnBefore === 1, "백그라운드 연결도 하나");
      expect((await lastReq(h)).includes("첫 요청 A1"), "즉석 경로도 resume을 거쳐 앞 기록을 잇는다");
      // 예약 재연결 시각(8초)이 지나도 연결을 더 열지 않는다(예약 타이머 취소).
      await new Promise((r) => setTimeout(r, 8500));
      expect(count(h.panelLogs, "port:connect] 예약") === 0, "예약 재연결이 겹치지 않는다");
      expect(count(h.logs, "[SBP port:connect]") - bgConnBefore === 1, "8초 뒤에도 백그라운드 연결 하나");
    },
  },
  {
    name: "즉석 재연결 뒤 중단·새 대화도 그 연결의 대화에 닿는다",
    pages,
    async run(h) {
      await h.turn([], { path: "/t", text: "첫 요청 A1" });
      await slowReconnect(h);
      await drop(h, { reconnect: false });
      const r = await h.turn(clickOk, { noReload: true, maxWaitMs: 6000, keepRunning: true, text: "둘째" });
      expect(r.stoppedAtCard, "승인 카드에서 멈춤");
      const ends = count(h.logs, "[SBP turn:end]");
      await h.panel.click("button.composer-btn.danger");
      await waitFor(async () => count(h.logs, "[SBP turn:end]") > ends, 3000, "중단이 백그라운드 대화에 닿음(turn:end)");
      expect(!(await h.panel.locator("button.composer-btn.danger").count()), "응답 중 표시가 꺼짐");
      await h.panel.click("button[title='새 대화']");
      await h.turn([], { noReload: true, text: "셋째" });
      const msgs = await lastReq(h);
      expect(!msgs.includes("첫 요청 A1") && !msgs.includes("둘째"), "새 대화는 앞 기록이 없다(reset_conversation이 그 연결에 닿음)");
    },
  },
  {
    name: "같은 워커에서 끊겼다 다시 붙으면 앞 대화 기록을 잇는다(안내 없음)",
    pages,
    async run(h) {
      await h.turn([], { path: "/t", text: "첫 요청 A1" });
      await drop(h);
      expect(h.logs.some((l) => l.includes("conversation:resumed")), "백그라운드가 이어 씀");
      await h.turn([], { noReload: true, text: "둘째" });
      expect((await lastReq(h)).includes("첫 요청 A1"), "둘째 요청의 기록에 첫 요청이 있다");
      expect((await lostCount(h)) === 0, "안내 없음");
    },
  },
  {
    name: "다시 붙어도 대화 허락은 지워져 같은 도구를 다시 묻고, 승인 전에는 실행하지 않는다",
    pages,
    async run(h) {
      await h.settings({ runMode: "ask" });
      const rl = [{ tool: "read_linked_pages", args: { urls: [`${h.base}/doc`] } }, { text: "읽음" }];
      const r1 = await h.turn(rl, { path: "/t", onCard: (c) => c.locator(".btn-approve-chat").click() });
      expect(r1.cards === 1, `첫 읽기는 카드(허락 선택, cards=${r1.cards})`);
      const r1b = await h.turn(rl, { noReload: true });
      expect(r1b.cards === 0 && !r1b.stoppedAtCard, "허락한 대화에서는 다시 묻지 않는다(기준 확인)");
      await drop(h);
      expect(h.logs.some((l) => l.includes("conversation:resumed")), "기록은 이음");
      expect((await h.panel.locator(".chat-grant-bar").count()) === 0, "패널 허락 표시 없음");
      const hitsBefore = h.hits.filter((x) => x === "1/doc").length;
      const seen = [];
      const r2 = await h.turn(rl, { noReload: true, keepRunning: true, onCard: async (c) => { seen.push(await c.innerText()); throw new Fail("stop"); } }).catch(() => null);
      void r2;
      expect(seen.length === 1 && !seen[0].includes("작업 맡기기"), `허락이 지워져 링크 읽기 카드가 다시 뜬다(${seen[0]?.slice(0, 80)})`);
      expect(h.hits.filter((x) => x === "1/doc").length === hitsBefore, "승인 전 링크를 받지 않음");
      await h.panel.locator(".tool-pending:not(.resolved) .btn-cancel").click();
    },
  },
  {
    name: "다시 붙어도 맡긴 작업은 지워져 맡기기 카드가 다시 뜨고, 승인 전에는 실행하지 않는다",
    pages,
    async run(h) {
      await h.settings({ runMode: "task" });
      const r1 = await h.turn([{ tool: "confirm_task", args: { summary: "누르기", risks: [] } }, ...clickOk], { path: "/t", approve: true });
      expect(r1.cards === 1 && r1.out === "눌림", `맡긴 뒤 실행(cards=${r1.cards}, out=${r1.out})`);
      await h.tab.evaluate(() => (document.getElementById("out").textContent = ""));
      await drop(h);
      expect(!(await h.panel.locator(".task-bar").count()), "맡김 표시가 지워짐");
      const seen = [];
      const r2 = await h.turn(clickOk, { noReload: true, keepRunning: true, onCard: async (c) => { seen.push(await c.innerText()); throw new Fail("stop"); } }).catch(() => null);
      void r2;
      expect(seen.length === 1 && seen[0].includes("작업 맡기기"), `맡기기 카드가 다시 뜬다(${seen[0]?.slice(0, 60)})`);
      expect((await h.tab.locator("#out").innerText()) === "", "승인 전 클릭 없음");
      await h.panel.locator(".tool-pending:not(.resolved) .btn-cancel").click();
    },
  },
  {
    name: "다시 붙어도 외부 본문 보호는 남아 자동 실행 대신 카드로 묻는다(잃은 대화와 대조)",
    pages,
    async run(h) {
      await h.settings({ runMode: "auto" });
      await h.turn([{ tool: "read_linked_pages", args: { urls: [`${h.base}/doc`] } }, { text: "읽음" }], { path: "/t", approve: true });
      await drop(h);
      const r = await h.turn(clickOk, { noReload: true });
      expect(r.stoppedAtCard && r.out === "", `보호가 남아 카드로 묻는다(cards=${r.cards}, out='${r.out}')`);
      // 대조: 기록을 잃은 새 대화는 보호가 없어 같은 사이트 클릭을 자동 실행한다.
      await drop(h, { forget: true });
      const r2 = await h.turn(clickOk, { noReload: true });
      expect(!r2.stoppedAtCard && r2.out === "눌림", `잃은 대화는 보호 없음(out='${r2.out}')`);
    },
  },
  {
    name: "다시 붙어도 디버깅 취소 선택은 남아 다음 클릭을 스크립트로 누른다",
    pages,
    async run(h) {
      await h.settings({ autoApprove: true, trustedInput: true });
      const r1 = await h.turn(clickOk, { path: "/t" });
      expect(r1.logs.some((l) => l.includes("tool:result") && l.includes("· 실제 입력")), "첫 클릭은 실제 입력");
      await h.sw.evaluate(() => globalThis.__sbpPorts.cancelInput());
      await drop(h);
      expect(h.logs.some((l) => l.includes("conversation:resumed")), "기록을 이음");
      const r2 = await h.turn(clickOk, { noReload: true });
      const line = [...r2.logs].reverse().find((l) => l.includes("tool:result") && l.includes(" click_element ")) ?? "";
      expect(line.includes("스크립트 클릭(사용자가 이 대화에서 디버깅을 취소함)"), `디버거를 다시 붙이지 않음(${line})`);
      expect((await h.sw.evaluate(() => globalThis.__sbpPorts.inputCanceled())).every(Boolean), "이어 쓴 대화의 취소 선택 유지");
    },
  },
  {
    name: "보관이 없으면 안내하고 새 대화로 — 새 요청 전 반복 유실은 안내 한 번, 새 요청 뒤 다시 잃으면 다시",
    pages,
    async run(h) {
      await h.turn([], { path: "/t", text: "첫 요청 A1" });
      await drop(h, { forget: true });
      expect((await lostCount(h)) === 1, `안내 1개(${await lostCount(h)})`);
      await drop(h, { forget: true });
      expect((await lostCount(h)) === 1, `새 요청 전 반복 유실은 그대로 1개(${await lostCount(h)})`);
      await h.turn([], { noReload: true, text: "둘째" });
      expect(!(await lastReq(h)).includes("첫 요청 A1"), "잃은 뒤 요청에는 앞 기록이 없다");
      await drop(h, { forget: true });
      expect((await lostCount(h)) === 2, `새 요청 뒤 다시 잃으면 안내 2개(${await lostCount(h)})`);
    },
  },
  {
    name: "승인 대기 중 끊기면 잇지 않고, 패널은 중단 없이 다음 요청을 보낼 수 있다",
    pages,
    async run(h) {
      const r = await h.turn(clickOk, { path: "/t", keepRunning: true, text: "첫 요청 A1" });
      expect(r.stoppedAtCard, "승인 카드에서 멈춤");
      await drop(h);
      expect((await h.sw.evaluate(() => globalThis.__sbpPorts.parkedCount())) === 0, "진행 중 대화는 보관하지 않음");
      expect(!(await h.panel.locator("button.composer-btn.danger").count()), "응답 중 표시가 꺼짐");
      expect((await h.panel.locator(".tool-pending:not(.resolved)").count()) === 0, "미결 카드 없음(취소로 닫힘)");
      const info = await h.panel.locator(".msg-info").filter({ hasText: LOST }).first().innerText();
      expect(info.includes("진행 중이던 요청을 멈췄습니다"), `진행 중 안내(${info})`);
      expect(h.logs.some((l) => l.includes("port:prev_disconnect") && l.includes("대화 진행 중") && l.includes("보관 안 함")), "백그라운드 끊김 기록");
      await h.turn([], { noReload: true, text: "둘째" });
      expect(!(await lastReq(h)).includes("첫 요청 A1"), "다음 요청은 새 대화");
    },
  },
  {
    name: "모델 응답 중 끊겨도 응답 중 표시가 꺼지고 다음 요청을 보낼 수 있다",
    pages,
    async run(h) {
      await h.tab.goto(`${h.base}/t`);
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ delayMs: 3000, text: "늦은 답" }];
      });
      await h.panel.fill("textarea.composer-input", "첫 요청 A1");
      await h.panel.click("button.composer-btn.primary");
      await waitFor(async () => (await h.panel.locator("button.composer-btn.danger").count()) > 0, 3000, "응답 중");
      await drop(h);
      expect(!(await h.panel.locator("button.composer-btn.danger").count()), "응답 중 표시가 꺼짐");
      expect((await lostCount(h)) === 1, "안내");
      await h.turn([{ text: "답" }], { noReload: true, text: "둘째" });
      expect(!(await lastReq(h)).includes("첫 요청 A1"), "다음 요청은 새 대화");
    },
  },
  {
    name: "진단 줄: 워커 식별자·가동·이전 끊김·heartbeat·visibility, 대화 글자는 없다",
    pages,
    async run(h) {
      await h.turn([], { path: "/t", text: "첫 요청 A1" });
      await drop(h);
      const bg = h.logs.filter((l) => l.includes("port:connect") || l.includes("port:prev_disconnect"));
      expect(bg.some((l) => /\[SBP port:connect\] worker [0-9a-f]{8} · 가동 \d+초 · 이 워커의 \d+번째 연결/.test(l)), `워커 식별자(${bg.join(" | ")})`);
      expect(bg.some((l) => l.includes("port:prev_disconnect") && l.includes("백그라운드가 끊김을 봄") && l.includes("기록 보관")), "이전 끊김 기록");
      const disc = h.panelLogs.find((l) => l.includes("port:disconnect")) ?? "";
      expect(disc.includes("연결 유지") && disc.includes("heartbeat") && disc.includes("visibility") && disc.includes("끊김 쪽"), `패널 끊김 줄(${disc})`);
      expect(h.panelLogs.some((l) => l.includes("worker:same")), "같은 워커");
      const all = [...bg, ...h.panelLogs].join("\n");
      expect(!all.includes("첫 요청 A1"), "진단 줄에 대화 글자가 없다");
    },
  },
];
