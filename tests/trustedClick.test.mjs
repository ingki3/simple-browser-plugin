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
