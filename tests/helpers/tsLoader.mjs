// 단위 시험용 TS 해석 훅(#263 단계 0): `npm test`는 Node 타입 제거로 .ts를 바로 불러오지만, 확장자 없는 import와 `@/` 별칭은
// 해석하지 못한다. 이 파일을 먼저 import하면(부수 효과) 그 뒤 동적 import로 부르는 src/ 모듈의 그런 import를 .ts·.tsx·/index.ts로 잇는다.
//   import "./helpers/tsLoader.mjs";
//   const mod = await import("../src/background/actionLog.ts");
// 정적 import는 훅 등록보다 먼저 해석되므로 src/ 모듈은 반드시 동적 import로 부른다. 파일 이름이 *.test.mjs가 아니라 npm test가 직접 돌리지 않는다.
// Node 버전 의존: module.register(Node 20.6+ / 22)와 --experimental-strip-types(Node 22.6+)에 기댄다(#257 기록).
import { register } from "node:module";

const SRC = new URL("../../src/", import.meta.url).href;
const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const SRC = ${JSON.stringify(SRC)};
const EXTS = [".ts", ".tsx", "/index.ts"];
export async function resolve(spec, ctx, next) {
  let url = null;
  if (spec.startsWith("@/")) url = new URL(spec.slice(2), SRC).href;
  else if ((spec.startsWith("./") || spec.startsWith("../")) && ctx.parentURL?.startsWith(SRC)) url = new URL(spec, ctx.parentURL).href;
  if (url && !/\\.(ts|tsx|mjs|js|json)$/.test(url)) {
    for (const e of EXTS) if (existsSync(fileURLToPath(url + e))) { url = url + e; break; }
  }
  return next(url ?? spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);
