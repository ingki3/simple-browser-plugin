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
