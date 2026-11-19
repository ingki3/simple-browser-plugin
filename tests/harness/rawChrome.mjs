// Playwright 없이 Chrome for Testing을 띄우고 CDP(웹소켓)로 직접 다루는 작은 실행기(#307 유휴 생존 시나리오 전용).
// 왜 따로 두나: Playwright는 확장 서비스 워커에 자동으로 붙고(Target.setAutoAttach), DevTools가 붙은 서비스 워커는 Chrome이
// 유휴로 내리지 않는다 — 그래서 공용 하네스에서는 "워커가 유휴로 내려가는가"를 볼 수 없다(75초 동안 아무것도 없어도 같은 워커였다).
// 여기서는 서비스 워커에 필요할 때만 붙고(attachWorker) 바로 뗀다. 확장 화면은 페이지 타깃으로 열어 다룬다(페이지에 붙는 것은
// 서비스 워커의 수명에 영향이 없다).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome, prepareExtension } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 함수와 인자를 CDP Runtime.evaluate 식으로 바꾼다(Playwright evaluate와 같은 모양: fn(arg) 또는 문자열 식).
function expression(fn, arg) {
  if (typeof fn === "string") return fn;
  return arg === undefined ? `(${fn})()` : `(${fn})(${JSON.stringify(arg)})`;
}

export async function launchRaw({ args = [] } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome for Testing을 찾지 못했습니다(HARNESS_CHROME).");
  const ext = prepareExtension();
  const userDataDir = mkdtempSync(join(tmpdir(), "sbp-raw-"));
  const proc = spawn(
    chrome,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      ...(process.env.HARNESS_HEADED ? [] : ["--headless=new"]),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      ...args,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(userDataDir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) {
    proc.kill();
    throw new Error("Chrome의 DevTools 포트를 읽지 못했습니다.");
  }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP 연결 실패"));
  });
  let seq = 0;
  const waiting = new Map();
  // 서비스 워커 콘솔(붙어 있는 동안만): "[SBP tag] …" 줄.
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`));
      else w?.resolve(m.result);
    } else if (m.method === "Runtime.consoleAPICalled") {
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function evaluate(sessionId, fn, arg) {
    const r = await send("Runtime.evaluate", { expression: expression(fn, arg), awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  // 이 확장의 서비스 워커(빌드가 만든 service-worker-loader.js — Chrome에 따라 붙은 다른 확장 워커와 가른다).
  const loader = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")).background.service_worker;
  const workerTarget = async () =>
    (await send("Target.getTargets")).targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith(`/${loader}`));
  let first = null;
  for (let i = 0; i < 100 && !(first = await workerTarget()); i++) await sleep(100);
  if (!first) throw new Error("확장 서비스 워커가 뜨지 않았습니다.");
  const extId = new URL(first.url).host;

  // 지금 서비스 워커에 붙는다(없으면 null — 내려가 있다). detach()로 반드시 뗀다(붙어 있는 동안은 유휴로 내려가지 않는다).
  async function attachWorker() {
    const t = await workerTarget();
    if (!t) return null;
    const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    // 막 뜬 워커는 확장 API가 아직 묶이지 않았을 수 있다(chrome 없음) — 묶일 때까지 기다린다.
    for (let i = 0; i < 100; i++) {
      if ((await evaluate(sessionId, "typeof chrome !== 'undefined' && !!chrome.storage").catch(() => false)) === true) break;
      await sleep(100);
    }
    return {
      evaluate: (fn, arg) => evaluate(sessionId, fn, arg),
      detach: () => send("Target.detachFromTarget", { sessionId }).catch(() => {}),
    };
  }

  // 확장 화면 하나를 새 탭으로 연다(경로는 확장 안 경로).
  async function openPage(pathInExt) {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/${pathInExt}` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    for (let i = 0; i < 100; i++) {
      // 처음의 빈 문서(about:blank)가 아니라 확장 화면이 다 읽힌 뒤.
      const ready = await evaluate(sessionId, "location.protocol + ' ' + document.readyState").catch(() => null);
      if (ready === "chrome-extension: complete") break;
      await sleep(100);
    }
    return {
      evaluate: (fn, arg) => evaluate(sessionId, fn, arg),
      close: () => send("Target.closeTarget", { targetId }).catch(() => {}),
    };
  }

  async function close() {
    await send("Browser.close").catch(() => {});
    ws.close();
    await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(5000)]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }

  return { extId, attachWorker, openPage, close, logs };
}
