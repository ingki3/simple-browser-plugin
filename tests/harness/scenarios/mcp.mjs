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
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
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
  return { child, port, send, reply, stop: () => child.kill() };
}

const ask = (h, msg) => h.panel.evaluate(async (m) => chrome.runtime.sendMessage(m), msg);

export default [
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
