// 경로 레시피(#297 2단계)의 턴 기록기·리스너(src/background/pathRecipes.ts)를 chrome 대역으로 시험한다.
// 실제 Chrome으로 만들 수 없는 이벤트 지연·순서 뒤바뀜(webNavigation·webRequest 사이)은 여기서 본다.
// 가림 목록 캐시는 처음 읽을 때 채워지므로, 읽기 실패 시험을 맨 앞에 둔다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/tsLoader.mjs";

const local = new Map();
const session = new Map();
let sessionFail = false;
// key -> async () => void: 그 key를 읽을 때 한 번 기다린다(저장소 읽기 지연).
const getHooks = new Map();
function area(store, failing) {
  return {
    async get(keys) {
      if (failing?.()) throw new Error("session read failed");
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
      for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}
function ev() {
  const ls = [];
  return { addListener: (f) => ls.push(f), fire: (d) => ls.forEach((f) => f(d)) };
}
const tabs = new Map();
const W = { onCommitted: ev(), onHistoryStateUpdated: ev(), onReferenceFragmentUpdated: ev(), onErrorOccurred: ev() };
const R = { onBeforeRequest: ev(), onBeforeRedirect: ev(), onCompleted: ev(), onErrorOccurred: ev() };
globalThis.chrome = {
  storage: { local: area(local), session: area(session, () => sessionFail), onChanged: { addListener() {} } },
  runtime: { id: "test" },
  tabs: {
    async get(id) {
      const t = tabs.get(id);
      if (!t) throw new Error("no tab");
      return { id, url: t.url, incognito: !!t.incognito, status: "complete" };
    },
  },
  webNavigation: { ...W, async getFrame({ tabId }) { return { documentId: tabs.get(tabId)?.doc }; } },
  webRequest: R,
};

const P = await import("../src/background/pathRecipes.ts");
const actionLog = await import("../src/background/actionLog.ts");
const { invalidateSettingsCache } = await import("../src/background/storage.ts");
const { rememberSecrets } = await import("../src/background/loginSecrets.ts");

const KEY = "pathRecipes";
const O = "https://ex.test";
const O2 = "https://other.test";
const stored = () => (local.get(KEY) ?? []).map((r) => r.steps.join(" "));
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let docN = 0;
let reqN = 0;
const newDoc = () => `doc${++docN}`;

function openTab(id, url, extra = {}) {
  tabs.set(id, { url, doc: newDoc(), ...extra });
  return id;
}

// 요청 단계를 하나씩 내는 도구. chain: 첫 주소 → 리다이렉트 … → 최종 주소.
function request(tabId, chain) {
  const requestId = `r${++reqN}`;
  return {
    requestId,
    open: () => R.onBeforeRequest.fire({ tabId, requestId, url: chain[0], type: "main_frame" }),
    redirect: (i) => R.onBeforeRedirect.fire({ tabId, requestId, url: chain[i], redirectUrl: chain[i + 1], type: "main_frame" }),
    redirects() {
      for (let i = 0; i + 1 < chain.length; i++) this.redirect(i);
    },
    complete: () => R.onCompleted.fire({ tabId, requestId, url: chain[chain.length - 1], type: "main_frame" }),
    fail: () => R.onErrorOccurred.fire({ tabId, requestId, url: chain[chain.length - 1], type: "main_frame" }),
  };
}
function commit(tabId, url, doc = newDoc()) {
  const t = tabs.get(tabId);
  t.url = url;
  t.doc = doc;
  W.onCommitted.fire({ tabId, frameId: 0, url, documentId: doc });
  return doc;
}
// 보통 이동: 요청 열림 → 리다이렉트 → 확정 → 요청 닫힘.
function go(tabId, url, { redirects = [] } = {}) {
  const r = request(tabId, [...redirects, url]);
  r.open();
  r.redirects();
  const doc = commit(tabId, url);
  r.complete();
  return doc;
}
function spa(tabId, url) {
  tabs.get(tabId).url = url;
  W.onHistoryStateUpdated.fire({ tabId, frameId: 0, url });
}

const loaded = async (tabId) => {
  const t = tabs.get(tabId);
  return t ? { documentId: t.doc, url: t.url } : null;
};
const opts = (extra = {}) => ({ ok: true, isLive: () => true, loadedPage: loaded, matchWaitMs: 150, ...extra });

async function fresh() {
  await actionLog.clearActionLog();
  await ticks();
  local.clear();
  tabs.clear();
  getHooks.clear();
}

// 한 턴: 시작 → body(turnTab) → 커밋.
async function turnOn(tabId, body, o = {}) {
  const turnTab = { tabId, internal: false, ...(o.turnTab ?? {}) };
  P.beginPath(turnTab, tabs.get(tabId).url);
  await body?.(turnTab);
  await P.commitPath(turnTab, opts(o.opts));
  await ticks();
  return turnTab;
}

test("가림 목록을 읽지 못하면 저장하지 않는다(워커를 막 깨운 상태)", async () => {
  await fresh();
  openTab(1, `${O}/`);
  sessionFail = true;
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    go(1, `${O}/help/notice/list`);
  });
  sessionFail = false;
  assert.deepEqual(stored(), []);
  assert.equal(P.activePathTurns(), 0, "구독이 없어짐");
});

