// 턴 시작 구간의 기다림 중 새 턴(#267): runUserTurn은 탭을 잡고(captureTurnTab) 가림 목록을 읽은(warmSecrets) 뒤 앞 턴의 팝업을
// 잇는다(inheritPopups). 그 기다림 사이 사용자가 중단하고 새 요청을 보내면 옛 턴은 아무것도 바꾸지 않고 조용히 끝나야 한다 —
// 새 턴의 탭 상태(this.turnTab·팝업)를 바꾸지 않고, 패널에 오류·답 끝(assistant_done)을 보내지 않는다.
// 가림 목록은 워커가 처음 읽을 때 한 번만 저장소를 읽으므로(캐시) 그 기다림은 새 워커(isolate)의 첫 턴에서만 생긴다 — 그때 앞 턴의
// 팝업은 없으니 옛 턴이 기다림 뒤 탭 처리로 넘어갔는지는 그 직후의 탭 로그(turn:tab)로 본다. 팝업을 실제로 잇는 경합은 탭 잡기
// 기다림에서 생기므로 그쪽은 따라가던 팝업을 둔 채 시험한다(옛 턴의 inheritPopups가 잇기에 성공하면 turn:popup 로그가 하나 더 남는다).
import { expect, findC, okResult, waitUntil } from "../lib.mjs";

const PAGE = `<title>T</title><main><p>턴 시작 시험 페이지</p><p id=out></p></main>`;
const INJECTED = "하네스 주입: 가림 목록 읽기 실패";

const waitFor = (cond, ms, what) => waitUntil(cond, { timeoutMs: ms, intervalMs: 50, label: what });
const count = (arr, needle) => arr.filter((l) => l.includes(needle)).length;
const panelText = (h) => h.panel.locator("body").innerText();
const responding = async (h) => (await h.panel.locator("button.composer-btn.danger").count()) > 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// 새 워커가 뜬 직후(가림 목록을 아직 읽기 전) 세션 저장소의 가림 목록 읽기를 감싼다. 무장하면 다음 한 번을 붙잡고
// __releaseSecretGate("ok" | "fail")로 놓는다("fail"이면 읽기가 던진다).
async function installSecretGate(sw) {
  await sw.evaluate((injected) => {
    const area = chrome.storage.session;
    const orig = area.get;
    globalThis.__secretGets = 0;
    globalThis.__secretGateArmed = false;
    globalThis.__secretGateHits = 0;
    globalThis.__releaseSecretGate = null;
    const keysOf = (keys) => (keys == null ? [] : Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys));
    area.get = async function (keys, ...rest) {
      if (keysOf(keys).includes("loginSecrets")) {
        globalThis.__secretGets += 1;
        if (globalThis.__secretGateArmed) {
          globalThis.__secretGateArmed = false;
          globalThis.__secretGateHits += 1;
          const how = await new Promise((r) => (globalThis.__releaseSecretGate = r));
          globalThis.__releaseSecretGate = null;
          if (how === "fail") throw new Error(injected);
        }
      }
      return orig.call(area, keys, ...rest);
    };
  }, INJECTED);
}

