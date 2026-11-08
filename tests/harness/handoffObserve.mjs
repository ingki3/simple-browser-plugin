// 손 넘기기 감시 해제 관측(#263 단계 5, 계획 R5-2·R5-3): 서비스 워커 안에서 chrome.tabs.sendMessage와 팝업 감시가 쓰는
// 세 이벤트(chrome.tabs.onCreated, chrome.webNavigation.onCreatedNavigationTarget·onBeforeNavigate)의 addListener/removeListener를
// 감싸 순번(seq)과 함께 기록한다. 제품 코드는 바꾸지 않는다. 턴을 보내기 전에 install, 시나리오 finally에서 restore.
import { Fail, expect } from "./lib.mjs";

const EVENTS = ["tabs.onCreated", "webNavigation.onCreatedNavigationTarget", "webNavigation.onBeforeNavigate"];

export async function installHandoffObserver(h) {
  const res = await h.sw.evaluate((events) => {
    if (globalThis.__hoObs) throw new Error("손 넘기기 관측이 이미 설치돼 있습니다(앞 시나리오가 원복하지 않음)");
    const o = { seq: 0, log: [], restore: [], ids: new WeakMap(), nextId: 1, wrapped: {} };
    const fnId = (fn) => {
      if (!o.ids.has(fn)) o.ids.set(fn, o.nextId++);
      return o.ids.get(fn);
    };
    // obj[key]를 감싼다. 원복은 원래 자기 속성이었으면 그 설명자로, 아니면(프로토타입 메서드) 자기 속성을 지운다.
    const wrap = (obj, key, make) => {
      const own = Object.getOwnPropertyDescriptor(obj, key);
      const orig = obj[key];
      obj[key] = make(orig);
      o.restore.push({ obj, key, own, orig });
      return obj[key] !== orig;
    };
    const send = wrap(chrome.tabs, "sendMessage", (orig) =>
      function (tabId, msg, ...rest) {
        if (msg && typeof msg.kind === "string" && msg.kind.startsWith("handoff_")) {
          o.log.push({ seq: ++o.seq, kind: "msg", msg: msg.kind, token: msg.token, at: Date.now() });
        }
        return orig.call(this, tabId, msg, ...rest);
      },
    );
    o.wrapped.sendMessage = send;
    for (const name of events) {
      const [ns, ev] = name.split(".");
      const target = chrome[ns][ev];
      const a = wrap(target, "addListener", (orig) =>
        function (fn, ...rest) {
          o.log.push({ seq: ++o.seq, kind: "add", event: name, fn: fnId(fn), at: Date.now() });
          return orig.call(this, fn, ...rest);
        },
      );
      const r = wrap(target, "removeListener", (orig) =>
        function (fn, ...rest) {
          o.log.push({ seq: ++o.seq, kind: "remove", event: name, fn: fnId(fn), at: Date.now() });
          return orig.call(this, fn, ...rest);
        },
      );
      o.wrapped[name] = a && r;
    }
    globalThis.__hoObs = o;
    return o.wrapped;
  }, EVENTS);
  // 사전 조건 4: 대입이 실제로 원본을 감쌌는지(막혀 있으면 이 관측은 쓸 수 없다 — 통과로 치지 않는다).
  for (const [k, ok] of Object.entries(res)) if (!ok) throw new Fail(`관측 실패: ${k}를 감싸지 못함`);
}

// 턴 시작 표시(턴 전 등록 집합의 경계). 턴을 보내기 직전에 부른다.
export const markTurnStart = (h) =>
  h.sw.evaluate(() => {
    const o = globalThis.__hoObs;
    o.log.push({ seq: ++o.seq, kind: "mark", at: Date.now() });
  });

export async function restoreHandoffObserver(h) {
  const ok = await h.sw.evaluate(() => {
    const o = globalThis.__hoObs;
    if (!o) return true;
    for (const { obj, key, own } of [...o.restore].reverse()) {
      if (own) Object.defineProperty(obj, key, own);
      else delete obj[key];
    }
    const back = o.restore.every(({ obj, key, orig }) => obj[key] === orig);
    delete globalThis.__hoObs;
    return back;
  });
  if (!ok) throw new Fail("관측 원복 실패(원본으로 돌아오지 않음)");
}

const readLog = (h) => h.sw.evaluate(() => globalThis.__hoObs.log);