test("같은 출처 안의 이동을 접어 저장하고, 다시 가면 쓴 횟수를 올린다", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    go(1, `${O}/help/dead`);
    go(1, `${O}/help`);
    go(1, `${O}/help/notice/list`);
  });
  assert.deepEqual(stored(), ["/ /help /help/notice/list"]);
  tabs.get(1).url = `${O}/`;
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    go(1, `${O}/help/notice/list`);
  });
  assert.equal(local.get(KEY)[0].uses, 2);
});

test("SPA(pushState) 이동도 걸음으로 잡힌다(요청 대응은 요구하지 않음)", async () => {
  await fresh();
  openTab(1, `${O}/app`);
  await turnOn(1, async () => {
    spa(1, `${O}/app/inbox`);
    spa(1, `${O}/app/inbox/list`);
  });
  assert.deepEqual(stored(), ["/app /app/inbox /app/inbox/list"]);
});

test("확정된 문서 이동에 대응하는 닫힌 요청이 없으면 저장하지 않는다", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    commit(1, `${O}/help/notice/list`);
  });
  assert.deepEqual(stored(), []);
});

test("요청이 제때(대기 한도 안에) 닫히지 않으면 저장하지 않는다", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    const r = request(1, [`${O}/help`]);
    r.open();
    commit(1, `${O}/help`);
  });
  assert.deepEqual(stored(), []);
});

test("늦게 닫히는 요청도 대기 한도 안이면 저장한다(확정이 요청보다 먼저 와도)", async () => {
  await fresh();
  openTab(1, `${O}/`);
  const turnTab = { tabId: 1, internal: false };
  P.beginPath(turnTab, `${O}/`);
  const r = request(1, [`${O}/help`]);
  commit(1, `${O}/help`);
  r.open();
  const done = P.commitPath(turnTab, opts({ matchWaitMs: 1000 }));
  await new Promise((res) => setTimeout(res, 50));
  r.complete();
  await done;
  await ticks();
  assert.deepEqual(stored(), ["/ /help"]);
});

test("A/start → A/hop → B/relay → A/end: 안전한 첫 리다이렉트만 먼저 오고 나머지가 늦게 와도 제외된다", async () => {
  await fresh();
  openTab(1, `${O}/start`);
  const turnTab = { tabId: 1, internal: false };
  P.beginPath(turnTab, `${O}/start`);
  const r = request(1, [`${O}/go`, `${O}/hop`, `${O2}/relay`, `${O}/end`]);
  r.open();
  r.redirect(0);
  commit(1, `${O}/end`);
  const done = P.commitPath(turnTab, opts({ matchWaitMs: 1000 }));
  await new Promise((res) => setTimeout(res, 50));
  r.redirect(1);
  r.redirect(2);
  r.complete();
  await done;
  await ticks();
  assert.deepEqual(stored(), []);
});