// 옛 턴의 가림 목록 읽기를 붙잡은 채 중단 → 새 요청(스트림 붙잡음) → 옛 읽기를 how로 놓는다.
async function secretsRace(h, how) {
  await h.tab.goto(`${h.base}/t`);
  await h.tab.waitForTimeout(200);
  // 아직 가림 목록을 읽지 않은 워커여야 첫 턴의 warmSecrets가 저장소를 읽는다(아니면 기다림이 없다).
  const cold = await h.sw.evaluate(() => globalThis.__secretGets);
  expect(cold === 0, `관측 실패: 첫 턴 전에 가림 목록을 이미 읽음(${cold})`);
  await h.sw.evaluate(() => {
    globalThis.__secretGateArmed = true;
    globalThis.__steps = [{ text: "옛 답 — 보내면 안 됨" }];
  });
  await h.panel.fill("textarea.composer-input", "옛 요청 글");
  await h.panel.click("button.composer-btn.primary");
  await waitFor(() => h.sw.evaluate(() => globalThis.__secretGateHits === 1), 5000, "옛 턴이 가림 목록 읽기에서 붙잡힘");
  // 붙잡은 것이 그 턴의 warmSecrets여야 한다(탭 로그는 그 뒤에 남는다).
  await pause(200);
  expect(count(h.logs, "[SBP turn:tab]") === 0, "붙잡은 동안 옛 턴은 탭 처리 전");
  await h.panel.click("button.composer-btn.danger");
  await waitFor(async () => !(await responding(h)), 3000, "옛 요청 중단");

  await h.sw.evaluate(() => {
    globalThis.__steps = [{ textParts: ["새 앞 ", "새 뒤"], gapMs: 0, holdAfter: 1 }];
  });
  await h.panel.fill("textarea.composer-input", "새 요청 글");
  await h.panel.click("button.composer-btn.primary");
  await waitFor(() => h.sw.evaluate(() => globalThis.__streamHeld === true), 5000, "새 요청 스트림 붙잡힘");
  expect(await h.sw.evaluate(() => typeof globalThis.__releaseSecretGate === "function"), "새 요청 동안 옛 턴은 여전히 붙잡혀 있음");
  const tabLogs = count(h.logs, "[SBP turn:tab]");
  expect(tabLogs === 1, `새 턴의 탭 로그 하나(${tabLogs})`);
  const ends = count(h.logs, "[SBP turn:end]");
  const reqs = await h.sw.evaluate(() => globalThis.__modelReqs.length);

  await h.sw.evaluate((how) => globalThis.__releaseSecretGate(how), how);
  await waitFor(async () => count(h.logs, "[SBP turn:end]") > ends, 5000, "풀린 옛 턴이 끝남");
  await pause(300);
  // 새 턴의 패널 상태가 그대로: 응답 중 표시가 남고 오류가 없다.
  const text = await panelText(h);
  const errs = await h.panel.locator(".msg-error").count();
  expect(errs === 0 && !text.includes("가림 목록을 읽지 못해"), `새 턴 패널에 오류 없음(오류 ${errs}개, 가림 목록 안내 ${text.includes("가림 목록을 읽지 못해")}, 응답 중 ${await responding(h)})`);
  expect(await responding(h), "새 턴은 여전히 응답 중으로 보임");
  const endLine = h.logs.filter((l) => l.includes("[SBP turn:end]")).at(-1) ?? "";
  expect(endLine.includes("aborted"), `옛 턴은 중단으로 끝남(${endLine})`);
  // 옛 턴이 기다림 뒤 앞 턴 팝업 잇기(inheritPopups)·탭 처리로 넘어가면 새 턴의 탭으로 탭 로그를 하나 더 남긴다.
  expect(count(h.logs, "[SBP turn:tab]") === tabLogs, `옛 턴은 가림 목록 기다림 뒤 탭 처리(inheritPopups)로 넘어가지 않음(탭 로그 ${tabLogs} → ${count(h.logs, "[SBP turn:tab]")})`);
  expect((await h.sw.evaluate(() => globalThis.__modelReqs.length)) === reqs, "옛 턴은 모델 요청을 하지 않음");

  await h.sw.evaluate(() => globalThis.__releaseStream?.());
  await waitFor(async () => !(await responding(h)), 5000, "새 턴이 끝남");
  const done = await panelText(h);
  expect(done.includes("새 앞 새 뒤") && !done.includes("옛 답"), `새 턴의 답이 끝까지 보임(${done.slice(-300)})`);
  expect((await h.panel.locator(".msg-error").count()) === 0, "끝난 뒤에도 오류 없음");
  // 기록: 다음 요청에 새 요청 글은 있고 옛 요청 글은 없다.
  await h.turn([{ text: "셋째 답" }], { noReload: true, text: "셋째 요청 글" });
  const all = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs.at(-1)?.body?.messages ?? []));
  expect(all.includes("새 요청 글") && !all.includes("옛 요청 글"), `기록에 새 요청만(${all.slice(0, 300)})`);
}

// 탭 잡기(captureTurnTab의 활성 탭 조회)를 한 번 붙잡는 게이트. 놓으면 원래 조회를 한다.
async function armCaptureGate(h) {
  await h.sw.evaluate(() => {
    const q = globalThis.__captureQueryOrig ?? chrome.tabs.query;
    globalThis.__captureQueryOrig = q;
    globalThis.__captureGateArmed = true;
    globalThis.__captureGateHits = 0;
    chrome.tabs.query = async (arg, ...rest) => {
      if (globalThis.__captureGateArmed && arg?.active && arg?.lastFocusedWindow) {
        globalThis.__captureGateArmed = false;
        globalThis.__captureGateHits += 1;
        await new Promise((r) => (globalThis.__releaseCapture = r));
        globalThis.__releaseCapture = null;
      }
      return q(arg, ...rest);
    };
  });
}
async function disarmCaptureGate(h) {
  await h.sw.evaluate(() => {
    globalThis.__captureGateArmed = false;
    globalThis.__releaseCapture?.();
    if (globalThis.__captureQueryOrig) chrome.tabs.query = globalThis.__captureQueryOrig;
    globalThis.__captureQueryOrig = undefined;
  });
}
async function closeExtraTabs(h) {
  for (const p of h.ctx.pages()) if (p !== h.tab && p !== h.panel) await p.close().catch(() => {});
  await h.tab.bringToFront();
}

