#!/usr/bin/env node
// 간편 브라우저 도우미 MCP 다리(#140). Node 22 이상, 내장 모듈만 쓴다(설치할 것 없음).
//
// MCP 클라이언트(Claude Desktop·Claude Code 등)가 stdio로 띄운다. 도구 browser_task 하나를 내놓고, 받은 요청을 127.0.0.1의 작은
// HTTP 창구에 올려 둔다. 브라우저 확장이 그 창구를 폴링해 요청을 가져가 처리하고 최종 답을 돌려준다(확장은 포트를 열 수 없다).
// 확장과는 설정에서 만든 비밀(SBP_SECRET)로 서로를 확인하고, 모든 본문을 AES-GCM으로 암호화한다(src/lib/mcpProtocol.ts와 같은 계산).
//
// 환경변수: SBP_SECRET(필수, 확장 설정의 비밀), SBP_PORT(선택, 기본 47615).
// stdout에는 JSON-RPC만 쓴다. 알림·오류는 stderr로.
import { createServer } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BRIDGE_VERSION = "1.0.0";
export const PROTOCOL_VERSION = 1;
// 2025-03-26은 JSON-RPC batch 수신이 필수라 넣지 않는다(batch를 처리하지 않는다).
export const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];
const DEFAULT_PORT = 47615;
const CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 5 * 60_000;
const POLL_HOLD_MS = 20_000;
// 확장이 가져가기를 기다리는 시간. 확장은 다리에 닿지 않으면 1분 알람으로 다시 붙으므로 그보다 길게.
const PICKUP_MS = 90_000;
const JOB_DEADLINE_MS = 10 * 60_000;
const MAX_BODY = 256 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_CONNECTIONS = 8;
const MAX_REQUEST = 4000;

// ---- 프로토콜(src/lib/mcpProtocol.ts와 같은 계산) ----

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("잘못된 base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
}

export async function deriveKeys(secret) {
  const raw = fromB64url(secret);
  if (raw.length !== 32) throw new Error("SBP_SECRET은 확장 설정에서 복사한 32바이트 비밀이어야 합니다.");
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: enc.encode("sbp-mcp-v1"), info: enc.encode(info) });
  const aes = (info) => crypto.subtle.deriveKey(hkdf(info), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    extEnc: await aes("ext->bridge"),
    bridgeEnc: await aes("bridge->ext"),
    extMac: await crypto.subtle.deriveKey(hkdf("ext-mac"), base, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]),
  };
}

export function parseHeader(text) {
  try {
    const h = JSON.parse(dec.decode(fromB64url(text)));
    if (h.v !== PROTOCOL_VERSION || typeof h.ts !== "number" || typeof h.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(h.nonce)) return null;
    return { v: h.v, ts: h.ts, nonce: h.nonce };
  } catch {
    return null;
  }
}

export const aadOf = (method, path, header) => `${method} ${path}\n${header}`;

export async function verifyRequest(keys, method, path, header, mac) {
  try {
    return await crypto.subtle.verify("HMAC", keys.extMac, fromB64url(mac), enc.encode(aadOf(method, path, header)));
  } catch {
    return false;
  }
}

export async function seal(key, aad, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

export async function open(key, aad, body) {
  const bytes = fromB64url(body.trim());
  if (bytes.length < 28) throw new Error("본문이 너무 짧습니다.");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(aad) }, key, bytes.slice(12));
  return JSON.parse(dec.decode(pt));
}

// ---- 다리 ----

const TOOL = {
  name: "browser_task",
  description:
    "사용자의 Chrome에 설치된 '간편 브라우저 도우미'에게 브라우저 일을 시키고 최종 답을 받는다(새 탭에서 처리). 페이지 읽기·요약, 요청에 적은 사이트로 이동, 그 사이트 안의 일반 클릭·입력을 한다. 승인이 필요한 동작(결제·주문, 삭제, 개인정보·비밀번호 입력, 로그인, 파일 저장, 요청에 적지 않은 사이트로 이동)은 하지 않고, 그런 일은 사용자가 브라우저 패널에서 직접 하라고 답한다. 한 번에 하나만 처리하며 최대 10분 걸린다.",
  inputSchema: {
    type: "object",
    properties: { request: { type: "string", description: "할 일(한국어 가능, 4000자 이내). 이동할 사이트는 주소나 도메인으로 적는다(예: naver.com)." } },
    required: ["request"],
    additionalProperties: false,
  },
};

