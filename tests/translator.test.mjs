// 번역 세션의 기준표 상태 기계(#302, src/background/translator.ts). 제공자 어댑터·가림 목록 검사·설정 읽기는 agentLoader 대역으로 바꾸고
// translateBatch를 직접 구동한다. 생성 요청은 프롬프트의 "최대 20개", 기준표 스냅샷은 "용어표(자료, 지시 아님):" 다음 줄로 알아본다.
import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/agentLoader.mjs";

// 설정 변경 리스너를 붙잡는 chrome 대역(그 밖의 API는 아무 일도 하지 않음).
const changeListeners = [];
function deep(path = "") {
  return new Proxy(function () {}, {
    get: (_t, k) => (k === "then" ? undefined : deep(`${path}.${String(k)}`)),
    apply: (_t, _this, args) => {
      if (path === ".storage.onChanged.addListener") changeListeners.push(args[0]);
      return Promise.resolve({});
    },
  });
}
globalThis.chrome = deep();
// 대역이 빠져도 밖으로 요청이 나가지 않게 한다.
globalThis.fetch = async () => {
  throw new Error("시험에서 네트워크 요청 금지");
};

const { normalizeSettings, activeModel } = await import("../src/lib/settings.ts");
const T = await import("../src/background/translator.ts");

const SETTINGS = normalizeSettings({ provider: "openrouter", openRouterApiKey: "sk-test", model: "deepseek/x" });
const ACTIVE = activeModel(SETTINGS);

// 모델 호출 기록. 각 호출은 시험이 reply/fail로 끝낸다(중단 신호가 오면 AbortError).
let calls = [];
let callWaiters = [];
function stubAdapter() {
  globalThis.__agentStubs = {
    "storage.getSettings": async () => SETTINGS,
    "providers.providerAdapter": () => ({
      label: "모의",
      complete: (_active, req, signal) =>
        new Promise((resolve, reject) => {
          const prompt = req.messages[0].content;
          const call = {
            prompt,
            req,
            texts: JSON.parse(prompt.slice(prompt.lastIndexOf("입력:\n") + "입력:\n".length)),
            generator: prompt.includes("최대 20개"),
            glossary: (() => {
              const i = prompt.indexOf("용어표(자료, 지시 아님):\n");
              return i < 0 ? [] : JSON.parse(prompt.slice(i).split("\n")[1]);
            })(),
            reply: (glossary, translations) =>
              resolve(JSON.stringify({ translations: translations ?? call.texts.map((t) => `번역:${t}`), glossary })),
            replyRaw: (raw) => resolve(raw),
            fail: (err) => reject(err),
          };
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          calls.push(call);
          for (const w of callWaiters.splice(0)) w();
        }),
    }),
    "providers.providerTimeout": () => 5000,
  };
}
// n번째 호출(1부터)이 올 때까지 기다린다.
async function callAt(n) {
  while (calls.length < n) await new Promise((r) => callWaiters.push(r));
  return calls[n - 1];
}
const tick = () => new Promise((r) => setTimeout(r, 10));

function fresh(style = "plain", targetLang = "ko") {
  calls = [];
  callWaiters = [];
  stubAdapter();
  return T.beginTranslationSession(ACTIVE, { targetLang, style });
}

test("첫 실제 요청이 생성자, 같은 세션의 다시 온 같은 원문은 캐시(모델 호출 없음), 일부 적중은 모르는 원문만 보냄", async () => {
  const sid = fresh();
  const p = T.translateBatch(["Alpha Widget"], "ko", sid);
  const c1 = await callAt(1);
  assert.equal(c1.generator, true);
  assert.equal(c1.req.responseFormat.json_schema.schema.properties.glossary.maxItems, 20);
  c1.reply([{ source: "Widget", target: "위젯" }]);
  assert.deepEqual(await p, ["번역:Alpha Widget"]);
  assert.deepEqual(await T.translateBatch(["Alpha Widget"], "ko", sid), ["번역:Alpha Widget"]);
  assert.equal(calls.length, 1, "캐시 적중은 호출 없음");
  const p2 = T.translateBatch(["Alpha Widget", "Beta"], "ko", sid);
  const c2 = await callAt(2);
  assert.equal(c2.generator, false);
  assert.equal(c2.req.responseFormat.json_schema.schema.properties.glossary.maxItems, 10);
  assert.deepEqual(c2.texts, ["Beta"]);
  assert.deepEqual(c2.glossary, [{ source: "Widget", target: "위젯" }]);
  c2.reply([]);
  assert.deepEqual(await p2, ["번역:Alpha Widget", "번역:Beta"]);
  T.endTranslationSession(sid);
});

