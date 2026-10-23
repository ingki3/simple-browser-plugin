import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_LIMITS,
  captureBlockReason,
  captureFileName,
  nextTileY,
  planStitch,
  pngSize,
  scrollMoved,
  tileLeavesGap,
  tileSizeMatches,
  viewportChanged,
} from "../src/lib/pageCapture.ts";

test("캡처할 수 없는 탭은 주소 형태로 이유를 알린다", () => {
  for (const u of ["chrome://settings", "about:blank", "edge://newtab", "chrome-search://local-ntp", "view-source:https://a.com", "devtools://x"]) {
    assert.match(captureBlockReason(u), /내부 페이지/, u);
  }
  assert.match(captureBlockReason("chrome-extension://abc/x.html"), /확장/);
  assert.match(captureBlockReason("https://chromewebstore.google.com/detail/x"), /웹 스토어/);
  assert.match(captureBlockReason("https://chrome.google.com/webstore/detail/x"), /웹 스토어/);
  assert.match(captureBlockReason("data:text/html,hi"), /웹 페이지가 아닌/);
  assert.match(captureBlockReason(undefined), /알 수 없/);
  assert.match(captureBlockReason("not a url"), /알 수 없/);
  // 웹 스토어가 아닌 같은 호스트의 다른 경로·일반 사이트·파일은 시도한다.
  assert.equal(captureBlockReason("https://chrome.google.com/webstorefront"), null);
  assert.equal(captureBlockReason("https://example.com/a?b=1"), null);
  assert.equal(captureBlockReason("http://127.0.0.1:8080/"), null);
  assert.equal(captureBlockReason("file:///Users/a/b.html"), null);
});

test("다음 스크롤 위치: 화면 높이씩, 마지막은 끝에 맞추고, 다 담으면 null", () => {
  const vh = 800;
  const ys = [];
  let covered = 0;
  for (let y = 0; y !== null; y = nextTileY({ coveredBottom: covered, pageHeight: 2000, viewportHeight: vh })) {
    ys.push(y);
    covered = y + vh;
  }
  assert.deepEqual(ys, [0, 800, 1200]);
  // 화면보다 짧은 페이지는 한 장.
  assert.equal(nextTileY({ coveredBottom: 800, pageHeight: 600, viewportHeight: 800 }), null);
  // 상한에서 멈춘다(마지막 화면은 상한 끝에 맞춤).
  assert.equal(nextTileY({ coveredBottom: 19_500, pageHeight: 50_000, viewportHeight: 800 }), 19_200);
  assert.equal(nextTileY({ coveredBottom: 20_000, pageHeight: 50_000, viewportHeight: 800 }), null);
  assert.equal(nextTileY({ coveredBottom: 0, pageHeight: 1000, viewportHeight: 0 }), null);
  assert.equal(CAPTURE_LIMITS.maxPageHeight, 20_000);
});

test("이어 붙이기: 겹친 부분은 버리고 장치 px로 이어진다", () => {
  const plan = planStitch({ tiles: [0, 800, 1200], viewportWidth: 1000, viewportHeight: 800, totalHeight: 2000, scale: 2 });
  assert.equal(plan.width, 2000);
  assert.equal(plan.height, 4000);
  assert.equal(plan.parts.length, 1);
  assert.deepEqual(plan.parts[0].draws, [
    { tile: 0, srcY: 0, srcHeight: 800, destY: 0, destHeight: 1600 },
    { tile: 1, srcY: 0, srcHeight: 800, destY: 1600, destHeight: 1600 },
    // 마지막 화면(1200~2000)은 앞 화면이 담은 1200~1600을 버리고 1600~2000만.
    { tile: 2, srcY: 400, srcHeight: 400, destY: 3200, destHeight: 800 },
  ]);
  // 빈틈 없이 이어진다.
  let at = 0;
  for (const d of plan.parts[0].draws) {
    assert.equal(d.destY, at);
    at += d.destHeight;
  }
  assert.equal(at, plan.height);
});