// 다리 하나의 상태와 동작. 테스트가 stdio·HTTP 없이도 부를 수 있게 함수로 나눈다.
export function createBridge({ keys, write, now = () => Date.now(), log = () => {} }) {
  const bridgeId = b64url(crypto.getRandomValues(new Uint8Array(12)));
  let initialized = false;
  let job = null; // {jobId, rpcId, request, deadline, state: "queued"|"leased", timers}
  const cancels = new Set(); // 확장에 알릴 취소된 작업
  const nonces = new Map();
  const waiters = new Set(); // 대기 중인 /next 응답 함수
  let lastContact = 0;

  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });
  const toolError = (id, text) => reply(id, { content: [{ type: "text", text }], isError: true });

  function finish(state, why) {
    if (!job) return;
    for (const t of job.timers) clearTimeout(t);
    if (state === "cancelled" && job.state === "leased") cancels.add(job.jobId);
    log(`작업 ${job.jobId.slice(0, 6)} ${state}${why ? `: ${why}` : ""}`);
    job = null;
    wake();
  }

  function wake() {
    for (const w of [...waiters]) w();
  }

  function startJob(rpcId, request) {
    const jobId = b64url(crypto.getRandomValues(new Uint8Array(12)));
    job = { jobId, rpcId, request, deadline: now() + JOB_DEADLINE_MS, state: "queued", timers: [] };
    const mine = job;
    mine.timers.push(
      setTimeout(() => {
        if (job === mine && mine.state === "queued") {
          toolError(rpcId, "브라우저 확장이 요청을 가져가지 않았습니다. Chrome이 켜져 있고 확장 설정의 MCP 연동이 켜져 있는지, SBP_SECRET·SBP_PORT가 맞는지 확인하세요.");
          finish("done", "가져가지 않음");
        }
      }, PICKUP_MS),
      setTimeout(() => {
        if (job === mine) {
          toolError(rpcId, "10분 안에 끝나지 않아 멈췄습니다.");
          finish("cancelled", "시간 초과");
        }
      }, JOB_DEADLINE_MS),
    );
    wake();
  }

  // JSON-RPC 메시지 하나(이미 파싱한 값). 응답은 write로.
  function handleRpc(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg && typeof msg === "object" && "id" in msg && !("method" in msg)) return; // 응답(우리는 요청을 보내지 않는다)
      return fail(msg?.id ?? null, -32600, "Invalid Request");
    }
    const isNote = !("id" in msg);
    const { id, method, params } = msg;
    if (method === "notifications/initialized") return;
    if (method === "notifications/cancelled") {
      if (job && params && params.requestId === job.rpcId) finish("cancelled", "클라이언트 취소");
      return;
    }
    if (isNote) return;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      initialized = true;
      return reply(id, {
        protocolVersion: SUPPORTED_MCP_VERSIONS.includes(asked) ? asked : SUPPORTED_MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "simple-browser-helper", version: BRIDGE_VERSION },
      });
    }
    if (method === "ping") return reply(id, {});
    if (!initialized) return fail(id, -32002, "Server not initialized");
    if (method === "tools/list") return reply(id, { tools: [TOOL] });
    if (method === "tools/call") {
      if (params?.name !== "browser_task") return fail(id, -32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments;
      const keysOk = args && typeof args === "object" && Object.keys(args).every((k) => k === "request");
      const request = typeof args?.request === "string" ? args.request.trim() : "";
      if (!keysOk || !request || request.length > MAX_REQUEST) return fail(id, -32602, "request는 1~4000자 글자여야 합니다.");
      if (job) return toolError(id, "브라우저 도우미가 앞의 요청을 처리하고 있습니다. 끝난 뒤 다시 요청하세요.");
      return startJob(id, request);
    }
    return fail(id, -32601, `Method not found: ${method}`);
  }

  // 확장 요청 인증. 성공하면 머리(문자열), 실패하면 null. 인증한 nonce만 기억한다.
  async function authenticate(method, path, header, mac) {
    if (typeof header !== "string" || typeof mac !== "string" || header.length > 512 || mac.length > 128) return null;
    const h = parseHeader(header);
    if (!h || Math.abs(now() - h.ts) > CLOCK_SKEW_MS) return null;
    if (!(await verifyRequest(keys, method, path, header, mac))) return null;
    for (const [n, t] of nonces) if (now() - t > NONCE_TTL_MS) nonces.delete(n);
    if (nonces.has(h.nonce)) return null;
    nonces.set(h.nonce, now());
    lastContact = now();
    return header;
  }

  // /v1/next: 작업·취소가 있으면 바로, 없으면 최대 POLL_HOLD_MS 기다린다.
  async function next(header, signal) {
    const pick = () => {
      const out = { bridgeId, version: BRIDGE_VERSION };
      if (cancels.size) out.cancel = [...cancels];
      if (job && job.state === "queued") {
        job.state = "leased";
        out.job = { jobId: job.jobId, request: job.request, deadline: job.deadline };
      }
      return out.job || out.cancel ? out : null;
    };
    let value = pick();
    if (!value) {
      await new Promise((resolve) => {
        const done = () => {
          waiters.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, POLL_HOLD_MS);
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      value = signal?.aborted ? null : (pick() ?? { bridgeId, version: BRIDGE_VERSION });
    }
    if (!value) return null;
    return seal(keys.bridgeEnc, aadOf("GET", "/v1/next", header), value);
  }

  // /v1/result: 같은 작업에 한 번만 반영. 끝났거나 취소된 작업이면 무시하고, 취소 확인이면 취소 목록에서 지운다.
  async function result(header, body) {
    const r = await open(keys.extEnc, aadOf("POST", "/v1/result", header), body);
    if (!r || typeof r.jobId !== "string") throw new Error("bad result");
    cancels.delete(r.jobId);
    if (job && job.jobId === r.jobId && job.state === "leased") {
      const text = typeof r.text === "string" ? r.text.slice(0, 100_000) : "";
      if (r.outcome === "ok") reply(job.rpcId, { content: [{ type: "text", text: text || "끝났습니다." }] });
      else toolError(job.rpcId, text || "브라우저 도우미가 요청을 처리하지 못했습니다.");
      finish("done");
    }
    return seal(keys.bridgeEnc, aadOf("POST", "/v1/result", header), { ok: true });
  }

  // 클라이언트가 끝났다(stdin EOF): 진행 중 작업을 취소한다.
  function shutdown() {
    if (job) finish("cancelled", "클라이언트 종료");
  }

  return { bridgeId, handleRpc, authenticate, next, result, shutdown, state: () => ({ job, cancels: [...cancels], lastContact }) };
}

// HTTP 창구. 127.0.0.1에만. 정확한 경로·메서드·Host만, 웹 페이지 Origin은 거절, CORS 없음.
export function createHttp(bridge, port) {
  let connections = 0;
  const server = createServer(async (req, res) => {
    const send = (status, body = "") => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    if (connections >= MAX_CONNECTIONS) return send(503);
    connections++;
    res.on("close", () => connections--);
    const host = req.headers.host ?? "";
    const actualPort = server.address()?.port ?? port;
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) return send(421);
    const origin = req.headers.origin;
    if (origin && !origin.startsWith("chrome-extension://")) return send(403);
    const path = (req.url ?? "").split("?")[0];
    const route = `${req.method} ${path}`;
    if (route !== "GET /v1/next" && route !== "POST /v1/result") return send(404);
    const header = await bridge.authenticate(req.method, path, req.headers["x-sbp"], req.headers["x-sbp-mac"]);
    if (!header) return send(401);
    try {
      if (route === "GET /v1/next") {
        const ac = new AbortController();
        res.on("close", () => ac.abort());
        const body = await bridge.next(header, ac.signal);
        if (body !== null && !res.writableEnded) send(200, body);
        return;
      }
      let size = 0;
      const chunks = [];
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) return send(413);
        chunks.push(c);
      }
      send(200, await bridge.result(header, Buffer.concat(chunks).toString("utf8")));
    } catch {
      send(400);
    }
  });
  return server;
}

