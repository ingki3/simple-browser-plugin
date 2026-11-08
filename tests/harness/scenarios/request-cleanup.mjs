// 모델 요청 정리(#266): 요청 준비 중 예외·연결 실패로 끝난 뒤 연결 타이머와 "진행 중 모델 요청" 표시(activeRequest)가 남지 않는다.
// 남으면 대화가 쉬는 상태(idle)로 돌아오지 않아 패널 연결이 끊겼을 때 보관되지 않고(#243), 남은 타이머가 나중에 그 요청을 끊는다.
// 다음 요청의 cancelInFlight가 남은 표시를 지우므로 **다음 요청 전에** 본다(패널 연결을 끊어 보관되는지 — panel-reconnect 방식).
import { expect, waitUntil } from "../lib.mjs";

const PAGE = `<title>T</title><main><p>요청 정리 시험 페이지</p><p id=out></p></main>`;
const pages = { "/t": PAGE };
// 하네스 기본 제공자(OpenRouter)의 연결 제한(chatAgent requestModel CONNECT_TIMEOUT_MS, timeoutScale 1).
const CONNECT_MS = 20_000;
// 로컬 서버 제공자(timeoutScale 2). 바꾼 뒤 주소 59998은 하네스 모의 fetch가 연결 거부로 끝낸다.
const LOCAL_CONNECT_MS = 40_000;
const REFUSED = "http://127.0.0.1:59998/v1";
const INJECTED = "하네스 주입: 설정 읽기 실패";

const waitFor = (cond, ms, what) => waitUntil(cond, { timeoutMs: ms, intervalMs: 50, label: what });
const count = (arr, needle) => arr.filter((l) => l.includes(needle)).length;

// 서비스 워커의 setTimeout·clearTimeout을 감싸 delays에 든 지연의 타이머 중 아직 남은(지우지도 울리지도 않은) 것을 센다.
async function trackTimers(h, delays) {
  await h.sw.evaluate((delays) => {
    if (globalThis.__timerTrack) return;
    const st = globalThis.setTimeout;
    const ct = globalThis.clearTimeout;
    const pending = new Map();
    const t = { st, ct, pending, fired: 0 };
    globalThis.__timerTrack = t;
    globalThis.setTimeout = function (fn, delay, ...a) {
      if (typeof fn !== "function" || !delays.includes(delay)) return st.call(globalThis, fn, delay, ...a);
      let id;
      const wrapped = (...x) => {
        pending.delete(id);
        t.fired += 1;
        return fn(...x);
      };
      id = st.call(globalThis, wrapped, delay, ...a);
      pending.set(id, delay);
      return id;
    };
    globalThis.clearTimeout = function (id) {
      pending.delete(id);
      return ct.call(globalThis, id);
    };
  }, delays);
}
const pendingTimers = (h) => h.sw.evaluate(() => ({ pending: globalThis.__timerTrack?.pending.size ?? -1, fired: globalThis.__timerTrack?.fired ?? -1 }));
async function untrackTimers(h) {
  await h.sw.evaluate(() => {
    const t = globalThis.__timerTrack;
    if (!t) return;
    globalThis.setTimeout = t.st;
    globalThis.clearTimeout = t.ct;
    globalThis.__timerTrack = undefined;
  });
}

