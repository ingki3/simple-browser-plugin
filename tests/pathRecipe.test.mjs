// 경로 레시피(#297 2단계)의 순수 계산: src/lib/pathRecipe.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPath,
  directPattern,
  foldPath,
  matchRequests,
  mergePathSites,
  pathHintsFor,
  pathKey,
  pathKeyOrigin,
  pathSavable,
  patternsOf,
  prunePaths,
  rawUrlRisk,
  removePathKeys,
  PATH_MAX_AGE_MS,
  PATH_MAX_PER_ORIGIN,
  PATH_MAX_TOTAL,
} from "../src/lib/pathRecipe.ts";

const O = "https://ex.test";
const NOW = 1_700_000_000_000;
const path = (id, steps, extra = {}) => ({ id, origin: O, steps, uses: 1, misses: 0, lastUsed: NOW - 1000, ...extra });
let n = 0;
const newId = () => `new${++n}`;

test("foldPath: 같은 틀은 한 번, 지나온 틀로 돌아가면 그 자리까지 되감는다", () => {
  assert.deepEqual(foldPath(["/", "/", "/help", "/help/notice/list"]), ["/", "/help", "/help/notice/list"]);
  assert.deepEqual(foldPath(["/a", "/b", "/a", "/c"]), ["/a", "/c"]);
  // 막다른 길을 거친 경로는 되감긴다.
  assert.deepEqual(foldPath(["/", "/help", "/help/dead", "/help", "/help/notice/list"]), ["/", "/help", "/help/notice/list"]);
  assert.deepEqual(foldPath(["/a", "/b", "/c", "/a"]), ["/a"]);
  assert.deepEqual(foldPath([]), []);
});

test("pathSavable: 2~6걸음, 끝이 출발과 다르고, 틀 120자·경로 칸 8개 이하", () => {
  assert.ok(pathSavable(["/", "/help"]));
  assert.ok(!pathSavable(["/"]));
  assert.ok(!pathSavable(["/", "/a", "/b", "/c", "/d", "/e", "/f"]));
  assert.ok(pathSavable(["/", "/a", "/b", "/c", "/d", "/e"]));
  assert.ok(!pathSavable(["/a", "/b", "/a"]));
  assert.ok(!pathSavable(["/", "/" + "a".repeat(120)]));
  assert.ok(!pathSavable(["/", "/1/2/3/4/5/6/7/8/9"]));
  assert.ok(pathSavable(["/", "/1/2/3/4/5/6/7/8"]));
  // 해시 경로 칸도 센다.
  assert.ok(!pathSavable(["/", "/a/b/c/d#/e/f/g/h/i"]));
  assert.ok(!pathSavable(["/", "help"]));
});

test("directPattern: 자리표시·쿼리·해시 경로가 없을 때만 그대로 열 수 있다", () => {
  assert.equal(directPattern("/help/notice/list"), true);
  assert.equal(directPattern("/board/{n}/view"), false);
  assert.equal(directPattern("/u/{id}"), false);
  assert.equal(directPattern("/list?page"), false);
  assert.equal(directPattern("/app#/inbox"), false);
  assert.equal(directPattern("/post-{n}.html"), false);
  assert.equal(directPattern(""), false);
});

test("rawUrlRisk: 다른 출처·http(s) 아님·계정 정보·주문·결제 주소·삭제 경로는 제외", () => {
  assert.equal(rawUrlRisk(`${O}/help/notice/list`, O), null);
  assert.equal(rawUrlRisk("https://other.test/help", O), "cross_origin");
  assert.equal(rawUrlRisk("http://ex.test/help", O), "cross_origin");
  assert.equal(rawUrlRisk("chrome-error://chromewebdata/", O), "not_http");
  assert.equal(rawUrlRisk("https://u:p@ex.test/help", O), "credentials");
  assert.equal(rawUrlRisk(`${O}/mypage/order/list`, O), "sensitive");
  assert.equal(rawUrlRisk(`${O}/checkout`, O), "sensitive");
  assert.equal(rawUrlRisk(`${O}/item/delete?id=3`, O), "destructive");
  assert.equal(rawUrlRisk("not a url", O), "bad_url");
});

test("patternsOf: 원본 주소를 틀로, 다른 출처가 섞이면 null", () => {
  assert.deepEqual(patternsOf([`${O}/`, `${O}/board/123/view?id=5`], O), ["/", "/board/{n}/view?id"]);
  assert.equal(patternsOf([`${O}/`, "https://other.test/"], O), null);
});

