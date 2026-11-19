// Google 연동(Sheets·Docs·Drive)의 manifest 조각. 클라이언트 ID가 있는 빌드에서만 identity 권한과 oauth2를 함께 넣는다
// (웹 스토어 최소 권한 — 기본 릴리스는 Google 연동이 꺼져 있어 identity를 쓰지 않는다). manifest.config.ts가 이 결과를 그대로 쓴다.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

export interface GoogleManifestParts {
  permissions: string[];
  oauth2?: { client_id: string; scopes: string[] };
}

export function googleManifestParts(clientId: string): GoogleManifestParts {
  const id = clientId.trim();
  if (!id) return { permissions: [] };
  return { permissions: ["identity"], oauth2: { client_id: id, scopes: [...GOOGLE_SCOPES] } };
}

// 선택 권한 목록. 카카오톡 나에게 보내기(#310)의 로그인 창(chrome.identity.launchWebAuthFlow)에 identity가 필요하다 — Google 연동 빌드처럼
// 이미 필수 권한에 있으면 넣지 않는다(같은 권한이 필수·선택에 함께 있지 않게).
export function optionalPermissions(base: readonly string[], google: GoogleManifestParts): string[] {
  const out = [...base];
  if (!google.permissions.includes("identity") && !out.includes("identity")) out.push("identity");
  return out;
}
