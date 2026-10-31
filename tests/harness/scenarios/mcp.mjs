// MCP 연동(#140): 실제 다리(mcp/sbp-mcp.mjs)를 포트 0으로 띄우고 stdio로 tools/call을 보내, 확장이 폴링해 처리한 최종 답이 오는지.
// 비밀이 다른 다리에서는 확장이 인증에 실패해 요청을 가져가지 않는다.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "../lib.mjs";

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
  const reply = async (id, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (replies.has(id)) return replies.get(id);
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const request = async (method, n = 1, ms = 20_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const got = requests.filter((r) => r.method === method);
      if (got.length >= n) return got[n - 1];
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  return { child, port, send, reply, request, requests, stop: () => child.kill() };
}

const ask = (h, msg) => h.panel.evaluate(async (m) => chrome.runtime.sendMessage(m), msg);

// 승인 질문 시나리오의 준비: 켜기·질문 설정·다리·초기화(elicitation 지원 여부는 capabilities로).
async function askReady(h, { askApproval = true, capabilities = { elicitation: {} }, version = "2025-11-25" } = {}) {
  await ask(h, { kind: "mcp_set", enabled: true });
  await ask(h, { kind: "mcp_set", askApproval });
  const secret = (await ask(h, { kind: "mcp_secret" })).data;
  const bridge = startBridge(secret);
  const port = await bridge.port;
  await ask(h, { kind: "mcp_set", port });
  bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities, clientInfo: { name: "harness", version: "1" } } });
  await bridge.reply(1);
  bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return bridge;
}

const toolLog = (h) => h.sw.evaluate(() => globalThis.__toolLog.map((t) => `${t.name}:${t.error ?? "ok"}`));

export default [
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
        expect(!(await wrong.reply(2, 100)), "비밀이 다르면 가져가지 않음");
        const st = await ask(h, { kind: "mcp_status" });
        expect(/인증/.test(st.data.lastError), `인증 실패 표시(${st.data.lastError})`);
      } finally {
        wrong.stop();
        await ask(h, { kind: "mcp_set", enabled: false });
      }
    },
  },
];
