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
  const serve = (which) => (q, r) => {
    const path = q.url.split("?")[0];
    const body = pages.get(`${which}${path}`) ?? (which === 1 ? DEFAULT_PAGE : "<title>X</title><p>external</p>");
    r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    r.end(`<!doctype html><meta charset=utf-8>${body}`);
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
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), "nativeMessaging"])];
  manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== "nativeMessaging");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
  const userDataDir = mkdtempSync(join(tmpdir(), "sbp-harness-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chrome,
    headless: !process.env.HARNESS_HEADED,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
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
      globalThis.__draft = null;
      globalThis.__modelReqs = [];
    });
    logs.length = 0;
    await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
    await panel.waitForTimeout(500);
    await tab.bringToFront();
  }

  // 한 턴: 탭을 path로 열고(noReload면 그대로) 단계 목록으로 모의 모델을 돌린다.
  // approve: 승인 카드가 뜨면 누른다(true) / 카드가 뜨면 거기서 멈춘다(false). onCard(card, n): 카드가 뜰 때 대신 할 일.
  async function turn(steps, { path = "/", server = 1, noReload = false, approve = false, onCard, maxWaitMs = 20_000, text = "시험" } = {}) {
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
    if (await panel.locator("button.composer-btn.danger").count()) {
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

  return { base, base2, pages, sw, tab, panel, ctx, extId, settings, reset, turn, close, logs, installKeePassXC, userDataDir };
}

// 모의 모델: 단계마다 직전 도구 결과를 보고 다음 호출을 만든다. 도구 결과(모델에 간 그대로)는 __toolLog에 남긴다.
// 저장 카드 초안 요청(response_format)에는 __draft를 JSON으로 답하고 요청을 __draftReqs에 남긴다.
async function installMockModel(sw) {
  await sw.evaluate(() => {
    globalThis.__steps = [];
    globalThis.__toolLog = [];
    globalThis.__n = 0;
    // 사이드 패널을 탭으로 띄워 시험하므로 "활성 탭"은 시험 페이지 탭(http, 패널이 아닌 것)으로 고정한다.
    const realQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (q && q.active && q.lastFocusedWindow) {
        const all = await realQuery({});
        return all.filter((t) => /^https?:/.test(t.url ?? ""));
      }
      return realQuery(q);
    };
    const realFetch = globalThis.fetch;
    const sse = (chunks) =>
      new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    globalThis.fetch = async (url, init) => {
      // 모델 제공자 엔드포인트(#97)만 흉내 낸다. 요청 주소·본문은 __modelReqs에 남긴다.
      if (!/openrouter\.ai|api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com/.test(String(url))) return realFetch(url, init);
      const body = JSON.parse(init.body);
      (globalThis.__modelReqs ??= []).push({ url: String(url), body, headers: init.headers });
      const anthropic = String(url).includes("api.anthropic.com");
      // Anthropic: 응답은 Messages 형식, 스트림은 content_block 이벤트(아래 anthropicSse).
      if (anthropic && !body.stream) {
        (globalThis.__draftReqs ??= []).push(body);
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(globalThis.__draft ?? {}) }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (body.response_format) {
        (globalThis.__draftReqs ??= []).push(body);
        // __draftDelayMs: 저장 카드 초안 응답을 늦춘다(닫았다 다시 연 동안 도착하는 응답 시험).
        if (globalThis.__draftDelayMs) await new Promise((r) => setTimeout(r, globalThis.__draftDelayMs));
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
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
      let data = null;
      if (lastTool) {
        const parsed = JSON.parse(lastTool.content);
        // 도구 이름: 결과 메시지의 name(OpenRouter) 또는 같은 id의 도구 호출(name을 보내지 않는 제공자).
        const call = msgs.flatMap((m) => m.tool_calls ?? []).find((c) => c.id === lastTool.tool_call_id);
        globalThis.__toolLog.push({ name: lastTool.name ?? call?.function?.name, ...parsed });
        data = parsed.result ?? null;
      }
      const anthropicSse = (events) =>
        new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        });
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
            { type: "content_block_start", index: i, content_block: { type: "tool_use", id: "toolu_" + ++globalThis.__n, name: out.tool, input: {} } },
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
      const chunks = out.tool
        ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call" + ++globalThis.__n, type: "function", function: { name: out.tool, arguments: JSON.stringify(out.args) }, ...(out.extra ? { extra_content: out.extra } : {}) }] } }] }]
        : [{ choices: [{ delta: { content: out.text } }] }];
      chunks.push({ choices: [{ delta: {}, finish_reason: out.tool ? "tool_calls" : "stop" }] });
      return sse(chunks);
    };
  });
}

export class Fail extends Error {}

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