test("이어 붙이기: 한 변·넓이 상한을 넘으면 여러 조각으로 나누고, 조각 경계에서 화면을 나눠 그린다", () => {
  const plan = planStitch({ tiles: [0, 1000, 2000], viewportWidth: 500, viewportHeight: 1000, totalHeight: 3000, scale: 1, maxPartSide: 1200 });
  assert.deepEqual(plan.parts.map((p) => [p.top, p.height]), [[0, 1200], [1200, 1200], [2400, 600]]);
  assert.deepEqual(plan.parts[0].draws, [
    { tile: 0, srcY: 0, srcHeight: 1000, destY: 0, destHeight: 1000 },
    { tile: 1, srcY: 0, srcHeight: 200, destY: 1000, destHeight: 200 },
  ]);
  assert.deepEqual(plan.parts[1].draws[0], { tile: 1, srcY: 200, srcHeight: 800, destY: 0, destHeight: 800 });
  // 넓이 상한: 폭 1000이면 조각 높이는 넓이/폭.
  const wide = planStitch({ tiles: [0], viewportWidth: 1000, viewportHeight: 900, totalHeight: 900, scale: 1, maxPartArea: 400_000 });
  assert.deepEqual(wide.parts.map((p) => p.height), [400, 400, 100]);
  for (const p of wide.parts) assert.ok(p.height * wide.width <= 400_000);
  // 폭이 한 변 상한을 넘으면 캡처할 수 없다.
  assert.equal(planStitch({ tiles: [0], viewportWidth: 9000, viewportHeight: 900, totalHeight: 900, scale: 2 }), null);
  // 상한 높이(20,000 CSS px)·DPR 2는 16,384 장치 px 넘어 여러 장.
  const tall = planStitch({ tiles: Array.from({ length: 25 }, (_, i) => i * 800), viewportWidth: 1280, viewportHeight: 800, totalHeight: 20_000, scale: 2 });
  assert.equal(tall.height, 40_000);
  assert.ok(tall.parts.length >= 3);
  for (const p of tall.parts) assert.ok(p.height <= CAPTURE_LIMITS.maxPartSide && p.height * tall.width <= CAPTURE_LIMITS.maxPartArea);
  assert.equal(tall.parts.reduce((n, p) => n + p.height, 0), 40_000);
});

test("이어 붙이기: 페이지가 스크롤을 덜 했으면(실제 위치) 그 위치로 겹침을 계산한다", () => {
  const plan = planStitch({ tiles: [0, 700], viewportWidth: 100, viewportHeight: 800, totalHeight: 1500, scale: 1.5 });
  assert.deepEqual(plan.parts[0].draws, [
    { tile: 0, srcY: 0, srcHeight: 800, destY: 0, destHeight: 1200 },
    { tile: 1, srcY: 100, srcHeight: 700, destY: 1200, destHeight: 1050 },
  ]);
});

test("저장 이름: 사이트와 시각, 전체·여러 장 표시. 경로·쿼리는 넣지 않는다", () => {
  const at = new Date(2026, 9, 3, 4, 5, 6);
  assert.equal(captureFileName("https://shop.example.com/a/b?q=secret", at, { fullPage: false }), "shop.example.com_20261003-040506.png");
  assert.equal(captureFileName("https://a.com/", at, { fullPage: true }), "a.com_20261003-040506_full.png");
  assert.equal(captureFileName("https://a.com/", at, { fullPage: true, part: 2, parts: 3 }), "a.com_20261003-040506_full-2.png");
  assert.equal(captureFileName("file:///Users/me/x.html", at, { fullPage: false }), "local-file_20261003-040506.png");
  assert.match(captureFileName("http://[::1]:8080/", at, { fullPage: false }), /^[A-Za-z0-9._-]+\.png$/);
  assert.equal(captureFileName("bad", at, { fullPage: false }), "page_20261003-040506.png");
  // 국제화 도메인은 URL 파서가 정규화한 punycode.
  assert.match(captureFileName("https://한국.kr/", at, { fullPage: false }), /^xn--3e0b707e\.kr_/);
});