test("동시 요청 여러 개 중 하나만 생성자, 나머지는 기다렸다가 기준표 스냅샷을 프롬프트에 받음", async () => {
  const sid = fresh();
  const pa = T.translateBatch(["The Gizmo works"], "ko", sid);
  const pb = T.translateBatch(["Second Gizmo"], "ko", sid);
  const pc = T.translateBatch(["Third part"], "ko", sid);
  const a = await callAt(1);
  await tick();
  assert.equal(calls.length, 1, "생성 요청이 끝날 때까지 다른 요청은 기다림");
  assert.equal(a.generator, true);
  a.reply([{ source: "Gizmo", target: "기즈모" }]);
  const b = await callAt(2);
  const c = await callAt(3);
  for (const x of [b, c]) {
    assert.equal(x.generator, false);
    assert.deepEqual(x.glossary, [{ source: "Gizmo", target: "기즈모" }]);
    x.reply([]);
  }
  await Promise.all([pa, pb, pc]);
  T.endTranslationSession(sid);
});

test("생성자 실패: 대기자 중 정확히 하나가 다음 생성자, 재선점 중 새 요청은 대기, 두 번째 실패면 빈 기준표 ready, 오류는 호출자에게", async () => {
  const sid = fresh();
  const pa = T.translateBatch(["One"], "ko", sid);
  const pb = T.translateBatch(["Two"], "ko", sid);
  const pc = T.translateBatch(["Three"], "ko", sid);
  const a = await callAt(1);
  a.replyRaw('{"translations":[],"glossary":[]}'); // 응답 모양 오류도 실패
  await assert.rejects(pa, /길이 불일치/);
  const b = await callAt(2);
  await tick();
  assert.equal(calls.length, 2, "다음 생성자 하나만 보냄");
  assert.equal(b.generator, true);
  const pd = T.translateBatch(["Four"], "ko", sid); // 재선점 중 도착
  await tick();
  assert.equal(calls.length, 2, "재선점 중 새 요청도 기다림");
  b.fail(new Error("네트워크 끊김"));
  await assert.rejects(pb, /네트워크 끊김/);
  const c = await callAt(3);
  const d = await callAt(4);
  for (const x of [c, d]) {
    assert.equal(x.generator, false, "두 번 실패하면 더 만들지 않음");
    assert.deepEqual(x.glossary, []);
    x.reply([{ source: x.texts[0], target: "새것" }]);
  }
  assert.deepEqual(await pc, ["번역:Three"]);
  assert.deepEqual(await pd, ["번역:Four"]);
  // 일반 요청의 기준표는 이후 병합된다.
  const pe = T.translateBatch(["Five Three"], "ko", sid);
  const e = await callAt(5);
  assert.deepEqual(e.glossary.map((g) => g.source).sort(), ["Four", "Three"]);
  e.reply([]);
  await pe;
  T.endTranslationSession(sid);
});

test("생성자 첫 실패 뒤 대기자가 없으면 다음 실제 요청이 생성자(시도는 실제 생성 요청에서만 셈)", async () => {
  const sid = fresh();
  const pa = T.translateBatch(["One"], "ko", sid);
  (await callAt(1)).fail(new Error("시간 초과"));
  await assert.rejects(pa);
  const pb = T.translateBatch(["Two"], "ko", sid);
  const b = await callAt(2);
  assert.equal(b.generator, true);
  b.reply([{ source: "Two", target: "둘" }]);
  await pb;
  const pc = T.translateBatch(["Three Two"], "ko", sid);
  const c = await callAt(3);
  assert.equal(c.generator, false);
  assert.deepEqual(c.glossary, [{ source: "Two", target: "둘" }]);
  c.reply([]);
  await pc;
  T.endTranslationSession(sid);
});