// 요청 준비 중 예외 주입: 저장 링크 후보 읽기(requestModel의 첫 기다림 candidatesMessage → savedPages 읽기)를 한 번 붙잡는다.
// failSettings면 붙잡은 동안 설정 캐시를 무효화하고(대상과 무관한 키를 써서 저장소 변경 알림), 놓을 때 다음 설정 읽기 한 번이 던지게 한다 —
// 그 다음 읽기가 requestModel의 getSettings(후보 조회 바로 뒤)다. hold면 __releasePrepGate()를 부를 때까지 붙잡아 둔다.
async function armPrepGate(h, { failSettings = false, hold = false } = {}) {
  await h.sw.evaluate(
    ({ failSettings, hold, injected }) => {
      const area = chrome.storage.local;
      const orig = globalThis.__localGetOrig ?? area.get;
      globalThis.__localGetOrig = orig;
      globalThis.__prepGateHits = 0;
      globalThis.__settingsFails = 0;
      globalThis.__prepGateArmed = true;
      globalThis.__failSettings = false;
      const keysOf = (keys) => (keys == null ? [] : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys));
      area.get = async function (keys, ...rest) {
        const list = keysOf(keys);
        if (globalThis.__failSettings && list.includes("settings")) {
          globalThis.__settingsFails += 1;
          throw new Error(injected);
        }
        if (globalThis.__prepGateArmed && list.includes("savedPages")) {
          globalThis.__prepGateArmed = false;
          globalThis.__prepGateHits += 1;
          if (hold) await new Promise((r) => (globalThis.__releasePrepGate = r));
          if (failSettings) {
            // 먼저 설정 읽기를 실패로 돌린 뒤 캐시를 무효화한다 — 그 사이 다른 읽기가 캐시를 다시 채우지 못한다(실패한 읽기는 캐시에 넣지 않음).
            const cur = (await orig.call(area, "settings")).settings ?? {};
            globalThis.__failSettings = true;
            await chrome.storage.local.set({ settings: { ...cur, __harnessTouch: Date.now() } });
            // 변경 알림(설정 캐시 무효화)이 돌 시간을 준다.
            await new Promise((r) => setTimeout(r, 150));
          }
        }
        return orig.call(area, keys, ...rest);
      };
    },
    { failSettings, hold, injected: INJECTED },
  );
}
async function disarmPrepGate(h) {
  await h.sw.evaluate(() => {
    globalThis.__prepGateArmed = false;
    globalThis.__failSettings = false;
    globalThis.__releasePrepGate?.();
    if (globalThis.__localGetOrig) chrome.storage.local.get = globalThis.__localGetOrig;
    globalThis.__localGetOrig = undefined;
  });
}

// 백그라운드에서 패널 연결을 끊고(쉬던 대화는 보관, 진행 중이면 버림) 패널이 다시 붙을 때까지 기다린다. 보관했는지 돌려준다.
async function dropAndCheckParked(h) {
  const conn = count(h.panelLogs, "port:connect]");
  const prev = count(h.logs, "port:prev_disconnect");
  const n = await h.sw.evaluate(() => globalThis.__sbpPorts.dropPanelPorts());
  expect(n >= 1, `끊을 패널 연결이 있어야 한다(${n})`);
  await waitFor(async () => count(h.panelLogs, "port:connect]") > conn, 3000, "패널이 다시 연결");
  await waitFor(async () => count(h.logs, "port:prev_disconnect") > prev, 3000, "백그라운드 끊김 기록");
  await new Promise((r) => setTimeout(r, 300));
  const line = h.logs.filter((l) => l.includes("port:prev_disconnect")).at(-1) ?? "";
  return { parked: line.includes("기록 보관") && !line.includes("보관 안 함"), line, resumed: h.logs.some((l) => l.includes("conversation:resumed")) };
}

const panelText = (h) => h.panel.locator("body").innerText();
const lastReq = (h) => h.sw.evaluate(() => JSON.stringify((globalThis.__modelReqs ?? []).at(-1)?.body?.messages ?? []));

