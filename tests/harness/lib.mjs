// content script·승인 규칙 하네스: 빌드한 확장(dist)을 Chrome for Testing에 올리고, 로컬 시험 서버 두 개(다른 출처)와
// 모의 모델(OpenRouter 응답을 단계 목록으로 흉내)로 실제 사이드 패널을 조작한다. `npm run harness`가 쓴다.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXT = resolve(process.env.HARNESS_EXT ?? "dist");

// Chrome for Testing 경로: HARNESS_CHROME, 없으면 Playwright 캐시에서 가장 새 chromium. 못 찾으면 null(하네스를 건너뛴다).
export function findChrome() {
  if (process.env.HARNESS_CHROME) return existsSync(process.env.HARNESS_CHROME) ? process.env.HARNESS_CHROME : null;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin" ? join(homedir(), "Library/Caches/ms-playwright") : join(homedir(), ".cache/ms-playwright"));
  if (!existsSync(cache)) return null;
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const rel = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
  ];
  for (const d of dirs) for (const r of rel) if (existsSync(join(cache, d, r))) return join(cache, d, r);
  return null;
}

const DEFAULT_PAGE = `<title>shop</title><body><main>
<form id=s onsubmit="event.preventDefault();document.getElementById('out').textContent='검색됨:'+this.q.value"><label>검색어 <input name=q></label><button>검색</button></form>
<button onclick="document.getElementById('out').textContent='결제됨'">결제하기</button>
<button onclick="document.getElementById('out').textContent='필터됨 '+event.isTrusted">적용</button>
<p id=out></p></main>`;