test("출처 왕복 리다이렉트(A→B→A)와 다른 출처 이동은 제외", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`, { redirects: [`${O}/out`, `${O2}/sso`] });
  });
  assert.deepEqual(stored(), []);
  tabs.get(1).url = `${O}/`;
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    go(1, `${O2}/help`);
  });
  assert.deepEqual(stored(), []);
});

test("주문 주소·삭제 경로·40걸음 초과·Chrome 오류는 제외(접기 전 원본 검사)", async () => {
  await fresh();
  for (const bad of [`${O}/mypage/order/list`, `${O}/item/delete`]) {
    openTab(1, `${O}/`);
    await turnOn(1, async () => {
      go(1, bad);
      go(1, `${O}/`);
      go(1, `${O}/help`);
    });
    assert.deepEqual(stored(), [], bad);
  }
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    for (let i = 0; i < 41; i++) spa(1, `${O}/p/${i % 2 ? "a" : "b"}`);
    spa(1, `${O}/help`);
  });
  assert.deepEqual(stored(), [], "40걸음 초과");
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    W.onErrorOccurred.fire({ tabId: 1, frameId: 0, url: `${O}/x`, error: "net::ERR_FAILED" });
  });
  assert.deepEqual(stored(), [], "오류 화면");
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    const r = request(1, [`${O}/help`]);
    r.open();
    r.fail();
  });
  assert.deepEqual(stored(), [], "요청 오류");
});

test("v6: 확인된 D1 → 다른 페이지 → 같은 주소의 새 문서 D3(R3 전체 지연)는 저장 안 함, 늦은 R3의 다른 출처 리다이렉트로도 되살지 않음", async () => {
  await fresh();
  openTab(1, `${O}/`);
  const turnTab = { tabId: 1, internal: false };
  P.beginPath(turnTab, `${O}/`);
  go(1, `${O}/a`);
  go(1, `${O}/b`);
  // forward_back으로 확정됐지만 새 문서(documentId가 다름).
  commit(1, `${O}/a`);
  await P.commitPath(turnTab, opts());
  const r3 = request(1, [`${O}/a`, `${O2}/x`, `${O}/a`]);
  r3.open();
  r3.redirects();
  r3.complete();
  await ticks();
  assert.deepEqual(stored(), []);
});

test("v6: 같은 documentId의 복원은 요청 없이 통과, documentId가 없는 확정은 면제 안 됨", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    const d1 = go(1, `${O}/a`);
    go(1, `${O}/b`);
    commit(1, `${O}/a`, d1);
    go(1, `${O}/c`);
  });
  assert.deepEqual(stored(), ["/ /a /c"]);
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/a`);
    go(1, `${O}/b`);
    tabs.get(1).url = `${O}/a`;
    W.onCommitted.fire({ tabId: 1, frameId: 0, url: `${O}/a` });
  });
  assert.deepEqual(stored(), []);
});

test("v5: 같은 주소의 D1·D2가 확정되고 R1만 닫히면(R2 지연) 저장 안 함, 남는 닫힌 요청이 있어도 저장 안 함", async () => {
  await fresh();
  openTab(1, `${O}/`);
  const turnTab = { tabId: 1, internal: false };
  P.beginPath(turnTab, `${O}/`);
  go(1, `${O}/a`);
  commit(1, `${O}/a`);
  await P.commitPath(turnTab, opts());
  const r2 = request(1, [`${O}/a`, `${O2}/x`, `${O}/a`]);
  r2.open();
  r2.redirects();
  r2.complete();
  await ticks();
  assert.deepEqual(stored(), []);
  // 확정 없이 닫힌 요청(내려받기·204 등)이 남으면 대응이 모호하다.
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    const extra = request(1, [`${O}/file`]);
    extra.open();
    extra.complete();
  });
  assert.deepEqual(stored(), []);
});

