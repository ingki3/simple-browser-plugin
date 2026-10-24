import test from "node:test";
import assert from "node:assert/strict";

import { clickPoint, frameNeedsGuard, unguardedFrame } from "../src/lib/trustedClick.ts";

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