export async function startHarness() {
  const { chromium } = await import("playwright-core");
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome for Testing을 찾지 못했습니다(HARNESS_CHROME).");
  // 시나리오가 경로마다 HTML을 등록한다(서버 둘 — 두 번째는 다른 출처).
  const pages = new Map();
  // 서버가 받은 요청(서버 번호 + 경로, #193 — 리다이렉트를 따르지 않는지 본다).
  const hits = [];
  const serve = (which) => (q, r) => {
    const path = q.url.split("?")[0];
    hits.push(`${which}${path}`);
    // /redir…(#193): 다른 출처(서버 2)의 같은 경로로 307 — 로컬 서버 주소가 넘기는 응답을 따르지 않는지 시험.
    if (which === 1 && path.startsWith("/redir/")) {
      r.writeHead(307, { location: `http://localhost:${srv2.address().port}/v1${path.slice("/redir".length)}` });
      r.end();
      return;
    }
    const body = pages.get(`${which}${path}`) ?? (which === 1 ? DEFAULT_PAGE : "<title>X</title><p>external</p>");
    const send = () => {
      r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      r.end(`<!doctype html><meta charset=utf-8>${body}`);
    };
    // /slow…(#240): 응답을 늦춘다(/slow/ 1초, /slow4/ 4초) — 이동이 커밋되기 전에 턴이 끝나는 경우를 만든다.
    const slow = /^\/slow(\d*)\//.exec(path);
    if (slow) setTimeout(send, (Number(slow[1]) || 1) * 1000);
    else send();
  };
  const srv = createServer(serve(1));
  const srv2 = createServer(serve(2));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await new Promise((r) => srv2.listen(0, "localhost", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const base2 = `http://localhost:${srv2.address().port}`;
  // 시험용 사본: 자동 로그인의 KeePassXC 연결(nativeMessaging)은 선택 권한이라 권한 대화상자가 뜬다. 사본의 manifest에서만
  // 필수 권한으로 옮겨 대화상자 없이 시험한다(배포 빌드는 그대로).
  const ext = mkdtempSync(join(tmpdir(), "sbp-ext-"));
  cpSync(EXT, ext, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  // 방문 기록(#175, history)도 같은 이유로 사본에서만 필수 권한으로 옮긴다(권한 거절 분기는 패널의 permissions 대역으로 시험).
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), "nativeMessaging", "history"])];
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== "nativeMessaging" && p !== "history");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
  const userDataDir = mkdtempSync(join(tmpdir(), "sbp-harness-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chrome,
    headless: !process.env.HARNESS_HEADED,
    // 음성 입력(#184): 가짜 마이크(삐 소리)와 권한 창 자동 허용.
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = sw.url().split("/")[2];
  const logs = [];
  sw.on("console", (m) => logs.push(m.text()));
  const tab = ctx.pages()[0] ?? (await ctx.newPage());
  await tab.goto(base + "/");
  await installMockModel(sw);
  const panel = await ctx.newPage();
  // 패널 쪽 디버그 줄(useChatSession의 panelConsole — "[SBP panel <tag>] ..."). reset마다 비운다.
  const panelLogs = [];
  panel.on("console", (m) => {
    if (m.text().startsWith("[SBP panel ")) panelLogs.push(m.text());
  });
  // 설정 페이지(옵션 탭, #127). openOptions는 새 탭으로 연다. optionsPages는 지금 열린 설정 탭들(패널의 ⚙가 연 것 포함).
  const optionsUrl = `chrome-extension://${extId}/src/options/index.html`;
  const optionsPages = () => ctx.pages().filter((p) => p.url().startsWith(optionsUrl));
  // 패널이 연 설정 탭을 기다린다(section이 있으면 그 묶음 해시까지). 없으면 null.
  async function waitOptions(section, ms = 5000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const p = optionsPages().find((x) => !section || x.url().endsWith(`#${section}`));
      if (p) {
        await p.waitForLoadState().catch(() => {});
        await p.waitForTimeout(300);
        return p;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  async function openOptions(section = "model") {
    const p = await ctx.newPage();
    await p.goto(`${optionsUrl}#${section}`);
    await p.waitForTimeout(400);
    return p;
  }

  // 예전 이름 autoApprove(true/false)는 실행 방식(runMode auto/ask, #123)으로 바꿔 쓴다.
  async function settings(patch) {
    if ("autoApprove" in patch) {
      const { autoApprove, ...rest } = patch;
      patch = { runMode: autoApprove ? "auto" : "ask", ...rest };
    }
    await sw.evaluate(async (patch) => {
      const cur = (await chrome.storage.local.get("settings")).settings ?? {};
      await chrome.storage.local.set({ settings: { ...cur, ...patch } });
    }, patch);
  }

  // 시나리오마다 새 대화(패널을 다시 열면 새 연결 → 새 대화 상태)와 기본 설정으로 시작한다.
  async function reset() {
    await sw.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        settings: { openRouterApiKey: "sk-or-test-dummy", model: "deepseek/x", runMode: "ask" },
      });
      globalThis.__steps = [];
      globalThis.__toolLog = [];
      globalThis.__draftReqs = [];
      globalThis.__draftReplies = 0;
      globalThis.__draft = null;
      globalThis.__realWindowQuery = false;
      globalThis.__modelReqs = [];
      globalThis.__badToolIds = [];
      globalThis.__voiceReqs = [];
      globalThis.__voiceReply = undefined;
      globalThis.__voiceDelayMs = 0;
      globalThis.__voiceStatus = 0;
      globalThis.__usage = undefined;
      globalThis.__checkReply = undefined;
      globalThis.__localModels = undefined;
      globalThis.__localModelsDelayMs = 0;
      globalThis.__localModelReqs = [];
      globalThis.__translateDelayMs = 0;
      globalThis.__translateReqs = [];
      // 번역 응답 게이트(#256): 앞 시나리오가 붙잡아 둔 응답은 풀고 비운다.
      globalThis.__releaseTranslate?.();
      globalThis.__translateHold = false;
      globalThis.__translateHeld = 0;
      globalThis.__translateEcho = undefined;
      // 스트림 게이트(textParts holdAfter, #252): 앞 시나리오가 남긴 붙잡힌 스트림은 풀고 비운다.
      globalThis.__releaseStream?.();
      globalThis.__streamGate = null;
      globalThis.__releaseStream = null;
      globalThis.__streamHeld = false;
    });
    logs.length = 0;
    panelLogs.length = 0;
    for (const p of optionsPages()) await p.close().catch(() => {});
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
    await panel.waitForTimeout(500);
    await tab.bringToFront();
  }

  // 한 턴: 탭을 path로 열고(noReload면 그대로) 단계 목록으로 모의 모델을 돌린다.
  // approve: 승인 카드가 뜨면 누른다(true) / 카드가 뜨면 거기서 멈춘다(false). onCard(card, n): 카드가 뜰 때 대신 할 일.
  // keepRunning: 카드에서 멈췄을 때 반환 전에 중단 버튼을 누르지 않는다(끊김 뒤 패널 정리를 시험할 때 — 기본은 누름).
  async function turn(steps, { path = "/", server = 1, noReload = false, approve = false, onCard, maxWaitMs = 20_000, text = "시험", keepRunning = false } = {}) {
    if (!noReload) await tab.goto((server === 1 ? base : base2) + path);
    await tab.waitForTimeout(200);
    await sw.evaluate((s) => {
      globalThis.__steps = s;
      globalThis.__toolLog = [];
    }, steps);
    const before = await panel.locator(".tool-pending:not(.resolved)").count();
    await panel.fill("textarea.composer-input", text);
    await panel.click("button.composer-btn.primary");
    let cards = 0;
    const started = Date.now();
    let stoppedAtCard = false;
    let finished = false;
    while (Date.now() - started < maxWaitMs) {
      await panel.waitForTimeout(200);
      const pending = panel.locator(".tool-pending:not(.resolved)");
      const n = await pending.count();
      if (n > before) {
        cards++;
        if (onCard) await onCard(pending.last(), cards);
        else if (approve) await pending.last().locator(".btn-approve").click();
        else {
          stoppedAtCard = true;
          break;
        }
        await panel.waitForTimeout(300);
        continue;
      }
      if (!(await panel.locator("button.composer-btn.danger").count())) {
        finished = true;
        break;
      }
    }
    // 카드에서 일부러 멈춘 것이 아니면 턴이 끝나야 한다(시간 초과는 실패 — 강제로 멈춘 턴을 통과로 보지 않게).
    if (!finished && !stoppedAtCard) throw new Fail(`턴이 ${maxWaitMs}ms 안에 끝나지 않았습니다`);
    const tools = await sw.evaluate(() => globalThis.__toolLog);
    const out = await tab.locator("#out").innerText().catch(() => null);
    if (!keepRunning && (await panel.locator("button.composer-btn.danger").count())) {
      await panel.click("button.composer-btn.danger");
      await panel.waitForTimeout(300);
    }
    return { cards, stoppedAtCard, tools, out, url: tab.url(), logs: [...logs] };
  }

  async function close() {
    await ctx.close();
    srv.close();
    srv2.close();
  }

  // 가짜 KeePassXC를 native messaging 호스트로 설치한다(이 브라우저의 사용자 데이터 폴더에). 상태 파일로 항목·기록을 주고받는다.
  function installKeePassXC(initial) {
    const dir = join(userDataDir, "NativeMessagingHosts");
    mkdirSync(dir, { recursive: true });
    const statePath = join(userDataDir, "keepassxc-state.json");
    writeFileSync(statePath, JSON.stringify({ log: [], ...initial }));
    const wrapper = join(userDataDir, "keepassxc-mock.sh");
    const script = join(dirname(fileURLToPath(import.meta.url)), "mockKeePassXC.mjs");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${statePath}"\n`);
    chmodSync(wrapper, 0o755);
    writeFileSync(
      join(dir, "com.simple_browser_helper.keepassxc.json"),
      JSON.stringify({ name: "com.simple_browser_helper.keepassxc", description: "harness", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] }),
    );
    return {
      state: () => JSON.parse(readFileSync(statePath, "utf8")),
      set: (patch) => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...patch })),
    };
  }

  return { base, base2, pages, hits, sw, tab, panel, ctx, extId, settings, reset, turn, close, logs, panelLogs, installKeePassXC, userDataDir, optionsUrl, optionsPages, openOptions, waitOptions };
}

