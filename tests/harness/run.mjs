// 하네스 실행기: `npm run harness [이름 일부]`. 빌드한 dist가 있어야 한다(먼저 npm run build).
// Chrome for Testing이나 playwright-core가 없으면 건너뛴다(종료 코드 0, 안내만). HARNESS_REQUIRED=1(CI)이면 실패로 끝낸다.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXT, Fail, findChrome, startHarness } from "./lib.mjs";

const filter = process.argv.slice(2).join(" ");
const here = dirname(fileURLToPath(import.meta.url));

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error(`dist가 없습니다(${EXT}). 먼저 npm run build.`);
  process.exit(1);
}
if (!findChrome()) {
  const msg = "Chrome for Testing을 찾지 못했습니다. HARNESS_CHROME에 실행 파일 경로를 주거나 `npx playwright-core install chromium`.";
  if (process.env.HARNESS_REQUIRED) {
    console.error(`${msg} (HARNESS_REQUIRED라 실패로 끝냅니다)`);
    process.exit(1);
  }
  console.log(`${msg} 하네스를 건너뜁니다.`);
  process.exit(0);
}

const files = readdirSync(join(here, "scenarios")).filter((f) => f.endsWith(".mjs")).sort();
const all = [];
for (const f of files) {
  const mod = await import(pathToFileURL(join(here, "scenarios", f)).href);
  for (const s of mod.default) all.push({ group: f.replace(/\.mjs$/, ""), ...s });
}
const chosen = all.filter((s) => !filter || `${s.group} ${s.name}`.includes(filter));
if (!chosen.length) {
  console.error(`'${filter}'에 맞는 시나리오가 없습니다.`);
  process.exit(1);
}

const h = await startHarness();
const rows = [];
for (const s of chosen) {
  h.pages.clear();
  for (const [path, html] of Object.entries(s.pages ?? {})) h.pages.set(`1${path}`, html);
  for (const [path, html] of Object.entries(s.pages2 ?? {})) h.pages.set(`2${path}`, html);
  const t0 = Date.now();
  let status = "PASS";
  let detail = "";
  try {
    await h.reset();
    await s.run(h);
  } catch (err) {
    status = err instanceof Fail ? "FAIL" : "ERROR";
    detail = err instanceof Error ? err.message : String(err);
  }
  rows.push({ group: s.group, name: s.name, status, ms: Date.now() - t0, detail });
  console.log(`${status === "PASS" ? "✓" : "✗"} [${s.group}] ${s.name} (${Date.now() - t0}ms)${detail ? `\n    ${detail}` : ""}`);
}
await h.close();

const failed = rows.filter((r) => r.status !== "PASS");
console.log(`\n${rows.length}개 중 ${rows.length - failed.length}개 통과${failed.length ? `, ${failed.length}개 실패` : ""}`);
process.exit(failed.length ? 1 : 0);