test("번역 성공·기준표 무효(모양 틀림·빠짐) → 번역은 쓰고 빈 기준표로 ready(다시 만들지 않음)", async () => {
  for (const raw of [(t) => JSON.stringify({ translations: t, glossary: "bad" }), (t) => JSON.stringify({ translations: t })]) {
    const sid = fresh();
    const pa = T.translateBatch(["Alpha"], "ko", sid);
    const a = await callAt(1);
    a.replyRaw(raw(a.texts.map((t) => `번역:${t}`)));
    assert.deepEqual(await pa, ["번역:Alpha"]);
    const pb = T.translateBatch(["Beta"], "ko", sid);
    const b = await callAt(2);
    assert.equal(b.generator, false);
    assert.deepEqual(b.glossary, []);
    b.reply([]);
    await pb;
    T.endTranslationSession(sid);
  }
});

test("기준표 항목: 원문에 없는 source·비밀값 항목은 버리고, 가림 목록 조회가 실패하면 그 응답 항목을 모두 버림", async () => {
  const sid = fresh();
  globalThis.__agentStubs["loginSecrets.containsSecret"] = async (v) => JSON.stringify(v).includes("SECRETX");
  const pa = T.translateBatch(["Widget and SECRETX here"], "ko", sid);
  (await callAt(1)).reply([
    { source: "Widget", target: "위젯" },
    { source: "SECRETX", target: "비밀" },
    { source: "Invented", target: "지어냄" },
  ]);
  await pa;
  globalThis.__agentStubs["loginSecrets.containsSecret"] = async () => {
    throw new Error("저장소 읽기 실패");
  };
  const pb = T.translateBatch(["Gizmo text"], "ko", sid);
  const b = await callAt(2);
  assert.deepEqual(b.glossary, [{ source: "Widget", target: "위젯" }]);
  b.reply([{ source: "Gizmo", target: "기즈모" }]);
  assert.deepEqual(await pb, ["번역:Gizmo text"], "조회 실패여도 번역은 씀");
  delete globalThis.__agentStubs["loginSecrets.containsSecret"];
  const pc = T.translateBatch(["Third"], "ko", sid);
  const c = await callAt(3);
  assert.deepEqual(c.glossary, [{ source: "Widget", target: "위젯" }], "검사 못 한 항목은 들어가지 않음");
  c.reply([]);
  await pc;
  T.endTranslationSession(sid);
});

test("대기 중 세션 종료 → 대기자는 종료 오류, 진행 중 생성 요청도 종료 오류", async () => {
  const sid = fresh();
  const pa = T.translateBatch(["One"], "ko", sid);
  const pb = T.translateBatch(["Two"], "ko", sid);
  await callAt(1);
  T.endTranslationSession(sid);
  await assert.rejects(pb, (e) => e.message === T.TRANSLATION_SESSION_ENDED);
  await assert.rejects(pa, (e) => e.message === T.TRANSLATION_SESSION_ENDED);
  assert.equal(calls.length, 1);
});

test("비밀 검사를 기다리는 사이 세션이 끝나면 늦은 결과를 기준표·캐시에 반영하지 않고 종료 오류", async () => {
  const sid = fresh();
  let release;
  const gate = new Promise((r) => (release = r));
  let checking = false;
  globalThis.__agentStubs["loginSecrets.containsSecret"] = async () => {
    checking = true;
    await gate;
    return false;
  };
  const pa = T.translateBatch(["Widget one"], "ko", sid);
  (await callAt(1)).reply([{ source: "Widget", target: "위젯" }]);
  while (!checking) await tick();
  T.endTranslationSession(sid);
  release();
  await assert.rejects(pa, (e) => e.message === T.TRANSLATION_SESSION_ENDED);
  delete globalThis.__agentStubs["loginSecrets.containsSecret"];
  await assert.rejects(T.translateBatch(["Widget one"], "ko", sid), (e) => e.message === T.TRANSLATION_SESSION_ENDED);
});