export default [
  {
    name: "요청 준비 중 설정 읽기가 던지면 연결 타이머·진행 중 요청을 지워 다음 요청 전 쉬는 대화로 보관된다",
    pages,
    async run(h) {
      await h.turn([{ text: "첫 답" }], { path: "/t", text: "첫 요청 P1" });
      await trackTimers(h, [CONNECT_MS]);
      try {
        await armPrepGate(h, { failSettings: true });
        const before = await h.sw.evaluate(() => globalThis.__modelReqs.length);
        await h.turn([{ text: "보내면 안 됨" }], { noReload: true, text: "둘째 요청" });
        await h.sw.evaluate(() => {
          globalThis.__failSettings = false;
        });
        const st = await h.sw.evaluate(() => ({ gate: globalThis.__prepGateHits, fails: globalThis.__settingsFails, reqs: globalThis.__modelReqs.length }));
        // 주입이 실제로 이 요청의 준비 단계에서 소비됐어야 한다(아니면 아무것도 보지 않은 시험).
        expect(st.gate === 1 && st.fails >= 1, `관측 실패: 주입이 소비되지 않음(후보 읽기 ${st.gate}, 설정 실패 ${st.fails})`);
        expect(st.reqs === before, `준비 실패라 요청을 보내지 않음(${before} → ${st.reqs})`);
        const text = await panelText(h);
        expect(text.includes(INJECTED), `오류 안내(${text.slice(-300)})`);
        expect(!text.includes("보내면 안 됨"), "답 없음");
        const t = await pendingTimers(h);
        await disarmPrepGate(h);
        // 다음 요청 전에 본다: 쉬는 대화면 끊김 때 보관되고 다시 붙으면 잇는다(두 증상을 한 번에 보고한다).
        const d = await dropAndCheckParked(h);
        expect(t.pending === 0 && d.parked, `남은 연결 타이머 없음(남음 ${t.pending}) · 쉬는 대화로 보관(${d.parked ? "보관" : d.line})`);
        expect(d.resumed, "다시 붙어 앞 대화를 잇는다");
        await h.turn([{ text: "셋째 답" }], { noReload: true, text: "셋째 요청" });
        expect((await panelText(h)).includes("셋째 답"), "다음 요청은 정상");
        expect((await lastReq(h)).includes("첫 요청 P1"), "다음 요청이 앞 기록을 잇는다");
        const t2 = await pendingTimers(h);
        expect(t2.fired === 0, `연결 타이머가 울리지 않음(${t2.fired})`);
      } finally {
        await disarmPrepGate(h);
        await untrackTimers(h);
      }
    },
  },
  {
    name: "연결 거절로 끝난 요청도 진행 중 요청을 지워 다음 요청 전 쉬는 대화로 보관된다",
    pages,
    async run(h) {
      await h.settings({ provider: "local", localServer: { baseUrl: REFUSED, model: "qwen3:8b" } });
      await trackTimers(h, [LOCAL_CONNECT_MS]);
      try {
        await h.turn([{ text: "보내면 안 됨" }], { path: "/t", text: "첫 요청 R1" });
        const sent = await h.sw.evaluate((u) => (globalThis.__modelReqs ?? []).filter((q) => q.url.startsWith(`${u}/`)).length, REFUSED);
        expect(sent >= 1, `거절된 주소로 연결을 시도함(${sent})`);
        const text = await panelText(h);
        expect(text.includes("Failed to fetch") || (await h.panel.locator(".msg-error").count()) > 0, `오류 안내(${text.slice(-300)})`);
        const t = await pendingTimers(h);
        expect(t.pending === 0, `남은 연결 타이머 없음(남음 ${t.pending})`);
        const d = await dropAndCheckParked(h);
        expect(d.parked, `쉬는 대화로 보관(${d.line})`);
        expect((await pendingTimers(h)).fired === 0, "연결 타이머가 울리지 않음");
      } finally {
        await untrackTimers(h);
      }
    },
  },
  {
    name: "응답 중 중단(회귀): 진행 중 요청이 지워져 쉬는 대화로 보관되고 연결 타이머가 남지 않는다",
    pages,
    async run(h) {
      await h.turn([{ text: "첫 답" }], { path: "/t", text: "첫 요청 S1" });
      await trackTimers(h, [CONNECT_MS]);
      try {
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ textParts: ["앞 조각 ", "뒤 조각"], gapMs: 0, holdAfter: 1 }];
        });
        await h.panel.fill("textarea.composer-input", "둘째 요청");
        await h.panel.click("button.composer-btn.primary");
        await waitFor(() => h.sw.evaluate(() => globalThis.__streamHeld === true), 5000, "스트림 붙잡힘");
        const ends = count(h.logs, "[SBP turn:end]");
        await h.panel.click("button.composer-btn.danger");
        await waitFor(async () => !(await h.panel.locator("button.composer-btn.danger").count()), 3000, "응답 중 표시 꺼짐");
        // 모의 스트림은 중단 신호를 따르지 않으므로 놓아 끝까지 읽힌 뒤 턴이 끝난다.
        await h.sw.evaluate(() => globalThis.__releaseStream?.());
        await waitFor(async () => count(h.logs, "[SBP turn:end]") > ends, 5000, "턴이 끝남");
        expect((await pendingTimers(h)).pending === 0, "남은 연결 타이머 없음");
        const d = await dropAndCheckParked(h);
        expect(d.parked, `쉬는 대화로 보관(${d.line})`);
      } finally {
        await h.sw.evaluate(() => globalThis.__releaseStream?.());
        await untrackTimers(h);
      }
    },
  },
  {
    name: "늦게 끝난 옛 요청의 준비 정리가 새 요청의 진행 중 표시를 지우지 않는다(중단하면 새 요청이 끊긴다)",
    pages,
    async run(h) {
      await h.tab.goto(`${h.base}/t`);
      await h.tab.waitForTimeout(200);
      try {
        await armPrepGate(h, { hold: true });
        // 모델 요청 신호를 남긴다(새 요청의 연결이 중단으로 끊겼는지 본다).
        await h.sw.evaluate(() => {
          const f = globalThis.fetch;
          globalThis.__fetchBeforeSig = f;
          globalThis.__sigs = [];
          globalThis.fetch = (url, init) => {
            if (/openrouter\.ai/.test(String(url)) && init?.signal) globalThis.__sigs.push(init.signal);
            return f(url, init);
          };
          globalThis.__steps = [];
        });
        await h.panel.fill("textarea.composer-input", "옛 요청");
        await h.panel.click("button.composer-btn.primary");
        await waitFor(() => h.sw.evaluate(() => globalThis.__prepGateHits === 1), 5000, "옛 요청이 준비 단계에서 붙잡힘");
        await h.panel.click("button.composer-btn.danger");
        await waitFor(async () => !(await h.panel.locator("button.composer-btn.danger").count()), 3000, "옛 요청 중단");
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ textParts: ["새 앞 ", "새 뒤"], gapMs: 0, holdAfter: 1 }];
        });
        await h.panel.fill("textarea.composer-input", "새 요청");
        await h.panel.click("button.composer-btn.primary");
        await waitFor(() => h.sw.evaluate(() => globalThis.__streamHeld === true), 5000, "새 요청 스트림 붙잡힘");
        const ends = count(h.logs, "[SBP turn:end]");
        // 옛 요청을 놓는다: 그 준비 정리(stale 반환)가 돈다.
        await h.sw.evaluate(() => globalThis.__releasePrepGate?.());
        await waitFor(async () => count(h.logs, "[SBP turn:end]") > ends, 3000, "옛 턴이 끝남");
        const sig = await h.sw.evaluate(() => ({ n: globalThis.__sigs.length, aborted: globalThis.__sigs.at(-1)?.aborted }));
        expect(sig.n === 1 && sig.aborted === false, `새 요청만 연결, 아직 열려 있음(${JSON.stringify(sig)})`);
        await h.panel.click("button.composer-btn.danger");
        await waitFor(async () => !(await h.panel.locator("button.composer-btn.danger").count()), 3000, "새 요청 중단");
        const after = await h.sw.evaluate(() => globalThis.__sigs.at(-1)?.aborted);
        expect(after === true, "중단이 새 요청의 연결을 끊는다(옛 요청 정리가 새 요청 표시를 지우지 않음)");
      } finally {
        await h.sw.evaluate(() => {
          globalThis.__releaseStream?.();
          if (globalThis.__fetchBeforeSig) globalThis.fetch = globalThis.__fetchBeforeSig;
          globalThis.__fetchBeforeSig = undefined;
        });
        await disarmPrepGate(h);
      }
    },
  },
];