// 모의 모델: 단계마다 직전 도구 결과를 보고 다음 호출을 만든다. 도구 결과(모델에 간 그대로)는 __toolLog에 남긴다.
// 저장 카드 초안 요청(response_format)에는 __draft를 JSON으로 답하고 요청을 __draftReqs에 남긴다.
async function installMockModel(sw) {
  await sw.evaluate(() => {
    globalThis.__steps = [];
    globalThis.__toolLog = [];
    globalThis.__n = 0;
    // 요청 기록의 도구 결과가 바로 앞 호출 블록과 맞는지(#221). 틀린 점을 글로 돌려준다(없으면 빈 배열).
    function toolPairingErrors(messages, anthropic) {
      const errs = [];
      if (!Array.isArray(messages)) return errs;
      if (anthropic) {
        let open = null;
        for (const m of messages) {
          const blocks = Array.isArray(m.content) ? m.content : [];
          if (m.role === "assistant") {
            if (open?.size) errs.push(`결과 없는 호출 ${[...open].join(",")}`);
            open = new Set(blocks.filter((b) => b.type === "tool_use").map((b) => b.id));
            continue;
          }
          const results = blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
          for (const id of results) {
            if (!open?.has(id)) errs.push(`앞 호출에 없는 결과 ${id}`);
            else open.delete(id);
          }
          if (open?.size) errs.push(`결과 없는 호출 ${[...open].join(",")}`);
          open = null;
        }
        return errs;
      }
      let open = null;
      for (const m of messages) {
        if (m.role === "tool") {
          if (!open?.has(m.tool_call_id)) errs.push(`앞 호출에 없는 결과 ${m.tool_call_id}`);
          else open.delete(m.tool_call_id);
          continue;
        }
        if (open?.size) errs.push(`결과 없는 호출 ${[...open].join(",")}`);
        open = m.role === "assistant" ? new Set((m.tool_calls ?? []).map((c) => c.id)) : null;
      }
      return errs;
    }

    // 사이드 패널을 탭으로 띄워 시험하므로 "활성 탭"은 시험 페이지 탭(http, 패널이 아닌 것)으로 고정한다.
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (q && q.active && q.lastFocusedWindow) {
        const all = await realQuery({});
        return all.filter((t) => /^https?:/.test(t.url ?? ""));
      }
      // 패널 창의 활성 탭(#174, windowId로 조회)도 그 창의 시험 페이지 탭으로. __realWindowQuery면 실제 조회(다중 창 시험).
      // 그 창의 실제 활성 탭이 패널(확장 페이지)이 아니면 그 탭을, 패널이면 그 창의 시험 페이지 탭을 돌려준다.
      if (q && q.active && q.windowId !== undefined && !globalThis.__realWindowQuery) {
        const act = (await realQuery({ active: true, windowId: q.windowId })).filter((t) => !(t.url ?? "").startsWith("chrome-extension://"));
        if (act.length) return act;
        const all = await realQuery({ windowId: q.windowId });
        return all.filter((t) => /^https?:/.test(t.url ?? ""));
      }
      return realQuery(q);
    };
    const realFetch = globalThis.fetch;
    // __usage(OpenAI 형식 usage, #126): 있으면 스트림 끝에 choices가 빈 사용량 조각을 붙인다. Anthropic은 message_start·message_delta에.
    const sse = (chunks) =>
      new Response([...chunks, ...(globalThis.__usage ? [{ choices: [], usage: globalThis.__usage }] : [])].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    globalThis.fetch = async (url, init) => {
      // 음성 변환(#184): 대화 요청보다 먼저 가른다(OpenAI는 multipart). 요청은 __voiceReqs에, 응답은 __voiceReply(기본 "음성 글자"),
      // __voiceDelayMs만큼 늦추며 중단 신호를 따른다(aborted 표시).
      if (/\/audio\/transcriptions$|:generateContent$/.test(String(url))) {
        const u = String(url);
        const rec = { url: u, headers: init.headers, aborted: false };
        if (init.body instanceof FormData) {
          const f = init.body.get("file");
          rec.form = { model: init.body.get("model"), language: init.body.get("language"), fileType: f?.type, fileSize: f ? (await f.arrayBuffer()).byteLength : 0 };
        } else rec.json = JSON.parse(init.body);
        (globalThis.__voiceReqs ??= []).push(rec);
        if (globalThis.__voiceDelayMs) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, globalThis.__voiceDelayMs);
            init.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              rec.aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
        }
        const text = globalThis.__voiceReply ?? "음성 글자";
        if (globalThis.__voiceStatus) return new Response(JSON.stringify({ error: { message: "bad key" } }), { status: globalThis.__voiceStatus });
        const body = u.endsWith(":generateContent") ? { candidates: [{ content: { parts: [{ text }] } }] } : { text };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }
      // 모델 제공자 엔드포인트(#97)만 흉내 낸다. 요청 주소·본문은 __modelReqs에 남긴다.
      // 로컬·호환 서버(#193): 시험용 주소 http://127.0.0.1:59999/v1. 모델 목록(GET /models)은 __localModels(늦추기 __localModelsDelayMs).
      if (String(url) === "http://127.0.0.1:59999/v1/models") {
        (globalThis.__localModelReqs ??= []).push({ headers: init?.headers ?? {} });
        if (globalThis.__localModelsDelayMs) await new Promise((r) => setTimeout(r, globalThis.__localModelsDelayMs));
        return new Response(JSON.stringify({ data: (globalThis.__localModels ?? []).map((id) => ({ id })) }), { headers: { "content-type": "application/json" } });
      }
      // 바꾼 뒤 주소(127.0.0.1:59998, 서버 없음 #252): 요청을 주소와 함께 남긴 뒤 실제처럼 연결 거부로 끝낸다(시나리오가 주소별로 센다).
      if (String(url).startsWith("http://127.0.0.1:59998/")) {
        let body = null;
        try {
          body = init?.body ? JSON.parse(init.body) : null;
        } catch {}
        (globalThis.__modelReqs ??= []).push({ url: String(url), body, headers: init?.headers, at: Date.now() });
        throw new TypeError("Failed to fetch");
      }
      if (!/openrouter\.ai|api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com|127\.0\.0\.1:59999/.test(String(url))) return realFetch(url, init);
      const body = JSON.parse(init.body);
      (globalThis.__modelReqs ??= []).push({ url: String(url), body, headers: init.headers, at: Date.now() });
      // __checkReply(#132): 설정의 연결 확인 요청에 줄 응답 { status, body, delayMs, networkError }.
      if (globalThis.__checkReply && JSON.stringify(body.messages ?? []).includes("Reply with the single word OK.")) {
        const c = globalThis.__checkReply;
        if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs));
        if (c.networkError) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify(c.body), { status: c.status ?? 200, headers: { "content-type": "application/json" } });
      }
      const anthropic = String(url).includes("api.anthropic.com");
      // Anthropic: 응답은 Messages 형식, 스트림은 content_block 이벤트(아래 anthropicSse).
      if (anthropic && !body.stream) {
        (globalThis.__draftReqs ??= []).push(body);
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(globalThis.__draft ?? {}) }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      // 번역 배치(#193 시험): 입력 배열을 받아 같은 수의 "번역:원문"을 돌려준다. __translateDelayMs만큼 늦추고 중단 신호를 따른다.
      // 기록에는 실제로 보낸 입력 글자 배열(texts)을 남긴다(#256 — 편집 영역 글자가 요청에 실리지 않는지 본문으로 검사).
      // __translateEcho(#256): 이 글자가 든 입력은 원문 그대로 돌려준다(쓸 수 없는 번역 → 그 단위만 다시 요청하는 경로 시험).
      // __translateHold(#256): 켜져 있으면 응답을 붙잡고 __translateHeld를 센다. __releaseTranslate()로 붙잡힌 응답을 모두 풀고 끈다.
      const userText = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
      if (body.response_format && userText.includes("translations 배열")) {
        const input = JSON.parse(userText.slice(userText.lastIndexOf("입력:\n") + "입력:\n".length));
        (globalThis.__translateReqs ??= []).push({ url: String(url), texts: input });
        if (globalThis.__translateHold) {
          globalThis.__translateGate ??= new Promise((resolve) => {
            globalThis.__releaseTranslate = () => {
              globalThis.__translateHold = false;
              globalThis.__translateGate = null;
              globalThis.__releaseTranslate = null;
              resolve();
            };
          });
          globalThis.__translateHeld = (globalThis.__translateHeld ?? 0) + 1;
          await globalThis.__translateGate;
        }
        if (globalThis.__translateDelayMs) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, globalThis.__translateDelayMs);
            init.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: input.map((t) => (globalThis.__translateEcho && t.includes(globalThis.__translateEcho) ? t : `번역:${t}`)) }) } }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (body.response_format) {
        (globalThis.__draftReqs ??= []).push(body);
        // __draftDelayMs: 저장 카드 초안 응답을 늦춘다(닫았다 다시 연 동안 도착하는 응답 시험).
        if (globalThis.__draftDelayMs) await new Promise((r) => setTimeout(r, globalThis.__draftDelayMs));
        // 보낸 초안 응답 수(#240 — 늦게 오는 응답을 고정 대기 대신 이 수로 기다린다).
        globalThis.__draftReplies = (globalThis.__draftReplies ?? 0) + 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(globalThis.__draft ?? {}) } }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      // Anthropic 기록(user 메시지의 tool_result 블록·assistant의 tool_use 블록)을 같은 꼴로 읽는다.
      const msgs = anthropic
        ? body.messages.flatMap((m) =>
            m.content.flatMap((b) =>
              b.type === "tool_result"
                ? [{ role: "tool", tool_call_id: b.tool_use_id, content: b.content }]
                : b.type === "tool_use"
                  ? [{ role: "assistant", tool_calls: [{ id: b.id, function: { name: b.name } }] }]
                  : [],
            ),
          )
        : body.messages;
      // 실제 API처럼 도구 결과가 바로 앞 호출 블록과 맞는지 본다(#221): 결과 id가 그 블록에 없거나 겹치거나, 블록의 호출에 결과가 빠지면
      // 400으로 거절하고 __badToolIds에 남긴다(run.mjs가 시나리오마다 비어 있는지 확인 — 내부 키가 기록에 섞이는 회귀를 잡는다).
      const bad = toolPairingErrors(body.messages, anthropic);
      if (bad.length) {
        (globalThis.__badToolIds ??= []).push(...bad);
        return new Response(JSON.stringify({ error: { message: `tool result mismatch: ${bad.join("; ")}` } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      let data = null;
      if (lastTool) {
        const parsed = JSON.parse(lastTool.content);
        // 도구 이름: 결과 메시지의 name(OpenRouter) 또는 같은 id의 마지막 도구 호출(name을 보내지 않는 제공자 — 모델이 id를 다시 써도 이번 호출).
        const call = msgs.flatMap((m) => m.tool_calls ?? []).reverse().find((c) => c.id === lastTool.tool_call_id);
        globalThis.__toolLog.push({ name: lastTool.name ?? call?.function?.name, callId: lastTool.tool_call_id, ...parsed });
        data = parsed.result ?? null;
      }
      const anthropicSse = (raw) => {
        const u = globalThis.__usage;
        const events = u
          ? [
              { type: "message_start", message: { usage: { input_tokens: u.prompt_tokens - (u.prompt_tokens_details?.cached_tokens ?? 0), cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0, output_tokens: 1 } } },
              ...raw.map((e) => (e.type === "message_delta" ? { ...e, usage: { output_tokens: u.completion_tokens } } : e)),
            ]
          : raw;
        return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
      };
      if (anthropic && body.tool_choice?.type === "none") {
        return anthropicSse([
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "정리" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        ]);
      }
      if (body.tool_choice === "none") return sse([{ choices: [{ delta: { content: "정리" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
      const step = globalThis.__steps.shift();
      // delayMs: 이 단계를 답하기 전에 기다린다(페이지가 스스로 넘어가는 등 시간이 지나야 하는 상황).
      if (step?.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      // find_clickables는 안내가 있으면 { items, note } 객체로 온다.
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) && data.items.every((x) => typeof x?.id === "string") ? data.items : [];
      const byLabel = (l) => list.find((f) => (f.label ?? "").includes(l))?.id ?? "f-missing";
      let out = { text: "끝" };
      if (step?.fill) out = { tool: "fill_form_fields", args: { fills: [{ id: byLabel(step.fill), value: step.value }] } };
      // fillMany: 여러 칸을 한 호출로([{ label, value }]).
      else if (step?.fillMany) out = { tool: "fill_form_fields", args: { fills: step.fillMany.map((f) => ({ id: byLabel(f.label), value: f.value })) } };
      else if (step?.fillType) {
        const id = list.find((f) => f.type === step.fillType)?.id ?? "f-missing";
        out = { tool: "fill_form_fields", args: { fills: [{ id, value: step.value }] } };
      }
      else if (step?.signIn) {
        // 로그인 칸: type(password 등) 또는 라벨 일부로 찾는다.
        const id = list.find((f) => f.type === step.signIn || (f.label ?? "").includes(step.signIn))?.id ?? "f-missing";
        out = { tool: "sign_in", args: { id } };
      }
      else if (step?.repeatLastClick) {
        // 직전 click_element와 같은 id로 다시 부른다(행 내용 바뀜 안내 뒤 같은 id 재호출 시험).
        const prev = [...msgs].reverse().flatMap((m) => m.tool_calls ?? []).find((c) => c.function?.name === "click_element");
        let id = "c-missing";
        try {
          id = JSON.parse(prev?.function?.arguments ?? "{}").id ?? id;
        } catch {
          /* ignore */
        }
        out = { tool: "click_element", args: { id } };
      }
      else if (step?.clickN) {
        // 한 응답에서 같은 대상을 n번 누른다(#233 응답 경계 시험). 직전 찾기 결과의 글자(text), 없으면 직전 click_element의 id.
        const prev = [...msgs].reverse().flatMap((m) => m.tool_calls ?? []).find((c) => c.function?.name === "click_element");
        let prevId = "c-missing";
        try {
          prevId = JSON.parse(prev?.function?.arguments ?? "{}").id ?? prevId;
        } catch {
          /* ignore */
        }
        const id = (step.clickN.text && list.find((c) => c.text === step.clickN.text)?.id) || prevId;
        out = { calls: Array.from({ length: step.clickN.n }, () => ({ tool: "click_element", args: { id } })) };
      }
      else if (step?.refill) {
        // 직전 fill_form_fields와 같은 id들에 새 값(refill 배열, 칸 순서대로)을 넣는다(#233 입력 칸 시험).
        const prev = [...msgs].reverse().flatMap((m) => m.tool_calls ?? []).find((c) => c.function?.name === "fill_form_fields");
        let fills = [];
        try {
          fills = JSON.parse(prev?.function?.arguments ?? "{}").fills ?? [];
        } catch {
          /* ignore */
        }
        out = { tool: "fill_form_fields", args: { fills: fills.map((f, i) => ({ id: f.id, value: step.refill[i] ?? f.value })) } };
      }
      else if (step?.clickStaleLocal) {
        // 직전 찾기 결과의 id 꼬리표(문서마다 다름)로 없는 순번 id를 만든다 — 이 문서에서 등록이 정리된 id와 같은 경로(#236).
        const tok = String(list[0]?.id ?? "c0-x").split("-").pop();
        out = { tool: "click_element", args: { id: `c999999-${tok}` } };
      }
      else if (step?.clickOption) {
        // 선택지 글자 + 그 목록을 연 칸(listFor)으로 고른다(자동완성 칸이 여럿일 때).
        const hit = list.find((c) => c.text === step.clickOption && (!step.listFor || (c.listFor ?? "").includes(step.listFor)));
        out = { tool: "click_element", args: { id: hit ? hit.id : "c-missing" } };
      }
      else if (step?.clickItem) {
        // find_clickables 항목 모드(#161) 결과에서 글자가 든 항목 → 그 안의 대상(target 글자 일부, 없으면 첫 대상)을 누른다.
        const items = Array.isArray(data?.items) ? data.items : [];
        const it = items.find((x) => (x.text ?? "").includes(step.clickItem));
        const t = it?.targets?.find((x) => !step.target || (x.text ?? "").includes(step.target));
        out = { tool: "click_element", args: { id: t ? t.id : "c-missing" } };
      }
      else if (step?.click) {
        const hit = list.find((c) => c.text === step.click && (!step.role || c.role === step.role));
        out = { tool: "click_element", args: { id: hit ? hit.id : "c-missing" } };
      } else if (step) out = step;
      // httpStatus: 요청을 HTTP 오류로 거절한다(연결 단계 실패).
      if (step?.httpStatus) return new Response(JSON.stringify({ error: { message: "거절" } }), { status: step.httpStatus, headers: { "content-type": "application/json" } });
      // streamError: 글자·사용량을 보낸 뒤 스트림 오류 조각으로 끝난다(#126 — 끊긴 호출의 사용량).
      if (step?.streamError && !anthropic) {
        const parts = [{ choices: [{ delta: { content: "부분" } }] }, ...(globalThis.__usage ? [{ choices: [], usage: globalThis.__usage }] : []), { error: { message: "중간 오류" } }];
        return new Response(parts.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }
      // lengthEmpty: 생각만 하다 응답 상한에 걸린 빈 응답(글자·도구 호출 없음, #160 재시도 시험).
      if (step?.lengthEmpty) {
        if (anthropic) return anthropicSse([{ type: "message_delta", delta: { stop_reason: "max_tokens" } }, { type: "message_stop" }]);
        return sse([{ choices: [{ delta: {}, finish_reason: "length" }] }]);
      }
      if (anthropic) {
        const ev = [];
        // 생각 블록(서명 포함)을 먼저 보낸다 — 다음 요청에 그대로 돌아오는지 본다.
        if (out.thinking) {
          ev.push(
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: out.thinking } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-" + out.thinking.length } },
            { type: "content_block_stop", index: 0 },
          );
        }
        const i = ev.length ? 1 : 0;
        if (out.tool) {
          const args = JSON.stringify(out.args);
          ev.push(
            { type: "content_block_start", index: i, content_block: { type: "tool_use", id: out.callId ?? "toolu_" + ++globalThis.__n, name: out.tool, input: {} } },
            { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: args.slice(0, 3) } },
            { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: args.slice(3) } },
            { type: "content_block_stop", index: i },
          );
        } else {
          ev.push(
            { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: i, delta: { type: "text_delta", text: out.text } },
            { type: "content_block_stop", index: i },
          );
        }
        ev.push({ type: "message_delta", delta: { stop_reason: out.tool ? "tool_use" : "end_turn" } }, { type: "message_stop" });
        return anthropicSse(ev);
      }
      // textParts + gapMs: 답 글자를 여러 조각으로 나눠 사이를 띄워 보낸다(응답을 받는 중의 패널 동작 시험).
      // holdAfter: k — k번째 조각을 보낸 뒤 __streamGate가 풀릴 때까지 멈춘다(그동안 __streamHeld = true, #252).
      //   시나리오는 __streamHeld를 조건 대기로 확인하고 개입한 뒤 __releaseStream()으로 푼다(시간 간격에 기대지 않는다).
      if (step?.textParts && !anthropic) {
        const parts = [...step.textParts.map((t) => ({ choices: [{ delta: { content: t } }] })), { choices: [{ delta: {}, finish_reason: "stop" }] }];
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(c) {
            try {
              for (let k = 0; k < parts.length; k++) {
                if (k > 0 && k < parts.length - 1) await new Promise((r) => setTimeout(r, step.gapMs ?? 1000));
                c.enqueue(enc.encode(`data: ${JSON.stringify(parts[k])}\n\n`));
                if (step.holdAfter === k + 1) {
                  globalThis.__streamGate ??= new Promise((r) => (globalThis.__releaseStream = r));
                  globalThis.__streamHeld = true;
                  await globalThis.__streamGate;
                  globalThis.__streamHeld = false;
                }
              }
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            } catch {
              // 붙잡힌 사이 읽는 쪽이 끊었으면(중단) 더 보내지 않는다.
            }
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      // calls: 한 응답에 도구 호출 여러 개([{ tool, args, callId }], #221 시험). callId: 모델이 줄 호출 id(없으면 call<n>).
      const calls = out.calls ?? (out.tool ? [{ tool: out.tool, args: out.args, callId: out.callId, extra: out.extra }] : []);
      const chunks = calls.length
        ? [{ choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: c.callId ?? "call" + ++globalThis.__n, type: "function", function: { name: c.tool, arguments: JSON.stringify(c.args ?? {}) }, ...(c.extra ? { extra_content: c.extra } : {}) })) } }] }]
        : [{ choices: [{ delta: { content: out.text } }] }];
      chunks.push({ choices: [{ delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
      return sse(chunks);
    };
  });
}

export class Fail extends Error {}

// 조건이 참이 될 때까지 기다린다(고정 대기 대신, #252). 한도 안에 안 되면 label을 담아 실패한다.
export async function waitUntil(pred, { timeoutMs = 5000, intervalMs = 100, label = "조건" } = {}) {
  const started = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - started >= timeoutMs) throw new Fail(`${label}: ${timeoutMs}ms 안에 되지 않았습니다`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function expect(cond, message) {
  if (!cond) throw new Fail(message);
}

// 도구 결과(모델에 간 것) 중 이름이 같은 마지막 것.
export function lastTool(r, name) {
  return [...r.tools].reverse().find((t) => t.name === name) ?? null;
}

// 백그라운드 로그의 도구 결과 요약 줄(패널·동작 기록에 보이는 것). 없으면 빈 글자.
export function resultLog(r, name) {
  return [...r.logs].reverse().find((l) => l.includes("tool:result") && l.includes(` ${name} `)) ?? "";
}

// 이름이 같은 마지막 도구 결과가 성공이어야 하고, 그 result를 돌려준다(오류·없음이면 실패).
export function okResult(r, name) {
  const t = lastTool(r, name);
  expect(t, `${name} 결과가 없다`);
  expect(!t.error && t.result !== undefined, `${name} 오류: ${t.error ?? "result 없음"}`);
  return t.result;
}
