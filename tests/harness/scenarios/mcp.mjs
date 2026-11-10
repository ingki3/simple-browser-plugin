// MCP 연동(#140): 실제 다리(mcp/sbp-mcp.mjs)를 포트 0으로 띄우고 stdio로 tools/call을 보내, 확장이 폴링해 처리한 최종 답이 오는지.
// 비밀이 다른 다리에서는 확장이 인증에 실패해 요청을 가져가지 않는다.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ask, expect, waitUntil } from "../lib.mjs";
import { checkRemoteHandoffRefused, installHandoffObserver, markTurnStart, remoteTabAt, restoreHandoffObserver } from "../handoffObserve.mjs";
import { asks as tgAsks, checkRemoteBlocked, connect as tgConnect, deliver as tgDeliver, press as tgPress, remoteBlockedCalls, replies as tgReplies, waitAsk as tgWaitAsk } from "./telegram.mjs";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "../../../mcp/sbp-mcp.mjs");

function startBridge(secret) {
  const child = spawn(process.execPath, [BRIDGE], { env: { ...process.env, SBP_SECRET: secret, SBP_PORT: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  // 다리가 클라이언트에 보낸 요청·알림(승인 질문 elicitation/create, 취소 알림 — #185).
  const requests = [];
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method) requests.push(m);
      else replies.set(m.id, m);
    }
  });
  const port = new Promise((resolve, reject) => {
    let err = "";
    child.stderr.on("data", (c) => {
      err += c.toString("utf8");
      const m = /127\.0\.0\.1:(\d+)/.exec(err);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", () => reject(new Error(`다리가 끝났습니다: ${err}`)));
  });
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  // 성공 대기(#262): 응답·요청이 올 때까지 기다려 돌려주고, 한도 안에 안 오면 받은 것의 id·method를 담아 실패한다.
  const reply = (id, ms = 20_000) =>
    waitUntil(() => replies.has(id) && replies.get(id), { timeoutMs: ms, label: `MCP 응답(id ${id})`, detail: () => `받은 응답 id: ${JSON.stringify([...replies.keys()])}` });
  const nth = (method, n) => requests.filter((r) => r.method === method)[n - 1];
  const request = (method, n = 1, ms = 20_000) =>
    waitUntil(() => nth(method, n), { timeoutMs: ms, label: `MCP 요청 ${method} ${n}번째`, detail: () => `받은 요청: ${requests.map((r) => r.method).join(",") || "없음"}` });
  // 부정 확인용(#262): ms 동안 지켜보고 나타나면 그것을, 끝까지 없으면 null을 돌려준다(호출처가 "없어야 함"을 expect). 던지지 않는다.
  const watch = async (get, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const v = get();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const seenReply = (id, ms) => watch(() => replies.get(id), ms);
  const seenRequest = (method, n, ms) => watch(() => nth(method, n), ms);
  return { child, port, send, reply, request, seenReply, seenRequest, requests, stop: () => child.kill() };
}

// 승인 질문 시나리오의 준비: 켜기·질문 설정·다리·초기화(elicitation 지원 여부는 capabilities로).
export async function askReady(h, { askApproval = true, capabilities = { elicitation: {} }, version = "2025-11-25" } = {}) {
  await ask(h, { kind: "mcp_set", enabled: true });
  await ask(h, { kind: "mcp_set", askApproval });
  const secret = (await ask(h, { kind: "mcp_secret" })).data;
  const bridge = startBridge(secret);
  const port = await bridge.port;
  await ask(h, { kind: "mcp_set", port });
  bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities, clientInfo: { name: "harness", version: "1" } } });
  // 초기화 응답이 안 오면 실패한다 — 호출처의 try/finally 밖이라 여기서 다리를 끈다.
  await bridge.reply(1).catch((e) => {
    bridge.stop();
    throw e;
  });
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return bridge;
}

// 같은 모델 호출 id 시험(#221): 패널에서 요청을 보내고 승인 카드가 뜰 때까지 기다린다(h.turn은 멈춘 카드에서 턴을 중단하므로 직접).
const LINKS221 = {
  // #out: h.turn이 결과 칸을 읽는다(없으면 기다리다 늦어진다).
  "/docs": `<title>자료</title><a href="/l1">첫 글</a> <a href="/l2">둘째 글</a><p id=out></p>`,
  "/l1": "<title>L1</title><p>첫 번째 글 본문</p>",
  "/l2": "<title>L2</title><p>두 번째 글 본문</p>",
};
async function panelCard(h, steps, text) {
  await h.tab.goto(`${h.base}/docs`);
  await h.tab.waitForTimeout(200);
  await h.sw.evaluate((s) => {
    globalThis.__steps = s;
    globalThis.__toolLog = [];
  }, steps);
  await h.panel.fill("textarea.composer-input", text);
  await h.panel.click("button.composer-btn.primary");
  const card = h.panel.locator(".tool-pending:not(.resolved)").last();
  await card.waitFor({ timeout: 15_000 });
  return card;
}
// 패널 턴이 끝날 때까지(중단 버튼이 사라질 때까지) 기다린다. 안 되면 label을 담아 실패한다.
const panelIdle = (h, label, ms = 20_000) =>
  waitUntil(async () => !(await h.panel.locator("button.composer-btn.danger").count()), { timeoutMs: ms, intervalMs: 200, label });