// 손 넘기기 한 번(턴 시작 표시 뒤 첫 handoff_show)의 감시가 모두 거둬졌는지 본다(R5-3). popups: 클릭 손 넘기기라 팝업 감시가 붙었는지.
// 턴이 끝난 뒤 부른다. POLL_MS(500ms)×3 동안 그 token의 handoff_status가 없어야 한다(첫 폴링 전에 해제됐어야 함).
// 돌려줌: { token, showAt, endAt }.
// noStatusAfterEnd: 카드가 떠 있던 동안 폴링이 돌았던 경로(패널 취소·중단)용 — 해제(handoff_end) 뒤 300ms가 지나서 보낸 그 token의
// handoff_status가 없어야 한다(해제 순간 이미 돌던 한 번은 몇 ms 안에 끝난다 — 폴링이 계속되면 500ms 간격으로 이어진다).
export async function checkHandoffReleased(h, { popups = true, statusFree = true, noStatusAfterEnd = false, waitMs = 1500 } = {}) {
  await h.panel.waitForTimeout(waitMs);
  const log = await readLog(h);
  const mark = log.find((e) => e.kind === "mark");
  if (!mark) throw new Fail("관측 실패: 턴 시작 표시 없음");
  const show = log.find((e) => e.seq > mark.seq && e.kind === "msg" && e.msg === "handoff_show");
  if (!show) throw new Fail(`관측 실패: 턴 시작 뒤 handoff_show 없음(${JSON.stringify(log.filter((e) => e.kind === "msg"))})`);
  const token = show.token;
  const ofToken = (m) => log.filter((e) => e.kind === "msg" && e.msg === m && e.token === token);
  const ends = ofToken("handoff_end");
  expect(ends.length === 1, `표시 해제(handoff_end) 1회(${ends.length})`);
  if (statusFree) {
    const polls = ofToken("handoff_status");
    expect(polls.length === 0, `감시 해제: 그 token의 handoff_status 0회(${polls.length}) — stopWatch가 빠지면 폴링이 돈다`);
  }
  if (noStatusAfterEnd && ends[0]) {
    const late = ofToken("handoff_status").filter((e) => e.at > ends[0].at + 300);
    expect(late.length === 0, `감시 해제: 표시 해제 뒤 handoff_status ${late.length}회 — stopWatch가 빠지면 폴링이 이어진다`);
  }
  // 턴 전에 살아 있던 리스너(설치 뒤 ~ 표시 전 add, remove 없음).
  const liveAt = (seq) => {
    const live = new Map();
    for (const e of log) {
      if (e.seq >= seq) break;
      const key = `${e.event}#${e.fn}`;
      if (e.kind === "add") live.set(key, e);
      else if (e.kind === "remove") live.delete(key);
    }
    return live;
  };
  const before = liveAt(mark.seq);
  if (popups) {
    const cands = log.filter((e) => e.kind === "add" && e.seq > mark.seq && e.seq < show.seq && !before.has(`${e.event}#${e.fn}`));
    // 사전 조건 1: 이벤트별 정확히 1개.
    for (const name of EVENTS) {
      const n = cands.filter((e) => e.event === name).length;
      if (n !== 1) throw new Fail(`관측 실패: ${name} 후보 ${n}개(정확히 1개여야 함) ${JSON.stringify(cands)}`);
    }
    // 사전 조건 2: 세 등록이 연속 순번이고 popups.ts 순서(onCreated → onCreatedNavigationTarget → onBeforeNavigate).
    const three = EVENTS.map((name) => cands.find((e) => e.event === name));
    if (!(three[1].seq === three[0].seq + 1 && three[2].seq === three[1].seq + 1)) {
      throw new Fail(`관측 실패: 팝업 감시 등록이 연속이 아님 ${JSON.stringify(three.map((e) => e.seq))}`);
    }
    // 사전 조건 3: 세 등록이 handoff_show보다 앞선다(후보를 그 앞에서만 골랐으므로 성립 — 명시적으로 다시 본다).
    if (!three.every((e) => e.seq < show.seq)) throw new Fail("관측 실패: 팝업 감시 등록이 handoff_show 뒤");
    // 판정: 고른 세 함수가 모두 해제됐다.
    for (const e of three) {
      const removed = log.some((x) => x.kind === "remove" && x.event === e.event && x.fn === e.fn && x.seq > e.seq);
      expect(removed, `팝업 감시 해제: ${e.event} 리스너가 남음 — popups.stop이 빠지면 남는다`);
    }
  }
  // 보조: 턴 전 집합 = 지금 집합(세 이벤트).
  const after = liveAt(Infinity);
  const extra = [...after.keys()].filter((k) => !before.has(k));
  expect(!extra.length, `턴 뒤 남은 리스너 없음(${extra.join(",")})`);
  return { token, showAt: show.at, endAt: ends[0]?.at };
}