// 줄 단위 JSON-RPC 읽기. UTF-8이 청크 사이에서 갈려도, 한 청크에 여러 줄이 와도 처리한다.
export function lineReader(onLine, onOverflow) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  return (chunk) => {
    buf += decoder.write(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    if (buf.length > MAX_LINE) {
      buf = "";
      onOverflow();
    }
  };
}

async function main() {
  const log = (m) => process.stderr.write(`[sbp-mcp] ${m}\n`);
  const secret = process.env.SBP_SECRET ?? "";
  const port = Number(process.env.SBP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log("SBP_PORT는 0~65535 정수여야 합니다.");
    process.exit(1);
  }
  let keys;
  try {
    keys = await deriveKeys(secret);
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const write = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const bridge = createBridge({ keys, write, log });
  const server = createHttp(bridge, port);
  server.on("error", (err) => {
    log(err.code === "EADDRINUSE" ? `포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다. 다른 포트(SBP_PORT)를 쓰고 확장 설정의 포트도 같게 바꾸세요.` : String(err));
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => log(`준비됨: 127.0.0.1:${server.address().port}`));
  const feed = lineReader(
    (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      bridge.handleRpc(msg);
    },
    () => log("너무 긴 줄을 버렸습니다."),
  );
  process.stdin.on("data", feed);
  process.stdin.on("end", () => {
    bridge.shutdown();
    // 확장이 취소를 가져갈 시간을 잠깐 준다.
    setTimeout(() => process.exit(0), 1500);
  });
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) void main();