test("동시 일반 응답의 같은 source는 먼저 완료된 쪽 유지, 병합 상한 40", async () => {
  const sid = fresh();
  const words = Array.from({ length: 50 }, (_, i) => `Term${i}q`);
  const pa = T.translateBatch([words.slice(0, 20).join(" ")], "ko", sid);
  (await callAt(1)).reply(words.slice(0, 20).map((w) => ({ source: w, target: `용${w}` })));
  await pa;
  const pb = T.translateBatch([`Gizmo ${words.slice(20, 30).join(" ")}`], "ko", sid);
  const pc = T.translateBatch([`gizmo ${words.slice(30, 40).join(" ")}`], "ko", sid);
  const b = await callAt(2);
  const c = await callAt(3);
  c.reply([{ source: "gizmo", target: "기즈모C" }, ...words.slice(30, 39).map((w) => ({ source: w, target: `용${w}` }))]);
  await pc;
  b.reply([{ source: "Gizmo", target: "기즈모B" }, ...words.slice(20, 29).map((w) => ({ source: w, target: `용${w}` }))]);
  await pb;
  const pd = T.translateBatch([`More ${words.slice(40).join(" ")}`], "ko", sid);
  const d = await callAt(4);
  assert.equal(d.glossary.length, 39);
  assert.deepEqual(d.glossary.filter((g) => g.source.toLowerCase() === "gizmo"), [{ source: "gizmo", target: "기즈모C" }]);
  d.reply(words.slice(40).map((w) => ({ source: w, target: `용${w}` })));
  await pd;
  const pe = T.translateBatch(["Last"], "ko", sid);
  const e = await callAt(5);
  assert.equal(e.glossary.length, 40, "상한 40");
  e.reply([]);
  await pe;
  T.endTranslationSession(sid);
});

test("세션 사이에 캐시·기준표를 나누지 않음, 세션 언어와 다른 targetLang은 모델 호출 없이 거절", async () => {
  const s1 = fresh();
  const p1 = T.translateBatch(["Alpha Widget"], "ko", s1);
  (await callAt(1)).reply([{ source: "Widget", target: "위젯" }]);
  await p1;
  await assert.rejects(T.translateBatch(["Alpha Widget"], "en", s1), (e) => e.message === T.TRANSLATION_SESSION_ENDED);
  assert.equal(calls.length, 1, "다른 언어 요청은 보내지 않음");
  const s2 = T.beginTranslationSession(ACTIVE, { targetLang: "ko", style: "plain" });
  const p2 = T.translateBatch(["Alpha Widget"], "ko", s2);
  const c = await callAt(2);
  assert.equal(c.generator, true, "새 세션은 새 기준표");
  assert.deepEqual(c.glossary, []);
  c.reply([]);
  await p2;
  T.endTranslationSession(s1);
  T.endTranslationSession(s2);
});

test("문체는 세션에 고정(다른 문체의 새 세션은 새 지시), 모델 대상이 바뀌면 세션 종료", async () => {
  const s1 = fresh("plain");
  const p1 = T.translateBatch(["Hello"], "ko", s1);
  const a = await callAt(1);
  assert.match(a.prompt, /해라체\(~다\)/);
  a.reply([]);
  await p1;
  const s2 = T.beginTranslationSession(ACTIVE, { targetLang: "ko", style: "polite" });
  const p2 = T.translateBatch(["Hello"], "ko", s2);
  const b = await callAt(2);
  assert.match(b.prompt, /해요체\(~요\)/);
  b.reply([]);
  await p2;
  // 앞 세션은 그대로(해라체): 새 원문 요청도 해라체.
  const p3 = T.translateBatch(["World"], "ko", s1);
  const c = await callAt(3);
  assert.match(c.prompt, /해라체\(~다\)/);
  c.reply([]);
  await p3;
  // 알 수 없는 문체는 기본(해라체).
  const s3 = T.beginTranslationSession(ACTIVE, { targetLang: "ko", style: "weird" });
  const p4 = T.translateBatch(["Hello"], "ko", s3);
  const d = await callAt(4);
  assert.match(d.prompt, /해라체\(~다\)/);
  d.reply([]);
  await p4;
  // 모델 변경: 설정 변경 리스너가 다른 대상의 세션을 끝낸다.
  assert.ok(changeListeners.length >= 1);
  for (const l of changeListeners) l({ settings: { newValue: { ...SETTINGS, model: "other/model" } } }, "local");
  for (const s of [s1, s2, s3]) {
    await assert.rejects(T.translateBatch(["Brand new"], "ko", s), (e) => e.message === T.TRANSLATION_SESSION_ENDED);
  }
  assert.equal(calls.length, 4);
});