test("tabId -1(확장 자신의 fetch) 요청은 무시하고, 구독을 없앤 뒤의 이벤트도 무시한다", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    R.onBeforeRequest.fire({ tabId: -1, requestId: "x1", url: `${O}/r`, type: "main_frame" });
    R.onBeforeRedirect.fire({ tabId: -1, requestId: "x1", url: `${O}/r`, redirectUrl: `${O2}/r`, type: "main_frame" });
    R.onErrorOccurred.fire({ tabId: -1, requestId: "x1", url: `${O2}/r`, type: "main_frame" });
  });
  assert.deepEqual(stored(), ["/ /help"]);
  // 끝난 턴의 탭에서 일어난 이동은 다음 턴에 섞이지 않는다.
  await fresh();
  openTab(1, `${O}/`);
  const t = { tabId: 1, internal: false };
  P.beginPath(t, `${O}/`);
  P.abortPath(t);
  go(1, `${O2}/x`);
  W.onErrorOccurred.fire({ tabId: 1, frameId: 0, url: `${O}/x` });
  assert.equal(P.activePathTurns(), 0);
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  assert.deepEqual(stored(), ["/ /help"]);
});

test("v5 턴 겹침: 다른 탭이어도 두 턴이 잠깐이라도 겹치면 둘 다 저장 안 함, 이어서 돌면 각각 저장", async () => {
  await fresh();
  openTab(1, `${O}/`);
  openTab(2, `${O2}/`);
  const a = { tabId: 1, internal: false };
  const b = { tabId: 2, internal: false };
  // (1) B 먼저 시작, A 시작, B가 먼저 끝남.
  P.beginPath(b, `${O2}/`);
  P.beginPath(a, `${O}/`);
  go(1, `${O}/help`);
  go(2, `${O2}/help`);
  await P.commitPath(b, opts());
  await P.commitPath(a, opts());
  await ticks();
  assert.deepEqual(stored(), []);
  // (2) 시작 순서를 바꿈 + 한 턴이 끝난 뒤에도 다른 탭의 턴은 계속 관찰됨(그래도 겹쳤으니 저장 안 함).
  openTab(1, `${O}/`);
  openTab(2, `${O2}/`);
  P.beginPath(a, `${O}/`);
  P.beginPath(b, `${O2}/`);
  go(1, `${O}/help`);
  await P.commitPath(a, opts());
  go(2, `${O2}/help`);
  await P.commitPath(b, opts());
  await ticks();
  assert.deepEqual(stored(), []);
  // (4) 한 턴의 최종 로딩 대기 중 다른 턴이 시작.
  openTab(1, `${O}/`);
  openTab(2, `${O2}/`);
  P.beginPath(a, `${O}/`);
  go(1, `${O}/help`);
  let release;
  const gate = new Promise((r) => (release = r));
  const done = P.commitPath(a, opts({ loadedPage: async (id) => (await gate, loaded(id)) }));
  await ticks();
  P.beginPath(b, `${O2}/`);
  go(2, `${O2}/help`);
  release();
  await done;
  await P.commitPath(b, opts());
  await ticks();
  assert.deepEqual(stored(), []);
  // 겹치지 않고 이어서 돈 두 턴은 각각 저장된다(경로가 섞이지 않음).
  openTab(1, `${O}/`);
  openTab(2, `${O2}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  await turnOn(2, async () => go(2, `${O2}/faq`));
  assert.deepEqual(local.get(KEY).map((r) => `${r.origin} ${r.steps.join(" ")}`).sort(), [`${O} / /help`, `${O2} / /faq`]);
});

test("v5 턴 겹침: 배울 수 없는 턴(오류 턴 탭·내부 페이지)과 겹쳐도 제외", async () => {
  await fresh();
  openTab(1, `${O}/`);
  const err = { error: "x" };
  P.beginPath(err, null);
  await turnOn(1, async () => go(1, `${O}/help`));
  P.abortPath(err);
  assert.deepEqual(stored(), []);
});

test("제외 표시(그림자 판정·sign_in·팝업)는 되살아나지 않고, 물려받은 팝업으로 시작한 턴도 제외", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async (t) => {
    P.markPathRisk(t, "shadow_card");
    go(1, `${O}/help`);
  });
  assert.deepEqual(stored(), []);
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`), { turnTab: { popups: [{ tabId: 9, windowId: 1 }] } });
  assert.deepEqual(stored(), []);
});