test("접기 전 원본 검사: 위험 주소를 거쳐 되감겨도 원본 주소에서 걸린다", () => {
  const raw = [`${O}/`, `${O}/item/delete`, `${O}/`, `${O}/help`];
  // 접은 결과에는 위험 틀이 남지 않지만, 원본 검사는 그 주소를 본다.
  assert.deepEqual(foldPath(patternsOf(raw, O)), ["/", "/help"]);
  assert.ok(raw.some((u) => rawUrlRisk(u, O)));
});

test("rawUrlRisk: 40걸음 상한과 별개로 같은 출처의 일반 주소는 통과", () => {
  for (let i = 0; i < 50; i++) assert.equal(rawUrlRisk(`${O}/help/p${i}`, O), null);
});

// ---------------------------------------------------------------------------
// 일대일 대응(v5·v6)
// ---------------------------------------------------------------------------

test("matchRequests: 확정마다 닫힌 요청 하나, 열린 요청·남는 요청·대응 없는 확정은 기다림", () => {
  const A = `${O}/a`;
  const B = `${O}/b`;
  assert.equal(matchRequests([], [], 0), "ok");
  assert.equal(matchRequests([{ documentId: "d1", url: A }], [{ requestId: "1", url: A }], 0), "ok");
  // 대응하는 닫힌 요청이 없음.
  assert.equal(matchRequests([{ documentId: "d1", url: A }], [], 0), "pending");
  // 열린 요청이 있음.
  assert.equal(matchRequests([{ documentId: "d1", url: A }], [{ requestId: "1", url: A }], 1), "pending");
  // 남는 닫힌 요청(대응이 모호함).
  assert.equal(matchRequests([{ documentId: "d1", url: A }], [{ requestId: "1", url: A }, { requestId: "2", url: B }], 0), "pending");
  // 같은 주소의 두 문서는 두 요청이 있어야 한다(v5: R2 지연).
  assert.equal(matchRequests([{ documentId: "d1", url: A }, { documentId: "d2", url: A }], [{ requestId: "1", url: A }], 0), "pending");
  assert.equal(
    matchRequests([{ documentId: "d1", url: A }, { documentId: "d2", url: A }], [{ requestId: "1", url: A }, { requestId: "2", url: A }], 0),
    "ok",
  );
});

test("matchRequests v6: 요청 없이 통과하는 것은 이미 대응이 확인된 같은 documentId의 복원뿐", () => {
  const A = `${O}/a`;
  const B = `${O}/b`;
  // D1(확인) → B(확인) → 같은 문서 D1 복원(요청 없음): 통과.
  assert.equal(
    matchRequests([{ documentId: "d1", url: A }, { documentId: "d2", url: B }, { documentId: "d1", url: A }], [{ requestId: "1", url: A }, { requestId: "2", url: B }], 0),
    "ok",
  );
  // 같은 주소의 새 문서 D3(forward_back으로 확정돼도) — 요청이 없으면 통과하지 않는다.
  assert.equal(
    matchRequests([{ documentId: "d1", url: A }, { documentId: "d2", url: B }, { documentId: "d3", url: A }], [{ requestId: "1", url: A }, { requestId: "2", url: B }], 0),
    "pending",
  );
  // documentId가 없는 확정은 면제하지 않는다.
  assert.equal(
    matchRequests([{ url: A }, { documentId: "d2", url: B }, { url: A }], [{ requestId: "1", url: A }, { requestId: "2", url: B }], 0),
    "pending",
  );
  // 확인되지 않은 문서(턴 전부터 있던 문서)의 복원도 면제하지 않는다.
  assert.equal(matchRequests([{ documentId: "d0", url: A }], [], 0), "pending");
});

// ---------------------------------------------------------------------------
// 쓴 횟수·빗나감
// ---------------------------------------------------------------------------