// 페이지(대상 탭)에 손 넘기기 표시 상자가 남았는지(content/handoff.ts의 호스트: fixed·z-index 최대·pointer-events none).
export const handoffBoxes = (page) =>
  page.evaluate(() => [...document.querySelectorAll("div")].filter((d) => d.style.zIndex === "2147483647" && d.style.pointerEvents === "none" && d.style.position === "fixed").length);

// 원격 작업 탭(remoteRunner가 chrome://newtab/으로 여는 탭)을 시험 페이지로 연다. 돌려준 함수로 원복한다(뒤 시나리오에 새지 않게).
export async function remoteTabAt(h, url) {
  await h.sw.evaluate((url) => {
    const realCreate = chrome.tabs.create;
    globalThis.__hoRealCreate = realCreate;
    chrome.tabs.create = async (p) => {
      if (p?.url !== "chrome://newtab/") return realCreate.call(chrome.tabs, p);
      const tab = await realCreate.call(chrome.tabs, { ...p, url });
      for (let i = 0; i < 50; i++) {
        const t = await chrome.tabs.get(tab.id);
        if (t.url === url && !t.pendingUrl && t.status === "complete") return t;
        await new Promise((r) => setTimeout(r, 100));
      }
      return tab;
    };
  }, url);
  return () =>
    h.sw.evaluate(() => {
      if (globalThis.__hoRealCreate) chrome.tabs.create = globalThis.__hoRealCreate;
      delete globalThis.__hoRealCreate;
    });
}

// 원격 요청이 직접 조작할 사이트에서 클릭했을 때(R5): 손 넘기기 카드 대신 거절로 풀리고 표시·감시를 거뒀는지.
// from: 턴 전 h.logs 길이. url: 작업 탭 주소. 원격 채널의 질문 0은 호출처가 본다.
export async function checkRemoteHandoffRefused(h, { from, url }) {
  const rel = await checkHandoffReleased(h);
  // ① 대기 등록 순서: 거절 타이머(setTimeout 0)가 등록된 대기를 바로 푼다 — 첫 폴링(500ms) 전에 표시를 거둔다.
  expect(rel.endAt - rel.showAt < 400, `거절이 바로 닿음(표시 → 해제 ${rel.endAt - rel.showAt}ms) — 대기 등록이 거절 타이머 뒤면 풀리지 않는다`);
  const t = await h.sw.evaluate(() => [...globalThis.__toolLog].reverse().find((x) => x.name === "click_element") ?? null);
  expect(t && t.error === "remote_needs_approval" && t.result === undefined && String(t.note ?? "").includes("원격(텔레그램·MCP)"), `클릭은 원격 거절 결과(${JSON.stringify(t)})`);
  const choices = await h.sw.evaluate(() => globalThis.__modelReqs.filter((r) => !r.body.response_format).map((r) => r.body.tool_choice ?? null));
  expect(choices.filter((c) => c === "none").length === 1 && choices.at(-1) === "none", `마무리 요청(tool_choice none) 1개, 마지막(${JSON.stringify(choices)})`);
  const lines = h.logs.slice(from);
  expect(lines.some((l) => l.includes("[SBP tool:handoff]")), "손 넘기기 경로로 감");
  expect(lines.some((l) => l.includes("[SBP remote:refuse]")), "카드 대신 원격 거절");
  expect(lines.some((l) => l.includes("[SBP tool:handoff_result] click_element cancelled")), `손 넘기기 결과는 취소(${lines.filter((l) => l.includes("handoff")).join(" | ")})`);
  expect((await h.panel.locator(".tool-pending").count()) === 0, "패널 카드 없음");
  const page = h.ctx.pages().find((p) => p.url() === url);
  expect(!!page, `작업 탭(${url})`);
  expect((await page.locator("#out").innerText()) === "", "누르지 않음");
  expect((await handoffBoxes(page)) === 0, "작업 탭에 표시가 남지 않음");
}