test("끝 확인: 다 뜬 문서·주소가 마지막 확정과 다르거나 제때 안 뜨면 저장 안 함, 중단·외부 본문 보호도 저장 안 함", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`), { opts: { loadedPage: async () => ({ documentId: "other", url: `${O}/help` }) } });
  assert.deepEqual(stored(), []);
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`), { opts: { loadedPage: async () => null } });
  assert.deepEqual(stored(), []);
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`), { opts: { ok: false } });
  assert.deepEqual(stored(), []);
  // 기다리는 사이 중단·새 요청.
  openTab(1, `${O}/`);
  let live = true;
  await turnOn(1, async () => go(1, `${O}/help`), {
    opts: { isLive: () => live, loadedPage: async (id) => ((live = false), loaded(id)) },
  });
  assert.deepEqual(stored(), []);
  // 시크릿 창.
  openTab(1, `${O}/`, { incognito: true });
  await turnOn(1, async () => go(1, `${O}/help`));
  assert.deepEqual(stored(), []);
  // 기록 끔.
  local.set("settings", { actionLogEnabled: false });
  invalidateSettingsCache();
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  local.delete("settings");
  invalidateSettingsCache();
  assert.deepEqual(stored(), []);
});

test("삭제 순번: 턴 도중·커밋 대기 중 그 출처의 경로를 지우면 되살아나지 않고, 지운 뒤 새 턴은 저장", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  const key = `path:${O} ${local.get(KEY)[0].id}`;
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    await P.deletePaths([key]);
  });
  assert.deepEqual(stored(), []);
  // 커밋이 다 뜨기를 기다리는 사이 지움.
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  const key2 = `path:${O} ${local.get(KEY)[0].id}`;
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help/faq`), {
    opts: { loadedPage: async (id) => (await P.deletePaths([key2]), loaded(id)) },
  });
  assert.deepEqual(stored(), []);
  // 다른 출처를 지운 것은 이 턴에 영향 없음.
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    await P.deletePaths([`path:${O2} zz`]);
  });
  assert.deepEqual(stored(), ["/ /help"]);
  // 전체 지우기 도중의 턴.
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/faq`);
    await actionLog.clearActionLog();
  });
  assert.deepEqual(stored(), []);
});

test("마무리 판정 뒤 쓰기 큐의 저장소 읽기가 지연되는 사이 같은 출처로 또 이동하면 저장하지 않는다(쓴 횟수도 반영 안 함)", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  assert.equal(local.get(KEY)[0].uses, 1);
  const before = JSON.stringify(local.get(KEY));
  for (const late of ["commit", "request"]) {
    openTab(1, `${O}/`);
    const t = { tabId: 1, internal: false };
    P.beginPath(t, `${O}/`);
    go(1, `${O}/help`);
    let release;
    const gate = new Promise((r) => (release = r));
    let reading = false;
    getHooks.set(KEY, async () => {
      reading = true;
      await gate;
    });
    const done = P.commitPath(t, opts());
    for (let i = 0; i < 100 && !reading; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(reading, "쓰기 큐가 저장소를 읽는 중");
    // 마무리 판정이 끝난 뒤의 이동: 새 문서의 요청은 아직 닫히지 않았다(또는 요청만 열렸다).
    const r = request(1, [`${O}/other`]);
    r.open();
    if (late === "commit") commit(1, `${O}/other`);
    release();
    await done;
    await ticks();
    assert.equal(JSON.stringify(local.get(KEY)), before, `${late}: 이전 경로를 저장하거나 쓴 횟수를 올리지 않음`);
    getHooks.clear();
  }
});

test("삭제 표식 400개 초과: 가장 오래된 표식을 버리며 전역 무효화(그 전에 시작한 턴은 쓰지 못함)", async () => {
  await fresh();
  openTab(1, `${O}/`);
  const t = { tabId: 1, internal: false };
  P.beginPath(t, `${O}/`);
  go(1, `${O}/help`);
  await P.deletePaths(Array.from({ length: P.MAX_PATH_DELETE_MARKS + 1 }, (_, i) => `path:https://s${i}.test x`));
  await P.commitPath(t, opts());
  await ticks();
  assert.deepEqual(stored(), []);
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`));
  assert.deepEqual(stored(), ["/ /help"]);
});

test("자동 로그인 값: 퍼센트 인코딩으로 경로에 든 값을 거친 턴은 저장 안 함(원본·정규화 틀 모두)", async () => {
  await fresh();
  await rememberSecrets(5, ["alicesecret"]);
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/profile/%61licesecret/help`);
    go(1, `${O}/help`);
  });
  assert.deepEqual(stored(), []);
  // 리다이렉트 중간 주소에만 보여도.
  openTab(1, `${O}/`);
  await turnOn(1, async () => go(1, `${O}/help`, { redirects: [`${O}/r?u=alicesecret`] }));
  assert.deepEqual(stored(), []);
});

