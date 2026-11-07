// 동작 기록(background/actionLog.ts)과 읽기 레시피(background/readRecipes.ts)의 공유 쓰기 큐·대기 상태·턴 키(#257).
// 두 모듈은 확장자 없는 import와 `@/` 별칭을 쓰므로, 이 파일 안에서 resolve 훅을 걸고 chrome.storage 대역을 둔 뒤 불러온다.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const SRC = new URL("../src/", import.meta.url).href;
const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = ${JSON.stringify(SRC)};
const EXTS = [".ts", ".tsx", "/index.ts"];
export async function resolve(spec, ctx, next) {
  let url = null;
  if (spec.startsWith("@/")) url = new URL(spec.slice(2), SRC).href;
  else if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith(SRC)) url = new URL(spec, ctx.parentURL).href;
  if (url && !/\\.(ts|tsx|mjs|js|json)$/.test(url)) {
    for (const e of EXTS) if (existsSync(fileURLToPath(url + e))) { url = url + e; break; }
  }
  return next(url ?? spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

// chrome.storage 대역: 메모리 저장, 쓰기 기록, 키별 get 지연·실패 주입.
const local = new Map();
const session = new Map();
const ops = [];
const getHooks = new Map(); // key -> async () => void (throw하면 get 실패)
function area(store, name) {
  return {
    async get(keys) {
      const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        const h = getHooks.get(k);
        if (h) {
          getHooks.delete(k);
          await h();
        }
      }
      const out = {};
      for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) {
        store.set(k, structuredClone(v));
        ops.push(`${name}:set:${k}`);
      }
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
        ops.push(`${name}:remove:${k}`);
      }
    },
  };
}
globalThis.chrome = {
  storage: {
    local: area(local, "local"),
    session: area(session, "session"),
    onChanged: { addListener() {} },
  },
  runtime: { id: "test" },
};

const actionLog = await import("../src/background/actionLog.ts");
const readRecipes = await import("../src/background/readRecipes.ts");
const { turnKey } = await import("../src/background/actionLog.ts");

const ACTION_LOG_KEY = "actionLog";
const READ_RECIPES_KEY = "readRecipesV2";
const PAGE = { origin: "https://ex.test", pattern: "/list", skeleton: "s1" };
const TARGET = { name: "저장", role: "button" };

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

async function fresh() {
  await actionLog.clearActionLog();
  local.clear();
  ops.length = 0;
  getHooks.clear();
}

function logAction(turn, callId) {
  actionLog.notePendingAction(turn, callId, "click_element", PAGE, [TARGET]);
  return actionLog.finishAction(turn, callId, "ok");
}

function readOnce(turn) {
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.price" }, true);
  readRecipes.commitReads(turn, true);
}

test("(a) 동작 기록과 읽기 레시피는 같은 큐를 쓴다: 앞 기록이 끝나야 레시피를 쓴다", async () => {
  await fresh();
  const gate = deferred();
  getHooks.set(ACTION_LOG_KEY, () => gate.promise);
  const done = logAction({}, "c1");
  readOnce({});
  await ticks();
  const writtenEarly = local.has(READ_RECIPES_KEY);
  gate.resolve(); // 실패해도 큐를 막아 두지 않게 먼저 푼다
  assert.equal(writtenEarly, false, "앞 동작 기록이 막혀 있는 동안 레시피를 쓰지 않음");
  await done;
  await ticks();
  assert.deepEqual(
    ops.filter((o) => o.startsWith("local:set")),
    [`local:set:${ACTION_LOG_KEY}`, `local:set:${READ_RECIPES_KEY}`],
  );
});

test("(a) 앞 작업이 실패해도 큐의 다음 작업은 실행된다", async () => {
  await fresh();
  getHooks.set(ACTION_LOG_KEY, async () => {
    throw new Error("읽기 실패");
  });
  const done = logAction({}, "c1");
  readOnce({});
  await done; // 기록 실패는 삼킨다(도구 결과를 바꾸지 않게)
  await ticks();
  assert.equal(local.has(ACTION_LOG_KEY), false);
  assert.ok(Array.isArray(local.get(READ_RECIPES_KEY)) && local.get(READ_RECIPES_KEY).length > 0, "실패 뒤 레시피 저장");
  const counts = await actionLog.storedCounts();
  assert.equal(counts.log, 0);
  assert.equal(counts.recipes, local.get(READ_RECIPES_KEY).length);
});

test("(b) 지연된 저장 뒤에 부른 clearActionLog가 마지막에 적용된다", async () => {
  await fresh();
  const gate = deferred();
  getHooks.set(ACTION_LOG_KEY, () => gate.promise);
  const done = logAction({}, "c1");
  readOnce({});
  const cleared = actionLog.clearActionLog();
  await ticks();
  gate.resolve();
  await Promise.all([done, cleared]);
  await ticks();
  assert.equal(local.has(ACTION_LOG_KEY), false, "동작 기록이 남지 않음");
  assert.equal(local.has(READ_RECIPES_KEY), false, "읽기 레시피가 남지 않음");
  assert.equal(ops.at(-1), "local:remove:readRecipes", "마지막 작업은 지우기");
});

test("(c) 지울 때 대기 상태를 동기적으로 비워 늦은 finishAction·commitReads가 옛 기록을 되살리지 않는다", async () => {
  await fresh();
  const turn = {};
  actionLog.notePendingAction(turn, "c1", "click_element", PAGE, [TARGET]);
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.price" }, true);
  const cleared = actionLog.clearActionLog();
  const late = actionLog.finishAction(turn, "c1", "ok");
  readRecipes.commitReads(turn, true);
  await Promise.all([cleared, late]);
  await ticks();
  assert.equal(local.has(ACTION_LOG_KEY), false);
  assert.equal(local.has(READ_RECIPES_KEY), false);
  assert.deepEqual(ops.filter((o) => o.includes(":set:")), []);
});

test("(d) 턴 키: 같은 TurnTab이면 같고, 다른 턴의 같은 callId는 서로 겹치지 않는다", async () => {
  await fresh();
  const a = {};
  const b = {};
  assert.equal(turnKey(a), turnKey(a));
  assert.notEqual(turnKey(a), turnKey(b));
  actionLog.notePendingAction(a, "c1", "click_element", PAGE, [{ name: "가", role: "button" }]);
  actionLog.notePendingAction(b, "c1", "click_element", PAGE, [{ name: "나", role: "button" }]);
  await actionLog.finishAction(a, "c1", "ok");
  await actionLog.finishAction(b, "c1", "ok");
  const entries = local.get(ACTION_LOG_KEY);
  assert.equal(entries.length, 2, "두 턴의 기록이 모두 남음");
  // 같은 턴의 관찰은 한 묶음: a에 두 번 기록하면 b와 섞이지 않고 a로 커밋된다.
  readRecipes.noteRead(a, PAGE, "query_dom", { selector: "li.a" }, true);
  readRecipes.noteRead(b, PAGE, "query_dom", { selector: "li.b" }, true);
  readRecipes.commitReads(b, false); // b는 실패로 끝남 → 버림
  readRecipes.commitReads(a, true);
  await ticks();
  const recipes = JSON.stringify(local.get(READ_RECIPES_KEY) ?? []);
  assert.ok(recipes.includes("li.a"), "a의 관찰 저장");
  assert.ok(!recipes.includes("li.b"), "b의 관찰은 버림");
});
