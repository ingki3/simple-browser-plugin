import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// 버전 형식 X.X.XX: 주.부.수정, 수정 번호는 0~99. Chrome manifest는 0이 아닌 수의 앞자리 0을 허용하지 않아
// 0.1.03처럼 채우지 않는다(0.1.3 → … → 0.1.99 → 0.2.0).
const FORMAT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d?)$/;

test("버전: package.json·package-lock.json·manifest가 같고 X.X.XX 형식", () => {
  const pkg = JSON.parse(read("package.json")).version;
  const lock = JSON.parse(read("package-lock.json"));
  const manifest = read("manifest.config.ts").match(/\n\s*version:\s*"([^"]+)"/)?.[1];
  assert.match(pkg, FORMAT);
  assert.equal(lock.version, pkg);
  assert.equal(lock.packages[""].version, pkg);
  assert.equal(manifest, pkg);
});

test("권한: 방문 기록(history)은 선택 권한에만 있다(#175)", () => {
  const src = read("manifest.config.ts");
  const required = src.match(/\n\s*permissions:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  const optional = src.match(/\n\s*optional_permissions:\s*\[([^\]]*)\]/)?.[1] ?? "";
  assert.ok(!/"history"/.test(required), "필수 권한에 history가 없어야 한다");
  assert.ok(/"history"/.test(optional), "선택 권한에 history가 있어야 한다");
});
