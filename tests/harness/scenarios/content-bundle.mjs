// content script 한 파일(#215): 웹 페이지가 확장 파일 주소로 설치 여부를 알 수 없고, 다시 넣어도 한 번만 초기화된다.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EXT, expect } from "../lib.mjs";

const COUNTER = `<title>count</title>
<div id="__sbpContentLoaded">페이지 요소가 같은 이름이어도 초기화에는 영향 없음</div>
<button onclick="window.__n=(window.__n||0)+1;document.getElementById('out').textContent='눌림 '+window.__n">적용</button>
<div id="out"></div>`;

export default [
  {
    name: "content 한 파일(#215): 웹 페이지는 확장의 content.js·빌드 조각을 불러올 수 없고, 확장 화면은 같은 파일을 읽는다(대조군)",
    async run(h) {
      const asset = readdirSync(join(EXT, "assets")).find((f) => f.endsWith(".js"));
      expect(!!asset, "빌드 조각이 있음");
      const urls = [`chrome-extension://${h.extId}/content.js`, `chrome-extension://${h.extId}/assets/${asset}`];
      await h.tab.goto(`${h.base}/`);
      const fromPage = await h.tab.evaluate(async (list) => {
        const out = [];
        for (const u of list) {
          try {
            const r = await fetch(u);
            out.push(r.ok ? "읽힘" : `HTTP ${r.status}`);
          } catch {
            out.push("막힘");
          }
        }
        return out;
      }, urls);
      expect(fromPage.every((x) => x === "막힘"), `페이지에서는 막힘(${fromPage.join(", ")})`);
      const fromExt = await h.panel.evaluate(async (list) => Promise.all(list.map(async (u) => (await fetch(u)).ok)), urls);
      expect(fromExt.every(Boolean), `확장 화면에서는 읽힘(${fromExt.join(", ")})`);
      const m = await h.sw.evaluate(() => chrome.runtime.getManifest());
      expect(!m.web_accessible_resources && JSON.stringify(m.content_scripts[0].js) === JSON.stringify(["content.js"]), "manifest");
    },
  },
  {
    name: "content 한 파일(#215): 승인 카드를 띄운 뒤 같은 탭에 content.js를 두 번 더 넣어도 대상·승인이 그대로이고 한 번만 누른다",
    pages: { "/count": COUNTER },
    async run(h) {
      let injected = false;
      let inits = -1;
      const r = await h.turn([{ tool: "find_clickables", args: {} }, { click: "적용" }, { text: "끝" }], {
        path: "/count",
        onCard: async (card) => {
          if (!injected) {
            injected = true;
            const tabUrl = h.tab.url();
            await h.sw.evaluate(async (url) => {
              const [tab] = await chrome.tabs.query({ url });
              for (let i = 0; i < 2; i++) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
            }, tabUrl);
            // 같은 isolated world에서 초기화는 한 번(리스너·대상 레지스트리가 하나).
            inits = await h.sw.evaluate(async (url) => {
              const [tab] = await chrome.tabs.query({ url });
              const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis[Symbol.for("sbp.content.inits")] ?? 0 });
              return res.result;
            }, tabUrl);
          }
          await card.locator(".btn-approve").click();
        },
      });
      expect(inits === 1, `세 번 넣어도 초기화 한 번(${inits})`);
      expect(r.cards === 1, `카드 하나(${r.cards})`);
      expect(r.out === "눌림 1", `한 번만 누름(${r.out})`);
      const log = r.tools.map((t) => `${t.name}:${t.error ?? "ok"}`);
      expect(log.includes("click_element:ok"), `클릭 결과(${log.join(",")})`);
    },
  },
];