test("PNG 크기 읽기", () => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(b.buffer).setUint32(16, 2560);
  new DataView(b.buffer).setUint32(20, 1440);
  assert.deepEqual(pngSize(b), { width: 2560, height: 1440 });
  assert.equal(pngSize(new Uint8Array(10)), null);
  assert.equal(pngSize(new Uint8Array(24)), null);
});

test("캡처 중 창 크기·배율 변경 감지", () => {
  const start = { viewportWidth: 1000, viewportHeight: 713, windowWidth: 1000, windowHeight: 713, scale: 2 };
  assert.equal(viewportChanged(start, { ...start }), false);
  assert.equal(viewportChanged(start, { ...start, viewportHeight: 600 }), true);
  assert.equal(viewportChanged(start, { ...start, windowHeight: 600 }), true);
  assert.equal(viewportChanged(start, { ...start, windowWidth: 900, viewportWidth: 900 }), true);
  assert.equal(viewportChanged(start, { ...start, scale: 1.5 }), true);
});

test("찍은 화면 크기: 첫 장 포함 모든 장의 폭·높이가 창 안쪽 크기 × 배율(±2px)", () => {
  const start = { viewportWidth: 1000, viewportHeight: 713, windowWidth: 1000, windowHeight: 713, scale: 2 };
  assert.equal(tileSizeMatches({ width: 2000, height: 1426 }, start), true);
  assert.equal(tileSizeMatches({ width: 2001, height: 1425 }, start), true);
  // 재고 나서 찍기 전에 창 높이·폭이 줄면 걸린다.
  assert.equal(tileSizeMatches({ width: 2000, height: 1200 }, start), false);
  assert.equal(tileSizeMatches({ width: 1800, height: 1426 }, start), false);
  const s15 = { ...start, scale: 1.5 };
  assert.equal(tileSizeMatches({ width: 1500, height: 1070 }, s15), true);
  assert.equal(tileSizeMatches({ width: 1500, height: 1060 }, s15), false);
});

test("찍는 사이 스크롤 위치 변화 감지", () => {
  assert.equal(scrollMoved({ x: 0, y: 800 }, { x: 0, y: 800 }), false);
  // 배율이 소수면 장치 px에 맞춘 0.33px 차이는 같은 위치.
  assert.equal(scrollMoved({ x: 0, y: 800.33 }, { x: 0, y: 800 }), false);
  assert.equal(scrollMoved({ x: 0, y: 800 }, { x: 0, y: 900 }), true);
  assert.equal(scrollMoved({ x: 0, y: 800 }, { x: 40, y: 800 }), true);
});

test("화면들이 빈 구간 없이 이어지는지: 첫 화면은 맨 위, 그 뒤는 담은 아래 끝 이하에서 시작", () => {
  assert.equal(tileLeavesGap({ y: 0, first: true, coveredBottom: 0 }), false);
  assert.equal(tileLeavesGap({ y: 0.33, first: true, coveredBottom: 0 }), false);
  // 이미지 로딩을 기다리는 사이 첫 위치가 800으로 바뀌면 위쪽이 빈다.
  assert.equal(tileLeavesGap({ y: 800, first: true, coveredBottom: 0 }), true);
  assert.equal(tileLeavesGap({ y: 713, first: false, coveredBottom: 713 }), false);
  // 마지막 화면은 끝에 맞춰 겹친다.
  assert.equal(tileLeavesGap({ y: 500, first: false, coveredBottom: 713 }), false);
  assert.equal(tileLeavesGap({ y: 900, first: false, coveredBottom: 713 }), true);
});
