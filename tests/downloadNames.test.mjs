import { test } from "node:test";
import assert from "node:assert/strict";
import { DownloadNameHints } from "../src/lib/downloadNames.ts";

const U = "https://a.com/f.pdf";
const V = "https://a.com/g.pdf";

test("id가 먼저 오면 그 id로 묶은 힌트를 쓴다", () => {
  const h = new DownloadNameHints();
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  h.endStart(U, 10);
  assert.deepEqual(h.claim(10, U), { run: 1, folder: "A", index: 0 });
  // 한 번 쓴 힌트는 다시 쓰지 않는다.
  assert.equal(h.claim(10, U), null);
  assert.equal(h.size, 0);
});

test("download()가 id를 돌려주기 전에 이벤트가 오면 시작 중인 그 주소의 것으로 보고, 다시 묶지 않는다", () => {
  const h = new DownloadNameHints();
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  assert.deepEqual(h.claim(10, U), { run: 1, folder: "A", index: 0 });
  h.endStart(U, 10);
  assert.equal(h.claim(10, U), null);
  assert.equal(h.size, 0);
});

test("다른 주소의 시작은 동시에 있어도 주소로 구분한다", () => {
  const h = new DownloadNameHints();
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  h.beginStart(V, { run: 2, folder: "B", index: 3 });
  assert.deepEqual(h.claim(21, V), { run: 2, folder: "B", index: 3 });
  assert.deepEqual(h.claim(20, U), { run: 1, folder: "A", index: 0 });
});

test("같은 주소를 두 실행이 다른 폴더로 받아도 한쪽이 끝나며 다른 쪽 힌트를 지우지 않는다", () => {
  const h = new DownloadNameHints();
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  h.endStart(U, 10);
  h.beginStart(U, { run: 2, folder: "B", index: 0 });
  h.endStart(U, 11);
  // A가 먼저 끝남(자기 id만 정리). B의 id를 넘겨도 소유자가 아니면 지우지 않는다.
  h.forget(1, [10, 11]);
  assert.deepEqual(h.claim(11, U), { run: 2, folder: "B", index: 0 });
  assert.equal(h.claim(10, U), null);
});

test("이 확장이 힌트 없이 시작한 내려받기(이미지)와 다른 주소의 내려받기는 가져가지 않는다", () => {
  const h = new DownloadNameHints();
  h.noteOther(5);
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  assert.equal(h.claim(5, U), null);
  assert.equal(h.claim(6, "https://a.com/other.pdf"), null);
  assert.deepEqual(h.claim(7, U), { run: 1, folder: "A", index: 0 });
});

test("시작이 실패하면 힌트를 남기지 않는다", () => {
  const h = new DownloadNameHints();
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  h.endStart(U, null);
  assert.equal(h.size, 0);
  assert.equal(h.claim(3, U), null);
});

test("받는 중인 내려받기의 힌트는 실행이 끝나도 남아 늦게 오는 이름 정하기에 쓰인다", () => {
  const h = new DownloadNameHints();
  h.beginStart(U, { run: 1, folder: "A", index: 0 });
  h.endStart(U, 10);
  h.forget(1, []);
  assert.deepEqual(h.claim(10, U), { run: 1, folder: "A", index: 0 });
});