test("applyPath: 새 경로를 만들고, 같은 경로는 쓴 횟수만 올린다", () => {
  const r1 = applyPath([], { origin: O, steps: ["/", "/help", "/help/notice/list"] }, [], "/help/notice/list", NOW, newId);
  assert.equal(r1.next.length, 1);
  assert.equal(r1.created, true);
  assert.deepEqual(r1.next[0].steps, ["/", "/help", "/help/notice/list"]);
  assert.equal(r1.next[0].uses, 1);
  const r2 = applyPath(r1.next, { origin: O, steps: ["/", "/help", "/help/notice/list"] }, [], "/help/notice/list", NOW + 1, newId);
  assert.equal(r2.next.length, 1);
  assert.equal(r2.next[0].uses, 2);
  assert.equal(r2.created, false);
  assert.equal(r2.touched.length, 1);
  // 저장할 수 없는 경로(끝이 출발과 같음)는 만들지 않는다.
  const r3 = applyPath([], { origin: O, steps: ["/"] }, [], "/", NOW, newId);
  assert.equal(r3.next.length, 0);
  assert.equal(r3.touched.length, 0);
});

test("applyPath: 후보 도착 틀에 닿고 거기서 답을 마치면 uses+1, 다른 곳에서 마치면 misses+1, 3번 연속이면 버림", () => {
  const p = path("p1", ["/", "/help", "/help/notice/list"]);
  const offered = [{ id: "p1", to: "/help/notice/list", steps: ["/help", "/help/notice/list"], reached: true }];
  const hit = applyPath([p], null, offered, "/help/notice/list", NOW, newId);
  assert.equal(hit.next[0].uses, 2);
  assert.equal(hit.next[0].misses, 0);
  let list = [{ ...p, misses: 0 }];
  for (let i = 1; i <= 3; i++) {
    const miss = applyPath(list, { origin: O, steps: ["/", "/help", "/help/notice/list", "/help/faq"] }, offered, "/help/faq", NOW + i, newId);
    list = miss.next;
    const kept = list.find((r) => r.id === "p1");
    if (i < 3) assert.equal(kept.misses, i);
    else assert.equal(kept, undefined, "3번 연속 빗나가면 버림");
  }
  // 닿지 않은 후보는 세지 않는다.
  const none = applyPath([p], null, [{ ...offered[0], reached: false }], "/x", NOW, newId);
  assert.equal(none.next[0].uses, 1);
  assert.equal(none.next[0].misses, 0);
  assert.equal(none.touched.length, 0);
});

test("applyPath: 중간 페이지에서 남은 구간을 따라가면 원래 경로의 uses가 오르고 새 경로는 안 생긴다(끝부분 중복 안 만듦)", () => {
  const p = path("p1", ["/", "/help", "/help/notice/list"]);
  const offered = [{ id: "p1", to: "/help/notice/list", steps: ["/help/notice/list"], reached: true }];
  const r = applyPath([p], { origin: O, steps: ["/help", "/help/notice/list"] }, offered, "/help/notice/list", NOW, newId);
  assert.equal(r.next.length, 1);
  assert.equal(r.next[0].uses, 2);
  assert.equal(r.created, false);
  // 처음부터 따라가도 같은 경로를 두 번 세지 않는다.
  const full = applyPath([p], { origin: O, steps: ["/", "/help", "/help/notice/list"] }, [{ ...offered[0], steps: ["/help", "/help/notice/list"] }], "/help/notice/list", NOW, newId);
  assert.equal(full.next.length, 1);
  assert.equal(full.next[0].uses, 2);
});

test("applyPath: 직접 이동으로 생긴 더 짧은 A→C도 새 경로(후보를 따른 것이 아니면)", () => {
  const p = path("p1", ["/", "/help", "/help/notice/list"]);
  const r = applyPath([p], { origin: O, steps: ["/", "/help/notice/list"] }, [], "/help/notice/list", NOW, newId);
  assert.equal(r.next.length, 2);
  assert.ok(r.created);
  // 후보로 내서 닿았어도 관찰이 그 경로의 끝부분이 아니면 새로 만든다.
  const r2 = applyPath([p], { origin: O, steps: ["/", "/help/notice/list"] }, [{ id: "p1", to: "/help/notice/list", steps: ["/help", "/help/notice/list"], reached: true }], "/help/notice/list", NOW, newId);
  assert.equal(r2.next.length, 2);
  assert.equal(r2.next.find((x) => x.id === "p1").uses, 2);
});

