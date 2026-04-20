import { defineManifest } from "@crxjs/vite-plugin";

// Google Workspace 통합(Sheets/Docs/Drive)을 쓰려면 여기에 client_id만 붙여넣고
// 다시 빌드·재설치하세요. 비워두면 해당 기능만 비활성화됩니다.
// - Google Cloud 콘솔 → 사용자 인증 정보 → OAuth 클라이언트 ID
// - 애플리케이션 유형: "Chrome 확장 프로그램"
// - Application ID 에는 chrome://extensions 에서 확인한 확장 ID 입력
// - redirect URI 등록 불필요 (Chrome이 내부적으로 처리)
// 값은 비밀이 아닙니다 — Application ID와 묶여 있어 다른 확장은 사용 불가.
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
];

export default defineManifest({
  manifest_version: 3,
  name: "간편 브라우저 도우미",
  description: "Gemini 기반 Chrome Side Panel 채팅 에이전트. 페이지 번역, 폼 자동 채우기, 이미지 일괄 다운로드.",
  version: "0.1.0",
  action: {
    default_title: "간편 도우미 열기",
  },
  side_panel: {
    default_path: "src/sidepanel/index.html",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: true,
    },
  ],
  permissions: [
    "sidePanel",
    "storage",
    "scripting",
    "activeTab",
    "downloads",
    "tabs",
    "alarms",
    "webNavigation",
    "identity",
  ],
  host_permissions: ["<all_urls>"],
  minimum_chrome_version: "116",
  ...(GOOGLE_OAUTH_CLIENT_ID
    ? {
        oauth2: {
          client_id: GOOGLE_OAUTH_CLIENT_ID,
          scopes: GOOGLE_SCOPES,
        },
      }
    : {}),
});