export default [
  {
    name: "가림 목록을 읽는 사이 새 요청이 오면 옛 턴은 읽기가 성공해도 탭 처리 없이 조용히 끝나고 새 턴은 그대로 끝난다",
    pages: { "/t": PAGE },
    isolate: true,
    onWorker: installSecretGate,
    run: (h) => secretsRace(h, "ok"),
  },
  {
    name: "가림 목록을 읽는 사이 새 요청이 오면 옛 턴의 읽기가 실패해도 새 턴 패널에 오류·답 끝을 보내지 않는다",
    pages: { "/t": PAGE },
    isolate: true,
    onWorker: installSecretGate,
    run: (h) => secretsRace(h, "fail"),
  },
  {
    name: "탭을 잡는 사이 새 요청이 오면 옛 턴은 앞 턴의 팝업을 잇지 않는다(새 턴만 잇는다)",
    pages: {
      "/pp": `<title>예매</title><main><button onclick="window.open('/cal','cal','popup,width=420,height=320')">달력 열기</button><p id=out></p></main>`,
      "/cal": `<title>달력</title><main><button>10월 25일</button></main>`,
    },
    async run(h) {
      await closeExtraTabs(h);
      await h.settings({ autoApprove: true });
      const POPUP = "[SBP turn:popup]";
      try {
        const r = await h.turn([findC, { click: "달력 열기" }, { text: "열었습니다" }], { path: "/pp", text: "달력 열어 줘" });
        expect(okResult(r, "click_element").effect?.popup?.opened?.followed, "첫 턴이 팝업 창을 따라감");
        const tabLogs = count(h.logs, "[SBP turn:tab]");

        await armCaptureGate(h);
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ text: "옛 답 — 보내면 안 됨" }];
        });
        await h.panel.fill("textarea.composer-input", "옛 요청 글");
        await h.panel.click("button.composer-btn.primary");
        await waitFor(() => h.sw.evaluate(() => globalThis.__captureGateHits === 1), 5000, "옛 턴이 탭 잡기에서 붙잡힘");
        await pause(200);
        expect(count(h.logs, "[SBP turn:tab]") === tabLogs, "붙잡은 것이 옛 턴의 탭 잡기(탭 로그 전)");
        await h.panel.click("button.composer-btn.danger");
        await waitFor(async () => !(await responding(h)), 3000, "옛 요청 중단");

        const popups = count(h.logs, POPUP);
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ textParts: ["새 앞 ", "새 뒤"], gapMs: 0, holdAfter: 1 }];
        });
        await h.panel.fill("textarea.composer-input", "새 요청 글");
        await h.panel.click("button.composer-btn.primary");
        await waitFor(() => h.sw.evaluate(() => globalThis.__streamHeld === true), 5000, "새 요청 스트림 붙잡힘");
        expect(count(h.logs, POPUP) === popups + 1, `새 턴이 앞 턴의 팝업을 이음(${popups} → ${count(h.logs, POPUP)})`);
        const ends = count(h.logs, "[SBP turn:end]");
        const reqs = await h.sw.evaluate(() => globalThis.__modelReqs.length);

        await h.sw.evaluate(() => globalThis.__releaseCapture());
        await waitFor(async () => count(h.logs, "[SBP turn:end]") > ends, 5000, "풀린 옛 턴이 끝남");
        await pause(300);
        const endLine = h.logs.filter((l) => l.includes("[SBP turn:end]")).at(-1) ?? "";
        expect(endLine.includes("aborted"), `옛 턴은 중단으로 끝남(${endLine})`);
        // 옛 턴의 inheritPopups(앞 턴 탭 → 옛 턴이 잡은 탭)가 잇기에 성공하면 turn:popup이 하나 더 남는다.
        expect(count(h.logs, POPUP) === popups + 1, `옛 턴은 앞 턴의 팝업을 잇지 않음(turn:popup ${popups + 1} → ${count(h.logs, POPUP)})`);
        expect((await h.sw.evaluate(() => globalThis.__modelReqs.length)) === reqs, "옛 턴은 모델 요청을 하지 않음");
        expect(await responding(h), "새 턴은 여전히 응답 중으로 보임");
        expect((await h.panel.locator(".msg-error").count()) === 0, "새 턴 패널에 오류 없음");

        await h.sw.evaluate(() => globalThis.__releaseStream?.());
        await waitFor(async () => !(await responding(h)), 5000, "새 턴이 끝남");
        expect((await panelText(h)).includes("새 앞 새 뒤"), "새 턴의 답이 끝까지 보임");
        // 새 턴의 탭 상태가 그대로: 다음 요청도 그 팝업 창에서 이어 간다(머리말에 팝업 안내·달력 제목).
        await h.sw.evaluate(() => {
          globalThis.__modelReqs = [];
        });
        await h.turn([{ text: "날짜 봤습니다" }], { noReload: true, text: "날짜 골라 줘" });
        const asked = JSON.stringify(
          (await h.sw.evaluate(() => globalThis.__modelReqs.at(-1)?.body?.messages ?? [])).filter((m) => m.role === "user" && JSON.stringify(m.content).includes("날짜 골라 줘")),
        );
        expect(asked.includes("[팝업 창을 따라가는 중") && asked.includes("제목: 달력"), `다음 요청도 팝업 창에서(${asked.slice(0, 400)})`);
        expect(!asked.includes("옛 요청 글"), "옛 요청 글은 기록에 없음");
      } finally {
        await h.sw.evaluate(() => globalThis.__releaseStream?.());
        await disarmCaptureGate(h);
        await closeExtraTabs(h);
      }
    },
  },
];