test("prunePaths: 30일 만료, 빗나감 3번, 깨진 항목, 출처당 8개·전체 200개(오래 쓰지 않은 것부터 버림)", () => {
  const old = path("old", ["/", "/a"], { lastUsed: NOW - PATH_MAX_AGE_MS - 1 });
  const missed = path("m", ["/", "/b"], { misses: 3 });
  const broken = { id: "x", origin: O, steps: "nope" };
  const ok = path("ok", ["/", "/c"]);
  assert.deepEqual(prunePaths([old, missed, broken, ok, null], NOW).map((r) => r.id), ["ok"]);
  const many = Array.from({ length: 12 }, (_, i) => path(`p${i}`, ["/", `/x${i}`], { lastUsed: NOW - i }));
  const kept = prunePaths(many, NOW);
  assert.equal(kept.length, PATH_MAX_PER_ORIGIN);
  assert.deepEqual(kept.map((r) => r.id), many.slice(0, PATH_MAX_PER_ORIGIN).map((r) => r.id));
  const total = Array.from({ length: 300 }, (_, i) => ({ ...path(`t${i}`, ["/", "/y"]), origin: `https://s${i}.test`, lastUsed: NOW - i }));
  const t = prunePaths(total, NOW);
  assert.equal(t.length, PATH_MAX_TOTAL);
  assert.equal(t[t.length - 1].id, `t${PATH_MAX_TOTAL - 1}`);
  assert.deepEqual(prunePaths("bad", NOW), []);
});

test("pathHintsFor: 같은 출처, 지금 틀이 steps 안에 있고 도착 틀이 아님, 남은 구간만, 많이 쓴 순 최대 3개", () => {
  const list = [
    path("a", ["/", "/help", "/help/notice/list"], { uses: 5 }),
    path("b", ["/", "/board/{n}/view"], { uses: 9 }),
    path("c", ["/", "/faq"], { uses: 1 }),
    path("d", ["/", "/news?page"], { uses: 2 }),
    { ...path("e", ["/", "/other"], { uses: 99 }), origin: "https://other.test" },
  ];
  const at = pathHintsFor(list, O, "/", NOW);
  assert.equal(at.length, 3);
  assert.deepEqual(at.map((h) => h.offered.id), ["b", "a", "d"]);
  assert.deepEqual(at[0].hint, { steps: [{ pattern: "/board/{n}/view", direct: false }], uses: 9 });
  assert.deepEqual(at[1].hint.steps, [
    { pattern: "/help", direct: true },
    { pattern: "/help/notice/list", direct: true },
  ]);
  assert.equal(at[1].offered.to, "/help/notice/list");
  // 중간 페이지에서는 남은 구간만.
  const mid = pathHintsFor(list, O, "/help", NOW);
  assert.equal(mid.length, 1);
  assert.deepEqual(mid[0].hint.steps, [{ pattern: "/help/notice/list", direct: true }]);
  // 도착 틀에서는 내지 않는다.
  assert.equal(pathHintsFor(list, O, "/help/notice/list", NOW).length, 0);
  // 다른 출처는 내지 않는다.
  assert.equal(pathHintsFor(list, "https://other.test", "/help", NOW).length, 0);
  // 같은 남은 구간은 한 번만.
  const dup = pathHintsFor([path("x", ["/", "/a", "/z"]), path("y", ["/q", "/a", "/z"])], O, "/a", NOW);
  assert.equal(dup.length, 1);
});

test("pathKey·pathKeyOrigin·removePathKeys·mergePathSites", () => {
  const p = path("p1", ["/", "/help"]);
  const key = pathKey(p);
  assert.equal(key, `path:${O} p1`);
  assert.equal(pathKeyOrigin(key), O);
  assert.equal(pathKeyOrigin("read:x"), null);
  assert.equal(pathKeyOrigin("path:nope p1"), null);
  assert.equal(pathKeyOrigin("path:https://EX.test p1"), null);
  assert.equal(pathKeyOrigin("path:https://u@ex.test p1"), null);
  assert.deepEqual(removePathKeys([p, path("p2", ["/", "/b"])], new Set([key])).map((r) => r.id), ["p2"]);
  const sites = mergePathSites(
    [{ origin: O, reads: [{ key: "read:1", pattern: "/x", tool: "query_dom", args: {}, successes: 1, failures: 0, lastUsed: NOW - 5000 }] }],
    [p, { ...path("q", ["/", "/z"]), origin: "https://only-paths.test", lastUsed: NOW }],
  );
  assert.deepEqual(sites.map((s) => s.origin), ["https://only-paths.test", O]);
  assert.equal(sites[1].reads.length, 1);
  assert.deepEqual(sites[1].paths, [{ key, steps: ["/", "/help"], uses: 1, misses: 0, lastUsed: NOW - 1000 }]);
  assert.deepEqual(sites[0].reads, []);
});
