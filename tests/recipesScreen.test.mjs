// 설정 화면의 읽기 방법 보기·지우기(#297 1단계): background/readRecipes.ts의 listRecipes·deleteRecipes와 삭제 표식.
// chrome.storage 대역을 두고 확장자 없는 import를 잇는 해석 훅(helpers/tsLoader.mjs)으로 불러온다.
// 서비스 워커를 막 깨운 상태(가림 목록 캐시 없음)를 보려고 가림 목록을 읽는 시험을 다른 시험보다 먼저 둔다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const local = new Map();
const session = new Map();
const getHooks = new Map(); // key -> async () => void (throw하면 get 실패)
// 읽기 레시피 저장소에 쓴 선택자 목록(쓸 때마다). 지운 항목이 잠깐이라도 다시 쓰였는지 본다.
const writes = [];
function area(store) {
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
        if (k === "readRecipesV2") writes.push(v.map((r) => r.args.selector));
      }
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}
globalThis.chrome = {
  storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
  runtime: { id: "test" },
};

const readRecipes = await import("../src/background/readRecipes.ts");
const actionLog = await import("../src/background/actionLog.ts");
const { recipeKey } = await import("../src/lib/readRecipe.ts");
const { pageKeyId } = await import("../src/lib/actionLog.ts");

const KEY = "readRecipesV2";
const ACTION_LOG_KEY = "actionLog";
const PAGE = { origin: "https://ex.test", pattern: "/list", skeleton: "s1" };
const PAGE_ID = pageKeyId(PAGE);
const keyOf = (selector, page = PAGE_ID) => recipeKey(page, "query_dom", { selector });
const stored = (selector, page = PAGE_ID) => ({ page, tool: "query_dom", args: { selector }, successes: 1, failures: 0, lastUsed: Date.now() });
const everWrote = (sel) => writes.some((w) => w.includes(sel));
const selectors = () => (local.get(KEY) ?? []).map((r) => r.args.selector).sort();

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
const ticks = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

async function fresh(recipes = []) {
  await actionLog.clearActionLog();
  await ticks();
  local.clear();
  getHooks.clear();
  writes.length = 0;
  if (recipes.length) local.set(KEY, recipes);
}

// 앞 쓰기(동작 기록)를 붙잡아 큐를 막는다. 돌려준 함수로 푼다.
function holdQueue() {
  const gate = deferred();
  getHooks.set(ACTION_LOG_KEY, () => gate.promise);
  const turn = {};
  actionLog.notePendingAction(turn, "c1", "click_element", PAGE, [{ name: "저장", role: "button" }]);
  const done = actionLog.finishAction(turn, "c1", "ok");
  return async () => {
    gate.resolve();
    await done;
    await ticks();
  };
}

test("워커를 막 깨운 상태: 가림 목록 읽기가 실패하면 항목 없이 오류", async () => {
  await fresh([stored("li.a")]);
  session.set("loginSecrets", { t1: ["s3cretvalue"] });
  getHooks.set("loginSecrets", async () => {
    throw new Error("session 읽기 실패");
  });
  await assert.rejects(readRecipes.listRecipes(), /session 읽기 실패/);
});

test("워커를 막 깨운 상태(캐시 없음)에서도 자동 로그인 값이 보이는 항목은 목록에서 뺀다", async () => {
  await fresh([stored("li.a"), stored("li.s3cretvalue"), stored("li.b", "https://ex.test/u/s3cretvalue@s1")]);
  session.set("loginSecrets", { t1: ["s3cretvalue"] });
  const { sites } = await readRecipes.listRecipes();
  assert.equal(sites.length, 1);
  assert.deepEqual(sites[0].reads.map((r) => r.args.selector), ["li.a"]);
  assert.equal(JSON.stringify(sites).includes("s3cretvalue"), false);
  session.delete("loginSecrets");
});

test("listRecipes: 출처별 묶음, key로 지우면 그 항목만 사라지고 새 개수를 돌려준다", async () => {
  await fresh([stored("li.a"), stored("li.b"), stored("p", "https://other.test/x@s9")]);
  const { sites } = await readRecipes.listRecipes();
  assert.deepEqual(sites.map((s) => s.origin).sort(), ["https://ex.test", "https://other.test"]);
  const ex = sites.find((s) => s.origin === "https://ex.test");
  assert.equal(ex.reads.length, 2);
  const target = ex.reads.find((r) => r.args.selector === "li.a");
  assert.equal(target.key, keyOf("li.a"));
  assert.equal(await readRecipes.deleteRecipes([target.key, "read:없는 key"]), 2);
  assert.deepEqual(selectors(), ["li.b", "p"]);
  // 사이트 모두 지우기: 화면이 가진 그 사이트의 key 전부.
  assert.equal(await readRecipes.deleteRecipes(ex.reads.map((r) => r.key)), 1);
  assert.deepEqual(selectors(), ["p"]);
  assert.equal(await readRecipes.deleteRecipes([keyOf("p", "https://other.test/x@s9")]), 0);
  assert.equal(local.has(KEY), false, "다 지우면 저장소 키도 지움");
});