const mcpState = (h) => h.sw.evaluate(async () => (await chrome.storage.local.get("mcp")).mcp);
// 저장소의 MCP 작업 기록(job)·보낼 결과(pending)가 비워질 때까지 기다린다.
const mcpCleared = (h, label, ms, intervalMs) =>
  waitUntil(
    async () => {
      const st = await mcpState(h);
      return !st.pending && !st.job;
    },
    { timeoutMs: ms, intervalMs, label, detail: async () => { const st = await mcpState(h); return JSON.stringify({ job: st.job, pending: st.pending }); } },
  );
// MCP 질문 중 링크 읽기 질문을 기다린다(그 앞의 이동 질문은 승인 — 앞 시나리오에서 같은 사이트를 승인했으면 이동 질문이 없을 수 있다).
async function linkQuestion(bridge) {
  for (let n = 1; n <= 3; n++) {
    const q = await bridge.request("elicitation/create", n);
    if (q.params?.message?.includes("링크 읽기")) return q;
    bridge.send({ jsonrpc: "2.0", id: q.id, result: { action: "accept", content: { approve: true } } });
  }
  return null;
}
const linkReads = (h) => h.sw.evaluate(() => globalThis.__toolLog.filter((t) => t.name === "read_linked_pages").map((t) => ({ callId: t.callId, error: t.error ?? null })));

const toolLog = (h) => h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));

const FORM192 = `<title>신청</title>
<label>이메일 <span aria-hidden="true">HIDDEN_LABEL_TEXT</span><input type="email" name="email" value="PAGE_TYPED_VALUE"></label>
<div contenteditable="true">PAGE_EDIT_TEXT</div>
<div id="out"></div>`;

