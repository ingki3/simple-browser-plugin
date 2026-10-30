// 주소 기반 동작 제안(#173): 사용자가 만든 규칙과 맞는 페이지에서 칩 → [실행]이면 백그라운드가 규칙·탭·문서를 다시 확인하고
// 저장된 요청을 보낸다. 맞지 않는 페이지·끈 규칙은 띄우지 않고, 바뀐 규칙·꺼진 설정·바뀐 페이지의 실행은 거절한다.
import { expect } from "../lib.mjs";

const article = `<title>글</title><main><h1>긴 영어 글</h1><p>Hello world</p><p id=out></p></main>`;

async function seedRule(h, patch = {}) {
  await h.sw.evaluate(
    async ({ base, patch }) => {
      await chrome.storage.local.set({
        pageSuggestions: [
          { id: "r1", origin: base, path: "/article/*", label: "번역해 드릴까요?", request: "이 글을 한국어로 번역해줘", enabled: true, version: 1, createdAt: 1, ...patch },
        ],
      });
    },
    { base: h.base, patch },
  );
}

// 패널 문서에서 채팅 포트를 하나 더 열어 실행 메시지를 직접 보낸다(백그라운드 확인 시험). 시작·실패 알림을 돌려준다.
async function rawRun(h, msg) {
  return h.panel.evaluate(
    (msg) =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: "chat" });
        const done = (v) => {
          port.disconnect();
          resolve(v);
        };
        port.onMessage.addListener((m) => {
          if ((m.kind === "suggestion_started" || m.kind === "suggestion_failed") && m.runId === msg.runId) done(m);
        });
        setTimeout(() => done({ kind: "timeout" }), 5000);
        chrome.windows.getCurrent().then((w) => port.postMessage({ kind: "suggestion_run", conversationId: "raw", windowId: w.id, ...msg }));
      }),
    msg,
  );
}

async function currentTabId(h) {
  return h.sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => /^https?:/.test(t.url ?? "") && t.active)?.id ?? tabs.find((t) => /^https?:/.test(t.url ?? ""))?.id;
  });
}