test("후보 제시와 쓴 횟수: 낸 경로의 도착 틀에 닿아 답을 마치면 uses+1, 다른 곳에서 마치기 3번이면 사라짐", async () => {
  await fresh();
  openTab(1, `${O}/`);
  await turnOn(1, async () => {
    go(1, `${O}/help`);
    go(1, `${O}/help/notice/list`);
  });
  openTab(1, `${O}/`);
  await turnOn(1, async (t) => {
    const hints = await P.offerPathHints(t, `${O}/`);
    assert.deepEqual(hints, [{ steps: [{ pattern: "/help", direct: true }, { pattern: "/help/notice/list", direct: true }], uses: 1 }]);
    go(1, `${O}/help/notice/list`);
  });
  const paths = () => local.get(KEY) ?? [];
  const main = () => paths().find((r) => r.steps.join(" ") === "/ /help /help/notice/list");
  assert.equal(main().uses, 2);
  // 직접 이동으로 생긴 더 짧은 경로는 새로 생긴다(/ → /help/notice/list).
  assert.equal(paths().length, 2);
  // 중간 페이지에서 남은 구간을 따라가면 원래 경로가 오르고 새 경로는 안 생긴다.
  openTab(1, `${O}/help`);
  await turnOn(1, async (t) => {
    const hints = await P.offerPathHints(t, `${O}/help`);
    assert.deepEqual(hints.map((h) => h.steps.map((s) => s.pattern)), [["/help/notice/list"]]);
    go(1, `${O}/help/notice/list`);
  });
  assert.equal(main().uses, 3);
  assert.equal(paths().length, 2);
  // 도착 틀에 닿고 다른 곳에서 답을 마치기를 3번.
  for (let i = 0; i < 3; i++) {
    openTab(1, `${O}/help`);
    await turnOn(1, async (t) => {
      await P.offerPathHints(t, `${O}/help`);
      go(1, `${O}/help/notice/list`);
      go(1, `${O}/help/faq`);
    });
  }
  assert.equal(main(), undefined);
});

test("목록·개수·지우기: 경로 key만 지우고, 자동 로그인 값이 보이는 경로는 목록에서 뺀다", async () => {
  await fresh();
  local.set(KEY, [
    { id: "a", origin: O, steps: ["/", "/help"], uses: 1, misses: 0, lastUsed: Date.now() },
    { id: "b", origin: O, steps: ["/", "/u/alicesecret"], uses: 1, misses: 0, lastUsed: Date.now() },
    { id: "c", origin: O2, steps: ["/", "/faq"], uses: 1, misses: 0, lastUsed: Date.now() },
  ]);
  const list = await P.listPaths();
  assert.deepEqual(list.map((r) => r.id).sort(), ["a", "c"]);
  assert.equal(await P.pathRecipeCount(), 3);
  assert.equal(await P.deletePaths([`path:${O} a`, "read:whatever"]), 2);
  assert.deepEqual(local.get(KEY).map((r) => r.id).sort(), ["b", "c"]);
  const counts = await actionLog.storedCounts();
  assert.equal(counts.paths, 2);
  await actionLog.clearActionLog();
  assert.equal(local.has(KEY), false);
});
