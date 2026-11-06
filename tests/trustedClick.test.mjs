import test from "node:test";
import assert from "node:assert/strict";

import { clickPoint, clickPoints, describeMissedClick, frameNeedsGuard, guardTimeLeft, GUARD_MS, GUARD_MIN_REMAINING_MS, unguardedFrame } from "../src/lib/trustedClick.ts";

const VIEW = { width: 800, height: 600 };

test("clickPoint: center of the first rect that overlaps the viewport", () => {
  assert.deepEqual(clickPoint([{ left: 10, top: 20, width: 100, height: 40 }], VIEW), { x: 60, y: 40 });
  // 화면 밖 사각형은 건너뛰고 다음 사각형(줄바꿈된 링크의 둘째 줄)을 쓴다.
  assert.deepEqual(
    clickPoint(
      [
        { left: 790, top: -50, width: 100, height: 20 },
        { left: 0, top: 100, width: 50, height: 20 },
      ],
      VIEW,
    ),
    { x: 25, y: 110 },
  );
});

test("clickPoint: clips to the viewport and rejects empty overlaps", () => {
  // 위로 반쯤 걸친 사각형은 보이는 부분의 가운데.
  assert.deepEqual(clickPoint([{ left: 0, top: -20, width: 40, height: 40 }], VIEW), { x: 20, y: 10 });
  assert.equal(clickPoint([{ left: 0, top: 0, width: 0, height: 10 }], VIEW), null);
  assert.equal(clickPoint([{ left: 0, top: 600, width: 50, height: 50 }], VIEW), null);
  assert.equal(clickPoint([{ left: 10, top: 10, width: 0.5, height: 30 }], VIEW), null);
  assert.equal(clickPoint([], VIEW), null);
});

test("frameNeedsGuard: server documents need a guard, creator-made documents do not", () => {
  assert.equal(frameNeedsGuard("https://pay.example.com/widget"), true);
  assert.equal(frameNeedsGuard("http://127.0.0.1:3000/f"), true);
  assert.equal(frameNeedsGuard("file:///tmp/a.html"), true);
  assert.equal(frameNeedsGuard("about:blank"), false);
  assert.equal(frameNeedsGuard("about:srcdoc"), false);
  assert.equal(frameNeedsGuard("data:text/html,x"), false);
  assert.equal(frameNeedsGuard("blob:https://a.example/uuid"), false);
});

test("unguardedFrame: a reloaded frame (same frameId, new document) is not guarded", () => {
  const frames = [
    { frameId: 3, documentId: "D3-new", url: "https://ads.example/" },
    { frameId: 4, documentId: "D4", url: "about:blank" },
  ];
  assert.equal(unguardedFrame(frames, new Set(["D3-old"]))?.documentId, "D3-new");
  assert.equal(unguardedFrame(frames, new Set(["D3-new"])), null);
});

test("guardTimeLeft: frame guards armed too long ago are not trusted", () => {
  assert.equal(guardTimeLeft(1000, 1000), true);
  assert.equal(guardTimeLeft(1000, 1000 + GUARD_MS - GUARD_MIN_REMAINING_MS), true);
  assert.equal(guardTimeLeft(1000, 1001 + GUARD_MS - GUARD_MIN_REMAINING_MS), false);
  assert.equal(guardTimeLeft(1000, 1000 + GUARD_MS + 5000), false);
});

test("describeMissedClick: 다른 프레임이 막은 입력·화면 밖 점·받은 입력을 알린다", () => {
  const viewport = { width: 1000, height: 800 };
  assert.equal(
    describeMissedClick({ seen: [], viewport, point: { x: 10, y: 10 }, frameBlocked: 3 }),
    "그 자리의 다른 프레임이 입력 3개를 받아 막음; 이 문서에 입력이 오지 않음",
  );
  assert.equal(
    describeMissedClick({ seen: [], viewport, point: { x: 10, y: 900 }, frameBlocked: 0 }),
    "누른 점(10, 900)이 화면(1000×800) 밖; 이 문서에 입력이 오지 않음",
  );
  assert.equal(
    describeMissedClick({ seen: ["pointerdown", "mousedown", "pointerup"], viewport, point: { x: 10, y: 10 }, frameBlocked: 0 }),
    "이 문서가 받은 입력: pointerdown, mousedown, pointerup — click이 생기지 않음",
  );  assert.equal(
    describeMissedClick({ seen: [], viewport, point: { x: 10, y: 10 }, frameBlocked: 0, hidden: true }),
    "탭이 화면에 보이지 않음(뒤에 있는 탭); 이 문서에 입력이 오지 않음",
  );
});

