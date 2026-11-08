// ChatAgent 단위 시험용 해석·변환 훅(#263 단계 4). chatAgent.ts가 부르는 모듈 가운데 Node 타입 제거로 불러올 수 없는 것
// (TS 매개변수 속성 등, 예: tools/handlers.ts)이 있어, src/ 아래 .ts·.tsx를 esbuild(vite가 함께 설치)로 바꿔 불러온다.
// 또 요청 준비·연결이 쓰는 몇 함수를 시험마다 바꿀 수 있게 감싼다: 감싼 함수는 globalThis.__agentStubs["<모듈>.<이름>"]가
// 있으면 그것을, 없으면 실제 함수를 부른다(나머지 export는 실제 모듈 그대로).
//   import "./helpers/agentLoader.mjs";
//   const { ChatAgent } = await import("../src/background/agent/chatAgent.ts");
// 정적 import는 훅 등록보다 먼저 해석되므로 src/ 모듈은 반드시 동적 import로 부른다. 같은 파일에서 tsLoader.mjs와 함께 쓰지 않는다.
// 제품 코드에는 아무것도 더하지 않는다(시험 훅 없음 — #263 계획 7절 Q2).
import { register } from "node:module";

const SRC = new URL("../../src/", import.meta.url).href;
const ESBUILD = new URL("../../package.json", import.meta.url).href;
// 감쌀 함수: src/ 기준 경로 → 이름. 열쇠는 "<경로에서 확장자를 뺀 마지막 이름>.<함수>"(예: storage.getSettings).
const WRAP = {
  "background/storage.ts": ["getSettings"],
  "background/savedPagesStore.ts": ["candidatesMessage"],
  "background/loginSecrets.ts": ["maskMessagesForModel", "maskSyncMessages"],
  "background/debug.ts": ["debugLog"],
  "lib/providers/index.ts": ["providerAdapter", "providerTimeout"],
  "lib/settings.ts": ["targetKey"],
  // 특수 도구·손 넘기기(#263 단계 5): 페이지 표시·감시·팝업 감시·탭 확인·반복 작업 저장.
  "background/handoff.ts": ["showHandoff", "watchHandoff", "endHandoff"],
  "background/popups.ts": ["watchNewTabs"],
  "background/tools/handlers.ts": ["resolveTurnTab"],
  "background/repeatTasks.ts": ["registerRepeatTask"],
};

const hooks = `
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { transformSync } = createRequire(${JSON.stringify(ESBUILD)})("esbuild");
const SRC = ${JSON.stringify(SRC)};
const WRAP = ${JSON.stringify(WRAP)};
const EXTS = [".ts", ".tsx", "/index.ts"];
export async function resolve(spec, ctx, next) {
  let url = null;
  if (spec.startsWith("@/")) url = new URL(spec.slice(2), SRC).href;
  else if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith(SRC)) url = new URL(spec, ctx.parentURL).href;
  if (url && !/\\.(ts|tsx|mjs|js|json)(\\?real)?$/.test(url)) {
    for (const e of EXTS) if (existsSync(fileURLToPath(url + e))) { url = url + e; break; }
  }
  return next(url ?? spec, ctx);
}
export async function load(url, ctx, next) {
  if (!url.startsWith(SRC)) return next(url, ctx);
  const real = url.endsWith("?real");
  const file = real ? url.slice(0, -5) : url;
  if (!/\\.tsx?$/.test(file)) return next(url, ctx);
  const rel = file.slice(SRC.length);
  if (!real && WRAP[rel]) {
    const key = rel.split("/").pop().replace(/\\.tsx?$/, "").replace(/^index$/, rel.split("/").slice(-2, -1)[0]);
    const r = JSON.stringify(file + "?real");
    const fns = WRAP[rel].map((n) => "export function " + n + "(...a) { const f = globalThis.__agentStubs?.[" + JSON.stringify(key + "." + n) + "]; return f ? f(...a) : real." + n + "(...a); }").join("\\n");
    return { format: "module", source: "import * as real from " + r + ";\\nexport * from " + r + ";\\n" + fns, shortCircuit: true };
  }
  const out = transformSync(readFileSync(fileURLToPath(file), "utf8"), { loader: file.endsWith("x") ? "tsx" : "ts", format: "esm", target: "es2022", jsx: "automatic", sourcefile: fileURLToPath(file) });
  return { format: "module", source: out.code, shortCircuit: true };
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

// 어떤 속성이든 부를 수 있고(빈 객체로 풀리는 Promise) 더 들어갈 수 있는 chrome 대역. 불러올 때 리스너를 거는 모듈이 많아
// 실제 확장 API 없이도 불러오게만 한다(시험이 쓰는 동작은 위 WRAP으로 바꾼다).
function deep() {
  return new Proxy(function () {}, {
    get: (_t, k) => (k === "then" ? undefined : deep()),
    apply: () => Promise.resolve({}),
  });
}
globalThis.chrome ??= deep();