export default [
  {
    name: "페이지 제안(#173): 맞는 주소에서 칩 → 실행하면 저장된 요청을 보내고, 맞지 않는 주소·끈 제안은 띄우지 않는다",
    pages: { "/article/1": article, "/other": article },
    async run(h) {
      await h.settings({});
      await seedRule(h);
      await h.tab.goto(`${h.base}/other`);
      await h.panel.waitForTimeout(800);
      expect((await h.panel.locator(".suggestion-chip").count()) === 0, "맞지 않는 주소는 칩 없음");
      await h.tab.goto(`${h.base}/article/1?ref=x`);
      await h.panel.waitForSelector(".suggestion-chip", { timeout: 5000 });
      expect((await h.panel.locator(".suggestion-chip").innerText()).includes("번역해 드릴까요?"), "제안 문구");
      expect((await h.sw.evaluate(() => globalThis.__modelReqs.length)) === 0, "칩을 띄우는 데 모델을 부르지 않는다");
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ text: "번역했습니다" }];
      });
      await h.panel.locator(".suggestion-run").click();
      await h.panel.waitForFunction(() => !document.querySelector("button.composer-btn.danger") && document.querySelector(".bubble-assistant"), null, { timeout: 10_000 });
      const users = await h.panel.locator(".bubble-user").allInnerTexts();
      expect(users.length === 1 && users[0] === "이 글을 한국어로 번역해줘", `사용자 글(${JSON.stringify(users)})`);
      const sent = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs.at(-1)?.body?.messages ?? []));
      expect(sent.includes("이 글을 한국어로 번역해줘"), "모델이 규칙의 요청을 받는다");
      expect((await h.panel.locator(".suggestion-chip").count()) === 0, "실행한 페이지에서는 다시 띄우지 않는다");
      // 새로고침은 새 페이지 — 다시 뜬다. 끄면 안 뜬다.
      await h.tab.reload();
      await h.panel.waitForSelector(".suggestion-chip", { timeout: 5000 });
      await h.panel.locator(".suggestion-off").click();
      await h.panel.waitForTimeout(500);
      const rules = await h.sw.evaluate(async () => (await chrome.storage.local.get("pageSuggestions")).pageSuggestions);
      expect(rules[0].enabled === false && rules[0].version === 2, `꺼짐(${JSON.stringify(rules)})`);
      await h.tab.reload();
      await h.panel.waitForTimeout(800);
      expect((await h.panel.locator(".suggestion-chip").count()) === 0, "끈 제안은 띄우지 않는다");
    },
  },
  {
    name: "페이지 제안(#173): 실행 전 백그라운드가 규칙 버전·설정·탭 주소를 다시 확인한다(패널 글자는 쓰지 않음)",
    pages: { "/article/1": article },
    async run(h) {
      await h.settings({});
      await seedRule(h, { version: 3 });
      await h.tab.goto(`${h.base}/article/1`);
      await h.panel.waitForTimeout(600);
      const tabId = await currentTabId(h);
      const url = `${h.base}/article/1`;
      let r = await rawRun(h, { runId: "a", ruleId: "r1", ruleVersion: 2, tabId, url });
      expect(r.kind === "suggestion_failed" && r.message.includes("바뀌었습니다"), `옛 버전 거절(${JSON.stringify(r)})`);
      r = await rawRun(h, { runId: "b", ruleId: "r1", ruleVersion: 3, tabId, url: `${h.base}/article/2` });
      expect(r.kind === "suggestion_failed" && r.message.includes("페이지가 바뀌었습니다"), `다른 주소 거절(${JSON.stringify(r)})`);
      r = await rawRun(h, { runId: "c", ruleId: "nope", ruleVersion: 1, tabId, url });
      expect(r.kind === "suggestion_failed", `없는 규칙 거절(${JSON.stringify(r)})`);
      await h.settings({ pageSuggestions: false });
      r = await rawRun(h, { runId: "d", ruleId: "r1", ruleVersion: 3, tabId, url });
      expect(r.kind === "suggestion_failed" && r.message.includes("꺼져"), `설정 꺼짐 거절(${JSON.stringify(r)})`);
      await h.settings({ pageSuggestions: true });
      await h.sw.evaluate(() => {
        globalThis.__steps = [{ text: "끝" }];
      });
      r = await rawRun(h, { runId: "e", ruleId: "r1", ruleVersion: 3, tabId, url, text: "패널이 보낸 다른 글" });
      expect(r.kind === "suggestion_started" && r.text === "이 글을 한국어로 번역해줘", `규칙의 요청으로 시작(${JSON.stringify(r)})`);
    },
  },
  {
    name: "페이지 제안(#173): 내 요청 말풍선의 '이 페이지에서 제안'으로 규칙을 만든다(경로 기본값은 마지막 칸을 *로)",
    pages: { "/article/1": article, "/article/2": article },
    async run(h) {
      await h.settings({});
      await h.turn([{ text: "요약했습니다" }], { path: "/article/1", text: "이 글 세 줄로 요약해줘" });
      await h.panel.locator(".suggest-from-msg-open").click();
      expect((await h.panel.locator(".suggestion-path").inputValue()) === "/article/*", "경로 기본값");
      expect((await h.panel.locator(".suggestion-origin-fixed").innerText()) === h.base, "출처는 지금 탭");
      await h.panel.locator(".suggestion-label-input").fill("요약해 드릴까요?");
      await h.panel.locator(".suggestion-save").click();
      await h.panel.waitForTimeout(500);
      const rules = await h.sw.evaluate(async () => (await chrome.storage.local.get("pageSuggestions")).pageSuggestions);
      expect(rules?.length === 1 && rules[0].path === "/article/*" && rules[0].request === "이 글 세 줄로 요약해줘" && rules[0].label === "요약해 드릴까요?", `규칙(${JSON.stringify(rules)})`);
      await h.tab.goto(`${h.base}/article/2`);
      await h.panel.waitForSelector(".suggestion-chip", { timeout: 5000 });
      expect((await h.panel.locator(".suggestion-chip").innerText()).includes("요약해 드릴까요?"), "다른 글에서도 제안");
    },
  },
  {
    name: "페이지 제안(#173): 확인한 뒤 턴을 시작할 때 페이지가 바뀌었으면 기록·모델 요청 없이 멈춘다",
    pages: { "/article/1": article },
    async run(h) {
      await h.settings({});
      await seedRule(h);
      await h.tab.goto(`${h.base}/article/1`);
      await h.panel.waitForTimeout(600);
      const tabId = await currentTabId(h);
      // 실행 확인(탭 조회)은 통과하고, 턴이 탭 주소를 다시 읽을 때는 다른 주소(PDF)로 보이게 한다.
      await h.sw.evaluate(({ tabId, base }) => {
        globalThis.__modelReqs = [];
        globalThis.__steps = [{ text: "끝" }];
        const real = chrome.tabs.get.bind(chrome.tabs);
        globalThis.__realTabsGet = real;
        chrome.tabs.get = async (id) => {
          const t = await real(id);
          return id === tabId ? { ...t, url: `${base}/private.pdf` } : t;
        };
      }, { tabId, base: h.base });
      const msgs = await h.panel.evaluate(
        (msg) =>
          new Promise((resolve) => {
            const port = chrome.runtime.connect({ name: "chat" });
            const got = [];
            port.onMessage.addListener((m) => got.push({ kind: m.kind, message: m.message, text: m.text }));
            setTimeout(() => {
              port.disconnect();
              resolve(got);
            }, 2500);
            chrome.windows.getCurrent().then((w) => port.postMessage({ kind: "suggestion_run", conversationId: "raw2", windowId: w.id, ...msg }));
          }),
        { runId: "x", ruleId: "r1", ruleVersion: 1, tabId, url: `${h.base}/article/1` },
      );
      await h.sw.evaluate(() => {
        chrome.tabs.get = globalThis.__realTabsGet;
      });
      expect(msgs.some((m) => m.kind === "suggestion_started"), `확인은 통과(${JSON.stringify(msgs)})`);
      expect(msgs.some((m) => m.kind === "error" && (m.message ?? "").includes("페이지가 바뀌어")), `턴은 멈춘다(${JSON.stringify(msgs)})`);
      const reqs = await h.sw.evaluate(() => globalThis.__modelReqs.length);
      expect(reqs === 0, `모델 요청 없음(${reqs})`);
      expect(!h.logs.some((l) => l.includes("pdf:fetch")), "PDF를 받지 않는다");
    },
  },
];