export default [
  {
    name: "원격 요청이 직접 조작할 사이트에서 클릭하면 손 넘기기 카드 대신 거절로 풀리고 표시·감시를 거둔다(MCP, 물을 수 있어도 — #263 단계 5)",
    pages2: { "/m": `<title>예매</title><main><button style="width:160px;height:50px" onclick="document.getElementById('out').textContent='눌림'">조회하기</button><p id=out></p></main>` },
    async run(h) {
      await h.settings({ manualSites: [h.base2] });
      const url = `${h.base2}/m`;
      const bridge = await askReady(h);
      const unTab = await remoteTabAt(h, url);
      try {
        await installHandoffObserver(h);
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ tool: "find_clickables", args: {} }, { click: "조회하기" }, { text: "못 함" }];
          globalThis.__toolLog = [];
          globalThis.__modelReqs = [];
        });
        const from = h.logs.length;
        await markTurnStart(h);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "조회하기 눌러 줘" } } });
        // 대기 등록이 거절 타이머 뒤로 밀리면 거절이 닿지 않아 손 넘기기가 끝나지 않는다(만료는 이 한도보다 길다).
        const res = await bridge.reply(2, 8_000);
        expect(!!res?.result, `답(${JSON.stringify(res).slice(0, 200)})`);
        expect(!bridge.requests.some((r) => r.method === "elicitation/create"), `elicitation 없음(${bridge.requests.map((r) => r.method).join(",")})`);
        await checkRemoteHandoffRefused(h, { from, url });
      } finally {
        await restoreHandoffObserver(h);
        await unTab();
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "원격 요청에서는 sign_in·open_saved_link·schedule_repeat_task·send_to_telegram을 쓰지 않는다(물을 수 있어도 elicitation·패널 카드 없음)",
    async run(h) {
      const bridge = await askReady(h);
      try {
        let id = 2;
        for (const call of remoteBlockedCalls(h)) {
          await h.sw.evaluate((c) => {
            globalThis.__steps = [c, { text: "못 함" }];
            globalThis.__toolLog = [];
          }, call);
          const from = { logs: h.logs.length, hits: h.hits.length };
          bridge.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "browser_task", arguments: { request: `${call.tool} 해 줘` } } });
          const res = await bridge.reply(id, 30_000);
          expect(res?.result && !res.result.isError, `${call.tool} 요청 답(${JSON.stringify(res).slice(0, 300)})`);
          await checkRemoteBlocked(h, call.tool, from);
          id += 1;
        }
        expect(!bridge.requests.some((r) => r.method === "elicitation/create"), `elicitation 없음(${bridge.requests.map((r) => r.method).join(",")})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "원격 입력 질문(#192): 개인정보 칸 입력을 elicitation으로 묻고(페이지 출처·모델용 칸 이름·넣을 값, 사유는 고정 문구), 승인하면 입력한다",
    pages: { "/form192": FORM192 },
    async run(h) {
      const bridge = await askReady(h);
      try {
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { tool: "find_form_fields", args: {} }, { fill: "이메일", value: "me@example.test" }, { text: "입력했습니다" }];
          globalThis.__toolLog = [];
        }, `${h.base}/form192`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "신청서에 이메일 넣어 줘" } } });
        const nav = await bridge.request("elicitation/create", 1);
        bridge.send({ jsonrpc: "2.0", id: nav.id, result: { action: "accept", content: { approve: true } } });
        const fill = await bridge.request("elicitation/create", 2);
        const msg = fill?.params?.message ?? "";
        expect(msg.includes("승인이 필요합니다: 입력") && msg.includes(`페이지: ${h.base}`) && msg.includes("'이메일'") && msg.includes("me@example.test"), `입력 질문(${msg})`);
        expect(msg.includes("자동 실행 예외가 있어 묻습니다"), "고정 사유 문구");
        for (const bad of ["PAGE_TYPED_VALUE", "PAGE_EDIT_TEXT", "HIDDEN_LABEL_TEXT"]) expect(!msg.includes(bad), `질문에 ${bad} 없음`);
        bridge.send({ jsonrpc: "2.0", id: fill.id, result: { action: "accept", content: { approve: true } } });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result?.content?.[0]?.text === "입력했습니다", `최종 답(${JSON.stringify(res)})`);
        // 원격 요청은 새 작업 탭에서 일한다 — 그 탭의 칸을 본다.
        const page = h.ctx.pages().find((p) => p.url() === `${h.base}/form192`);
        expect(!!page && (await page.locator("input[name=email]").inputValue()) === "me@example.test", "입력됨");
        const first = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs[0]?.body.messages.filter((m) => m.role === "user")));
        expect(first.includes("입력(fill_form_fields)") && !first.includes("입력·저장·로그인 등)은 원격에서 할 수 없고"), "모델 안내가 새 범위");
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "원격 허용 사이트(#192): 묻지 못하는 MCP 요청도 허용 사이트로는 이동하고, 같은 요청 안에서 목록에서 빼면 다음 이동은 하지 않는다",
    pages: { "/a": "<title>A</title><p>a</p>", "/b": "<title>B</title><p>b</p>" },
    async run(h) {
      const bridge = await askReady(h, { askApproval: false, capabilities: {} });
      try {
        const site = new URL(h.base).origin;
        const added = await ask(h, { kind: "remote_site_op", op: { op: "add", site } });
        expect(added?.ok, `추가(${JSON.stringify(added)})`);
        await h.sw.evaluate(({ a, b }) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url: a } }, { delayMs: 2500, tool: "navigate_to_url", args: { url: b } }, { text: "끝" }];
          globalThis.__toolLog = [];
        }, { a: `${h.base}/a`, b: `${h.base}/b` });
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "페이지 a와 b를 봐 줘" } } });
        // 첫 이동이 끝나면 목록에서 뺀다(다음 모델 응답은 2.5초 뒤).
        await waitUntil(() => h.sw.evaluate(() => globalThis.__toolLog.some((t) => t.name === "navigate_to_url")), { timeoutMs: 15_000, label: "첫 이동(navigate_to_url)" });
        await ask(h, { kind: "remote_site_op", op: { op: "remove", site } });
        const res = await bridge.reply(2, 30_000);
        expect(!!res?.result, `답(${JSON.stringify(res)})`);
        const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
        expect(log[0] === "navigate_to_url:ok", `허용 사이트로 이동(${log.join(",")})`);
        expect(log[1] && log[1] !== "navigate_to_url:ok", `빼고 난 뒤 이동은 안 함(${log.join(",")})`);
        expect(!(await bridge.seenRequest("elicitation/create", 1, 500)), "묻지 못하는 클라이언트에는 질문 없음");
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "원격 허용 사이트(#192): 허용 사이트에서도 결제 신호가 있는 클릭은 묻지 못하는 MCP 요청에서 하지 않는다",
    pages: { "/shop192": `<title>상점</title><button onclick="document.getElementById('out').textContent='결제됨'">결제하기</button><div id="out"></div>` },
    async run(h) {
      const bridge = await askReady(h, { askApproval: false, capabilities: {} });
      const site = new URL(h.base).origin;
      try {
        await ask(h, { kind: "remote_site_op", op: { op: "add", site } });
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { tool: "find_clickables", args: {} }, { click: "결제하기" }, { text: "끝" }];
          globalThis.__toolLog = [];
        }, `${h.base}/shop192`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "결제 페이지 확인" } } });
        await bridge.reply(2, 30_000);
        const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
        expect(log[0] === "navigate_to_url:ok", `허용 사이트로는 이동(${log.join(",")})`);
        expect(log.some((l) => l.startsWith("click_element:") && l !== "click_element:ok"), `결제 클릭은 하지 않음(${log.join(",")})`);
        const page = h.ctx.pages().find((p) => p.url() === `${h.base}/shop192`);
        expect(!page || (await page.locator("#out").innerText()) === "", "결제 안 됨");
      } finally {
        await ask(h, { kind: "remote_site_op", op: { op: "remove", site } });
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "원격 파일 읽기·링크 읽기(#192): 파일 읽기를 거절하면 요청하지 않고, 링크 읽기를 승인하면 기본 선택만 읽는다",
    pages: {
      "/docs": `<title>자료</title><a href="/files/a.pdf">a.pdf</a> <a href="/l1">첫 글</a> <a href="/l2">둘째 글</a>`,
      "/l1": "<title>L1</title><p>첫 번째 글 본문</p>",
      "/l2": "<title>L2</title><p>두 번째 글 본문</p>",
    },
    async run(h) {
      const bridge = await askReady(h);
      try {
        await h.sw.evaluate(({ docs, file, l1, l2 }) => {
          globalThis.__steps = [
            { tool: "navigate_to_url", args: { url: docs } },
            { tool: "read_document", args: { url: file } },
            { tool: "read_linked_pages", args: { urls: [l1, l2] } },
            { text: "읽었습니다" },
          ];
          globalThis.__toolLog = [];
        }, { docs: `${h.base}/docs`, file: `${h.base}/files/a.pdf`, l1: `${h.base}/l1`, l2: `${h.base}/l2` });
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "자료 읽어 줘" } } });
        const nav = await bridge.request("elicitation/create", 1);
        bridge.send({ jsonrpc: "2.0", id: nav.id, result: { action: "accept", content: { approve: true } } });
        const doc = await bridge.request("elicitation/create", 2);
        expect((doc?.params?.message ?? "").includes("파일 읽기") && doc.params.message.includes("로그인 쿠키와 함께"), `파일 읽기 질문(${doc?.params?.message})`);
        h.hits.length = 0;
        bridge.send({ jsonrpc: "2.0", id: doc.id, result: { action: "decline" } });
        // 링크 읽기 질문은 올 수도 안 올 수도 있다(없으면 아래 if를 건너뜀) — 성공 대기가 아니라 관찰(20초 그대로).
        const links = await bridge.seenRequest("elicitation/create", 3, 20_000);
        expect(!h.hits.some((x) => x.includes("/files/a.pdf")), "거절한 파일은 요청 안 함");
        if (links) {
          expect(links.params.message.includes("링크 읽기") && links.params.message.includes("기본 선택 2개만"), `링크 질문(${links.params.message})`);
          bridge.send({ jsonrpc: "2.0", id: links.id, result: { action: "accept", content: { approve: true } } });
        }
        await bridge.reply(2, 30_000);
        const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
        expect(log.includes("read_document:remote_user_denied"), `파일 읽기 거절(${log.join(",")})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "텔레그램 위임(#192): MCP 클라이언트가 묻지 못하면 텔레그램 버튼으로 묻고(요청 글 앞부분 포함), 질문 중 새 텔레그램 요청은 받지 않으며, 수동 받기 없이 승인이 처리된다",
    pages: { "/news": "<title>뉴스</title><p>경제</p>" },
    async run(h) {
      await tgConnect(h);
      const bridge = await askReady(h, { askApproval: false, capabilities: {} });
      try {
        const on = await ask(h, { kind: "mcp_set", askViaTelegram: true });
        expect(on?.ok && on.data.askViaTelegram, "위임 켬");
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "다녀왔습니다" }];
          globalThis.__toolLog = [];
        }, `${h.base}/news`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해 줘" } } });
        const a = await tgWaitAsk(h, 1, 20_000);
        expect(a.length === 1 && a[0].text.includes("[MCP 요청]") && a[0].text.includes("요청: 오늘 경제 뉴스 정리해 줘") && a[0].text.includes(`${h.base}/news`), `텔레그램 질문(${JSON.stringify(a)})`);
        expect(!(await bridge.seenRequest("elicitation/create", 1, 300)), "클라이언트에는 묻지 않음");
        // 질문 중 새 텔레그램 요청은 받지 않는다.
        await tgDeliver(h, "다른 요청");
        const r = await tgReplies(h);
        expect(r.some((t) => t.includes("다른 요청(MCP)의 승인 질문을 기다리고")), `바쁨 안내(${JSON.stringify(r)})`);
        // 수동 받기(poll) 없이 버튼을 넣어도 위임 질문의 받기 루프가 처리한다.
        await tgPress(h, a[0].yes, { poll: false });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result?.content?.[0]?.text === "다녀왔습니다", `최종 답(${JSON.stringify(res)})`);
        const log = await h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));
        expect(log[0] === "navigate_to_url:ok", `승인 뒤 이동(${log.join(",")})`);
        void tgAsks;
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", askViaTelegram: false });
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "같은 모델 호출 id(#221): 패널 카드가 기다리는 동안 MCP가 같은 id로 링크 읽기를 준비했다 거절해도, 패널을 승인하면 패널이 고른 링크를 읽는다",
    pages: LINKS221,
    async run(h) {
      const bridge = await askReady(h);
      try {
        const l1 = `${h.base}/l1`;
        const l2 = `${h.base}/l2`;
        const card = await panelCard(h, [{ tool: "read_linked_pages", args: { urls: [l1] }, callId: "call_0" }], "첫 글 읽어 줘");
        await h.sw.evaluate(({ docs, l2 }) => {
          globalThis.__steps = [
            { tool: "navigate_to_url", args: { url: docs }, callId: "call_nav" },
            // 원격 작업 탭이 막 이동한 뒤라 content script가 뜰 시간을 둔다.
            { tool: "read_linked_pages", args: { urls: [l2] }, callId: "call_0", delayMs: 1000 },
            { text: "MCP 끝" },
          ];
        }, { docs: `${h.base}/docs`, l2 });
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "자료 둘째 글 읽어 줘" } } });
        const links = await linkQuestion(bridge);
        expect(links, "MCP 링크 질문");
        bridge.send({ jsonrpc: "2.0", id: links.id, result: { action: "decline" } });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result, `MCP 답(${JSON.stringify(res)})`);
        h.hits.length = 0;
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ text: "패널 끝" }];
        });
        await card.locator(".btn-approve").first().click();
        await panelIdle(h, "패널 턴이 끝남");
        expect(h.hits.some((x) => x.includes("/l1")), `패널이 고른 링크를 읽음(${JSON.stringify(h.hits)})`);
        const reads = await linkReads(h);
        expect(reads.some((r) => r.callId === "call_0" && r.error === null), `패널 결과는 모델 id 그대로·성공(${JSON.stringify(reads)})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "같은 모델 호출 id(#221): MCP 링크 읽기 질문이 열린 동안 패널이 같은 id 카드를 취소해도, MCP를 승인하면 MCP가 자기 후보를 읽는다",
    pages: LINKS221,
    async run(h) {
      const bridge = await askReady(h);
      try {
        const l1 = `${h.base}/l1`;
        const l2 = `${h.base}/l2`;
        const card = await panelCard(h, [{ tool: "read_linked_pages", args: { urls: [l1] }, callId: "call_0" }], "첫 글 읽어 줘");
        await h.sw.evaluate(({ docs, l2 }) => {
          globalThis.__steps = [
            { tool: "navigate_to_url", args: { url: docs }, callId: "call_nav" },
            // 원격 작업 탭이 막 이동한 뒤라 content script가 뜰 시간을 둔다.
            { tool: "read_linked_pages", args: { urls: [l2] }, callId: "call_0", delayMs: 1000 },
          ];
        }, { docs: `${h.base}/docs`, l2 });
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "자료 둘째 글 읽어 줘" } } });
        const links = await linkQuestion(bridge);
        expect(links, "MCP 링크 질문");
        // 양쪽 후보가 함께 살아 있는 동안 패널을 취소한다.
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ text: "끝" }, { text: "끝" }];
        });
        await card.locator(".btn-cancel").first().click();
        await panelIdle(h, "패널 턴이 끝남");
        h.hits.length = 0;
        bridge.send({ jsonrpc: "2.0", id: links.id, result: { action: "accept", content: { approve: true } } });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result, `MCP 답(${JSON.stringify(res)})`);
        expect(h.hits.some((x) => x.includes("/l2")) && !h.hits.some((x) => x.includes("/l1")), `MCP가 자기 후보만 읽음(${JSON.stringify(h.hits)})`);
        const reads = await linkReads(h);
        expect(reads.some((r) => r.callId === "call_0" && r.error === null), `MCP 결과는 모델 id 그대로·성공(${JSON.stringify(reads)})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "같은 모델 호출 id(#221): 한 대화에서 앞 턴의 id를 다시 쓰는 호출 블록이 중간에 멈춰도, 다음 요청에 이번 블록의 결과가 빠짐·겹침 없이 간다",
    pages: LINKS221,
    async run(h) {
      const l1 = `${h.base}/l1`;
      // 1턴: call_0·call_1 두 호출을 한 블록으로 끝낸다.
      const r1 = await h.turn([{ calls: [{ tool: "describe_page", args: {}, callId: "call_0" }, { tool: "describe_page", args: {}, callId: "call_1" }] }, { text: "봤습니다" }], { path: "/docs", text: "봐 줘" });
      expect(!r1.stoppedAtCard, "1턴은 카드 없이 끝남");
      // 2턴: 같은 id로 call_0(완료) → call_1(승인 카드에서 멈춤).
      await panelCard(h, [{ calls: [{ tool: "describe_page", args: {}, callId: "call_0" }, { tool: "read_linked_pages", args: { urls: [l1] }, callId: "call_1" }] }], "다시 봐 줘");
      await h.panel.click("button.composer-btn.danger");
      await panelIdle(h, "멈춤");
      // 3턴: 보낸 기록의 마지막 호출 블록 뒤에 이번 블록의 결과가 하나씩 있다.
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.turn([{ text: "끝" }], { noReload: true, text: "이어서" });
      const msgs = await h.sw.evaluate(() => globalThis.__modelReqs.find((r) => Array.isArray(r.body?.messages) && r.body.stream)?.body.messages ?? []);
      let at = -1;
      msgs.forEach((m, i) => {
        if (m.role === "assistant" && m.tool_calls?.length) at = i;
      });
      const ids = msgs.slice(at + 1).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
      expect(at >= 0 && ids.filter((x) => x === "call_0").length === 1 && ids.filter((x) => x === "call_1").length === 1, `마지막 블록의 결과(${JSON.stringify(ids)})`);
    },
  },
  {
    name: "텔레그램 위임(#224): 묻기를 끈 뒤 토큰을 지우고 다시 연결하면 기본값(켬)대로 위임하고, 질문은 실제 만료(5분 이내)를 안내한다",
    pages: { "/news": "<title>뉴스</title><p>경제</p>" },
    async run(h) {
      await tgConnect(h);
      expect((await ask(h, { kind: "telegram_set_ask", on: false })).ok, "묻기 끔");
      expect((await ask(h, { kind: "telegram_clear" })).ok, "토큰 지우기");
      await tgConnect(h);
      const st = await ask(h, { kind: "telegram_status" });
      expect(st.data.askApproval === true, `다시 연결하면 묻기 켬(${JSON.stringify(st.data)})`);
      const bridge = await askReady(h, { askApproval: false, capabilities: {} });
      try {
        expect((await ask(h, { kind: "mcp_set", askViaTelegram: true }))?.ok, "위임 켬");
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "다녀왔습니다" }];
          globalThis.__toolLog = [];
        }, `${h.base}/news`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해 줘" } } });
        const a = await tgWaitAsk(h, 1, 20_000);
        const m = /(\d+)(분|초) 안에 누르지 않으면/.exec(a[0]?.text ?? "");
        expect(m && (m[2] === "초" || Number(m[1]) <= 5), `남은 시간 안내(${JSON.stringify(a)})`);
        await tgPress(h, a[0].yes, { poll: false });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result?.content?.[0]?.text === "다녀왔습니다", `최종 답(${JSON.stringify(res)})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", askViaTelegram: false });
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "작업 기록(#145): 결과 전송이 실패하면 저장해 두고 다음 폴링에서 다시 보낸다",
    async run(h) {
      const bridge = await askReady(h, { askApproval: false, capabilities: {} });
      try {
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ delayMs: 2000, text: "늦은 답" }];
        });
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "날씨 알려 줘" } } });
        // 받았다는 확인을 보낸 뒤, 최종 결과 전송만 세 번(postResult 한 번의 재시도 전부) 실패하게 한다.
        await h.panel.waitForTimeout(1000);
        await h.sw.evaluate(() => {
          const prev = globalThis.fetch;
          globalThis.__failResults = 3;
          globalThis.fetch = async (u, init) => {
            if (String(u).endsWith("/v1/result") && globalThis.__failResults > 0) {
              globalThis.__failResults--;
              throw new TypeError("Failed to fetch");
            }
            return prev(u, init);
          };
        });
        const res = await bridge.reply(2, 45_000);
        expect(res?.result?.content?.[0]?.text === "늦은 답", `다시 보낸 최종 답(${JSON.stringify(res)})`);
        expect((await h.sw.evaluate(() => globalThis.__failResults)) === 0, "실패를 거친 뒤 보냄");
        await mcpCleared(h, "보낸 뒤 기록 정리", 5000, 200);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "작업 기록(#145): 다시 뜬 뒤 남은 작업 기록은 중단 결과로 바꿔 보내고 정리한다",
    async run(h) {
      const bridge = await askReady(h, { askApproval: false, capabilities: {} });
      try {
        // 다리는 할 일이 없으면 첫 폴링을 20초까지 붙잡는다 — 그 응답에서 다리 id를 저장한다.
        const bridgeId = await waitUntil(async () => (await mcpState(h))?.bridgeId, { timeoutMs: 30_000, intervalMs: 200, label: "다리 연결" });
        // 서비스 워커가 실행 중에 내려갔다가 다시 뜬 것처럼, 맡지 않은 작업 기록을 저장소에 둔다.
        await h.sw.evaluate(async (id) => {
          const s = (await chrome.storage.local.get("mcp")).mcp;
          await chrome.storage.local.set({ mcp: { ...s, job: { bridgeId: id, jobId: "j-old" } } });
        }, bridgeId);
        await mcpCleared(h, "중단 보고 뒤 정리", 30_000, 300);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "승인 질문(#185): 주소 없는 이동은 클라이언트에 elicitation으로 묻고, accept+approve면 이동한다",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      const bridge = await askReady(h);
      try {
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "정리했습니다" }];
          globalThis.__toolLog = [];
        }, `${h.base}/news`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해줘" } } });
        const q = await bridge.request("elicitation/create");
        expect(q?.params?.mode === "form" && q.params.message.includes(`${h.base}/news`) && q.params.requestedSchema.properties.approve.default === false, `질문(${JSON.stringify(q)})`);
        expect((await toolLog(h)).length === 0, "답 전에는 실행 안 함");
        bridge.send({ jsonrpc: "2.0", id: q.id, result: { action: "accept", content: { approve: true } } });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result?.content?.[0]?.text === "정리했습니다", `최종 답(${JSON.stringify(res)})`);
        const log = await toolLog(h);
        expect(log[0] === "navigate_to_url:ok", `승인 후 이동(${log.join(",")})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "승인 질문(#185): decline이면 이동하지 않고, 작업을 취소하면 질문을 거둔다",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      const bridge = await askReady(h);
      try {
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "안 함" }];
          globalThis.__toolLog = [];
        }, `${h.base}/news`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해줘" } } });
        const q = await bridge.request("elicitation/create");
        bridge.send({ jsonrpc: "2.0", id: q.id, result: { action: "decline" } });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result && !res.result.isError, `마무리 답(${JSON.stringify(res)})`);
        const log = await toolLog(h);
        expect(log.length === 1 && log[0] === "navigate_to_url:remote_user_denied", `거절(${log.join(",")})`);

        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "멈춤" }];
          globalThis.__toolLog = [];
        }, `${h.base}/news`);
        bridge.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해줘" } } });
        const q2 = await bridge.request("elicitation/create", 2);
        expect(!!q2, "두 번째 질문");
        bridge.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } });
        const withdrawn = await bridge.request("notifications/cancelled");
        expect(withdrawn?.params?.requestId === q2.id, `질문을 거둠(${JSON.stringify(withdrawn)})`);
        // 거둔 뒤 온 승인은 쓰지 않는다.
        bridge.send({ jsonrpc: "2.0", id: q2.id, result: { action: "accept", content: { approve: true } } });
        await h.panel.waitForTimeout(1500);
        const log2 = await toolLog(h);
        expect(!log2.includes("navigate_to_url:ok"), `취소 뒤 실행 안 함(${log2.join(",")})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "승인 질문(#185): 기다리는 중 MCP 연동을 끄면 질문을 보낸 다리에 거두기를 보낸다",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      const bridge = await askReady(h);
      try {
        await h.sw.evaluate((url) => {
          globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "멈춤" }];
          globalThis.__toolLog = [];
        }, `${h.base}/news`);
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해줘" } } });
        const q = await bridge.request("elicitation/create");
        expect(!!q, "질문");
        await ask(h, { kind: "mcp_set", enabled: false });
        const withdrawn = await bridge.request("notifications/cancelled", 1, 15_000);
        expect(withdrawn?.params?.requestId === q.id, `연결을 바꾼 뒤에도 거둠(${JSON.stringify(withdrawn)})`);
      } finally {
        bridge.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "승인 질문(#185): 설정이 꺼져 있거나 클라이언트가 form elicitation을 지원하지 않으면 묻지 않고 거절한다",
    pages: { "/news": `<title>뉴스 페이지</title><p>오늘의 경제</p>` },
    async run(h) {
      for (const opts of [{ askApproval: false }, { capabilities: { elicitation: { url: {} } } }, { version: "2024-11-05" }]) {
        const bridge = await askReady(h, opts);
        try {
          await h.sw.evaluate((url) => {
            globalThis.__steps = [{ tool: "navigate_to_url", args: { url } }, { text: "못 함" }];
            globalThis.__toolLog = [];
          }, `${h.base}/news`);
          bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "오늘 경제 뉴스 정리해줘" } } });
          const res = await bridge.reply(2, 30_000);
          expect(!!res?.result, `답(${JSON.stringify(opts)})`);
          expect(!bridge.requests.some((r) => r.method === "elicitation/create"), `묻지 않음(${JSON.stringify(opts)})`);
          const log = await toolLog(h);
          expect(log.includes("navigate_to_url:remote_needs_approval"), `거절(${JSON.stringify(opts)} ${log.join(",")})`);
        } finally {
          bridge.stop();
          await ask(h, { kind: "mcp_set", enabled: false });
        }
      }
    },
  },
  {
    name: "설정의 다리 안내: 릴리스 ZIP에서 받는 링크와 mcp/sbp-mcp.mjs 등록 명령(웹 스토어판에는 다리가 없음)",
    async run(h) {
      await ask(h, { kind: "mcp_set", enabled: true });
      try {
        const opt = await h.openOptions("model");
        const link = opt.locator("a.mcp-release-link");
        await link.waitFor({ timeout: 5000 });
        expect((await link.getAttribute("href"))?.endsWith("/releases/latest"), "최신 릴리스 링크");
        expect((await link.getAttribute("target")) === "_blank", "새 탭으로");
        const cmds = await opt.locator("pre.tool-card-details").allInnerTexts();
        expect(cmds.some((t) => t.includes("claude mcp add") && t.includes("/mcp/sbp-mcp.mjs")), `등록 명령(${cmds.join(" | ").slice(0, 300)})`);
      } finally {
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
  {
    name: "다리의 tools/call을 확장이 가져가 처리하고 최종 답을 돌려준다, 비밀이 다르면 가져가지 않는다",
    async run(h) {
      const on = await ask(h, { kind: "mcp_set", enabled: true });
      expect(on.ok && on.data.enabled && on.data.hasSecret && !("secret" in on.data), `켜기(${JSON.stringify(on)})`);
      const secret = (await ask(h, { kind: "mcp_secret" })).data;
      const bridge = startBridge(secret);
      try {
        const port = await bridge.port;
        await ask(h, { kind: "mcp_set", port });
        bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "harness", version: "1" } } });
        const init = await bridge.reply(1);
        expect(init?.result?.protocolVersion === "2025-06-18", `초기화(${JSON.stringify(init)})`);
        bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        await h.sw.evaluate(() => {
          globalThis.__steps = [{ text: "오늘은 맑습니다." }];
          globalThis.__modelReqs = [];
        });
        bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "날씨 알려 줘" } } });
        const res = await bridge.reply(2, 30_000);
        expect(res?.result && !res.result.isError && res.result.content[0].text === "오늘은 맑습니다.", `최종 답(${JSON.stringify(res)})`);
        const sent = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs.map((r) => r.body.messages.filter((m) => m.role === "user"))));
        expect(sent.includes("다른 AI 도구(MCP)") && sent.includes("날씨 알려 줘"), "원격 안내와 요청");
        const st = await ask(h, { kind: "mcp_status" });
        expect(st.data.connected, "연결됨");
      } finally {
        bridge.stop();
      }

      const wrong = startBridge("A".repeat(43));
      try {
        const port = await wrong.port;
        await ask(h, { kind: "mcp_set", port });
        wrong.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        await wrong.reply(1);
        wrong.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_task", arguments: { request: "몰래" } } });
        await h.panel.waitForTimeout(4000);
        expect(!(await wrong.seenReply(2, 100)), "비밀이 다르면 가져가지 않음");
        const st = await ask(h, { kind: "mcp_status" });
        expect(/인증/.test(st.data.lastError), `인증 실패 표시(${st.data.lastError})`);
      } finally {
        wrong.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
];