test("listRecipes는 쓰기 큐 안에서 읽는다: 앞 쓰기가 끝난 뒤의 목록", async () => {
  await fresh([stored("li.a")]);
  const release = holdQueue();
  const listed = readRecipes.listRecipes();
  const del = readRecipes.deleteRecipes([keyOf("li.a")]);
  await ticks(5);
  await release();
  await del;
  const { sites } = await listed;
  assert.deepEqual(sites[0].reads.map((r) => r.args.selector), ["li.a"], "목록 요청 때(삭제 전)의 저장 목록");
  assert.deepEqual(selectors(), []);
});

test("대기 관찰에서 빼기: 턴이 끝나기 전에 지우면 커밋해도 되살아나지 않고 다른 관찰은 남는다", async () => {
  await fresh([stored("li.a")]);
  const turn = {};
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.a" }, true);
  readRecipes.noteRead(turn, { ...PAGE, pattern: "/other" }, "query_dom", { selector: "li.b" }, true);
  const del = readRecipes.deleteRecipes([keyOf("li.a")]);
  readRecipes.commitReads(turn, true);
  await del;
  await ticks();
  assert.deepEqual(selectors(), ["li.b"]);
});

test("큐 경합: 앞 쓰기 지연 → 삭제 요청 → 턴 커밋 → 지연 해제", async () => {
  await fresh([stored("li.a")]);
  const turn = {};
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.a" }, true);
  const release = holdQueue();
  const del = readRecipes.deleteRecipes([keyOf("li.a")]);
  readRecipes.commitReads(turn, true);
  await release();
  await del;
  await ticks();
  assert.deepEqual(selectors(), []);
  assert.equal(everWrote("li.a"), false, "지운 항목을 다시 쓰지 않음");
});

test("큐 경합: 턴 커밋 → 삭제 요청(커밋이 관찰을 이미 꺼내 감) → 지연 해제", async () => {
  await fresh([stored("li.a")]);
  const turn = {};
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.a" }, true);
  const release = holdQueue();
  readRecipes.commitReads(turn, true);
  const del = readRecipes.deleteRecipes([keyOf("li.a")]);
  await release();
  await del;
  await ticks();
  assert.deepEqual(selectors(), []);
  assert.deepEqual(writes, [], "커밋 작업이 표식을 보고 쓰지 않음(삭제 작업만 저장소를 비움)");
});

test("삭제 표식: 커밋 작업이 저장소를 읽는 사이(반영 직전) 온 삭제도 관찰을 버리게 한다", async () => {
  await fresh();
  const turn = {};
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.a" }, true);
  const gate = deferred();
  const reached = deferred();
  getHooks.set(KEY, async () => {
    reached.resolve();
    await gate.promise;
  });
  readRecipes.commitReads(turn, true);
  await reached.promise; // 커밋 작업이 저장소 읽기에 들어감(관찰은 이미 Map에서 꺼냄)
  const del = readRecipes.deleteRecipes([keyOf("li.a")]);
  gate.resolve();
  await del;
  await ticks();
  assert.equal(local.has(KEY), false);
  assert.deepEqual(writes, [], "커밋이 표식을 보고 쓰지 않음(그 뒤 삭제 작업도 지울 것이 없음)");
});

test("삭제 순번 경계: 지운 직후의 새 관찰은 정상으로 쌓인다", async () => {
  await fresh([stored("li.a")]);
  await readRecipes.deleteRecipes([keyOf("li.a")]);
  const turn = {};
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.a" }, true);
  readRecipes.commitReads(turn, true);
  await ticks();
  assert.deepEqual(selectors(), ["li.a"]);
});

test("삭제 표식 400개 초과: 가장 오래된 표식을 버리며 그보다 앞선 관찰은 key와 무관하게 버린다", async () => {
  await fresh();
  const old = {};
  readRecipes.noteRead(old, PAGE, "query_dom", { selector: "li.keep" }, true); // 표식보다 앞선 관찰(지우지 않은 key)
  await readRecipes.deleteRecipes([keyOf("li.first")]);
  const mid = {};
  readRecipes.noteRead(mid, PAGE, "query_dom", { selector: "li.mid" }, true); // 가장 오래된 표식보다 뒤의 관찰
  const many = Array.from({ length: readRecipes.MAX_DELETE_MARKS }, (_, i) => keyOf(`li.x${i}`));
  await readRecipes.deleteRecipes(many);
  readRecipes.commitReads(old, true);
  readRecipes.commitReads(mid, true);
  await ticks();
  assert.deepEqual(selectors(), ["li.mid"], "오래된 관찰은 버리고, 버린 표식 뒤의 관찰은 남음");
});

test("전체 지우기: 이미 꺼내 간 커밋도 반영하지 못하고, 그 뒤 새 관찰은 쌓인다", async () => {
  await fresh();
  const turn = {};
  readRecipes.noteRead(turn, PAGE, "query_dom", { selector: "li.a" }, true);
  const release = holdQueue();
  readRecipes.commitReads(turn, true);
  const cleared = actionLog.clearActionLog();
  await release();
  await cleared;
  await ticks();
  assert.equal(local.has(KEY), false);
  assert.deepEqual(writes, [], "꺼내 간 커밋도 전역 순번을 보고 쓰지 않음");
  const next = {};
  readRecipes.noteRead(next, PAGE, "query_dom", { selector: "li.b" }, true);
  readRecipes.commitReads(next, true);
  await ticks();
  assert.deepEqual(selectors(), ["li.b"]);
});
