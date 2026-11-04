// 빌드한 확장 폴더의 manifest.json을 검사한다(웹 스토어 제출 조건, CI·릴리스에서 실행).
// 사용: node scripts/checkManifest.mjs <폴더> [--google] [--no-maps] [--version X.X.XX]
//   --google   identity 권한과 oauth2.client_id가 둘 다 있어야 한다(없으면 둘 다 없어야 한다)
//   --no-maps  폴더에 .map 파일이 없고 web_accessible_resources에도 .map이 없어야 한다
//   --version  manifest version이 이 값과 같아야 한다
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--version");
if (!dir) {
  console.error("사용: node scripts/checkManifest.mjs <폴더> [--google] [--no-maps] [--version X.X.XX]");
  process.exit(2);
}
const wantGoogle = args.includes("--google");
const noMaps = args.includes("--no-maps");
const vi = args.indexOf("--version");
const wantVersion = vi >= 0 ? args[vi + 1] : null;

const errors = [];
const manifestPath = path.join(dir, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`${manifestPath}가 없습니다(폴더 최상위에 manifest.json이 있어야 합니다).`);
  process.exit(1);
}
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const perms = m.permissions ?? [];

if (perms.includes("activeTab")) errors.push("activeTab 권한이 있습니다(<all_urls>로 충분).");
const hasIdentity = perms.includes("identity");
const hasOauth = !!m.oauth2?.client_id;
if (wantGoogle) {
  if (!hasIdentity || !hasOauth) errors.push(`Google 빌드인데 identity(${hasIdentity})·oauth2(${hasOauth})가 둘 다 있지 않습니다.`);
} else if (hasIdentity || hasOauth) {
  errors.push(`Google 연동 없는 빌드인데 identity(${hasIdentity})·oauth2(${hasOauth})가 있습니다.`);
}
if (wantVersion && m.version !== wantVersion) errors.push(`manifest version ${m.version} ≠ ${wantVersion}`);

// web_accessible_resources는 두지 않는다(#215 — 웹 페이지가 고정 주소로 설치 여부를 알 수 있다). content script는 한 파일로 묶는다.
if ((m.web_accessible_resources ?? []).some((w) => (w.resources ?? []).length)) {
  errors.push("web_accessible_resources가 있습니다(content script를 한 파일로 묶어 웹 접근 가능한 파일이 없어야 합니다).");
}
// content_scripts의 파일은 있어야 하고, 다른 조각을 불러오지 않는 한 파일이어야 한다(동적 import·모듈 문이 없음 — 빌드 산출물 검사).
for (const cs of m.content_scripts ?? []) {
  for (const js of cs.js ?? []) {
    const file = path.join(dir, js);
    if (!fs.existsSync(file)) {
      errors.push(`content script 파일이 없습니다: ${js}`);
      continue;
    }
    const code = fs.readFileSync(file, "utf8");
    if (/\bimport\s*\(/.test(code) || /^\s*(import|export)\s/m.test(code)) errors.push(`content script가 다른 조각을 불러옵니다(한 파일이 아님): ${js}`);
  }
}

// web_accessible_resources가 가리키는 파일은 모두 있어야 한다.
for (const war of m.web_accessible_resources ?? []) {
  for (const r of war.resources ?? []) {
    if (noMaps && r.endsWith(".map")) errors.push(`web_accessible_resources에 소스 맵: ${r}`);
    else if (!r.includes("*") && !fs.existsSync(path.join(dir, r))) errors.push(`web_accessible_resources의 파일이 없습니다: ${r}`);
  }
}
if (noMaps) {
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) if (f.endsWith(".map")) errors.push(`소스 맵 파일: ${path.relative(dir, f)}`);
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(`✓ ${manifestPath} (v${m.version}, 권한 ${perms.length}개${wantGoogle ? ", Google" : ""}${noMaps ? ", 맵 없음" : ""})`);