test("clickPoints: 가운데 다음 안쪽 네 점, 화면 밖 사각형은 건너뜀(#89)", () => {
  const pts = clickPoints([{ left: -500, top: 0, width: 100, height: 100 }, { left: 0, top: 0, width: 200, height: 40 }], VIEW);
  assert.deepEqual(pts[0], { x: 100, y: 20 });
  assert.deepEqual(pts.slice(1), [
    { x: 50, y: 10 },
    { x: 150, y: 10 },
    { x: 50, y: 30 },
    { x: 150, y: 30 },
  ]);
  assert.deepEqual(clickPoints([], VIEW), []);
  // 첫 후보는 clickPoint와 같다.
  const r = [{ left: 10, top: 20, width: 100, height: 40 }];
  assert.deepEqual(clickPoints(r, VIEW)[0], clickPoint(r, VIEW));
});

// #241: 막힌 실제 입력 클릭의 모델 문구·진단 줄.
import { blockDiagText, describeBlockedClick, describePressedFailure, roleToken } from "../src/lib/trustedClick.ts";

const fb = (over = {}) => ({ event: "mousedown", seenBefore: ["pointerdown"], targetConnected: false, targetShown: false, hit: { tag: "button" }, ...over });

test("describeBlockedClick: 단계와 대상 상태(떨어짐·숨겨짐)를 구조 사실로만 알리고 결과 먼저 확인을 안내", () => {
  const detached = describeBlockedClick("다른 요소에 닿음", fb());
  assert.match(detached, /실제 입력 클릭을 도중에 막았습니다\(다른 요소에 닿음\)/);
  assert.match(detached, /누르기\(mousedown\) 단계에서 막음/);
  assert.match(detached, /문서에서 떨어졌습니다/);
  assert.match(detached, /다시 누르지 마세요/);
  const hidden = describeBlockedClick("다른 요소에 닿음", fb({ event: "pointerup", targetConnected: true, targetShown: false }));
  assert.match(hidden, /떼기\(pointerup\) 단계/);
  assert.match(hidden, /화면에서 사라졌습니다\(숨겨짐\)/);
  assert.doesNotMatch(hidden, /떨어졌/);
  const shown = describeBlockedClick("다른 요소에 닿음", fb({ event: "click", targetConnected: true, targetShown: true }));
  assert.doesNotMatch(shown, /떨어졌|사라졌/);
  // 옛 보고(첫 차단 정보 없음)·모르는 단계 이름은 기본 문구만.
  const plain = describeBlockedClick("확인 시간이 지남");
  assert.match(plain, /^실제 입력 클릭을 도중에 막았습니다\(확인 시간이 지남\)\. 클릭은 끝나지 않았지만/);
  assert.doesNotMatch(describeBlockedClick("x", fb({ event: "만료", targetConnected: true, targetShown: true })), /단계에서 막음/);
});

test("describePressedFailure: 단계 문장 + 고정 안내", () => {
  const t = describePressedFailure("마우스를 누른 뒤 페이지가 문서를 바꿔 떼기 입력을 보내지 않았습니다");
  assert.match(t, /^마우스를 누른 뒤 페이지가 문서를 바꿔 떼기 입력을 보내지 않았습니다\. 누르기 단계의 페이지 처리는/);
  assert.match(t, /끝나지 않았을 때만 다시/);
});

test("blockDiagText: 첫 차단·앞 이벤트(없음 포함)·대상 상태·닿은 요소·이유·이름(60자)", () => {
  assert.equal(
    blockDiagText("다른 요소에 닿음", fb({ hit: { tag: "li", role: "option" } }), "올림픽공원"),
    "첫 차단 mousedown(앞: pointerdown) · 대상 연결 끊김 · 닿은 요소 li[option] · 이유 다른 요소에 닿음 · 대상 '올림픽공원'",
  );
  const first = blockDiagText("다른 요소에 닿음", fb({ event: "pointerdown", seenBefore: [], targetConnected: false }), "가");
  assert.match(first, /첫 차단 pointerdown\(앞: 없음\)/);
  assert.match(blockDiagText("r", fb({ targetConnected: true, targetShown: false, hit: null }), "가"), /대상 연결됨·숨겨짐 · 닿은 요소 없음/);
  assert.match(blockDiagText("r", fb({ targetConnected: true, targetShown: true }), "가"), /대상 연결됨·보임/);
  assert.match(blockDiagText("r", undefined, "가"), /^첫 차단 정보 없음 · 이유 r · 대상 '가'$/);
  const long = blockDiagText("r", fb(), "가".repeat(80));
  assert.ok(long.endsWith(`'${"가".repeat(59)}…'`));
});

test("roleToken: 구조 토큰 꼴만(소문자 낱말, 40자 안)", () => {
  assert.equal(roleToken("option"), "option");
  assert.equal(roleToken("menuitem radio"), "menuitem radio");
  assert.equal(roleToken("Option"), undefined);
  assert.equal(roleToken("서울 선택"), undefined);
  assert.equal(roleToken("a".repeat(41)), undefined);
  assert.equal(roleToken(null), undefined);
  assert.equal(roleToken(""), undefined);
});
