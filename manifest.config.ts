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
  description: "OpenRouter 기반 Chrome Side Panel 채팅 에이전트. 페이지 번역, 폼 자동 채우기, 이미지 일괄 다운로드.",
  version: "0.2.22",
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
    // read_document 변환을 강제 종료할 수 있는 Worker에서 돌리기 위한 offscreen 문서.
    "offscreen",
    // read_document가 리다이렉트를 따라가지 않을 때 목적지 주소를 알려 주려고 응답 헤더를 관찰한다.
    "webRequest",
    // 실제 입력 클릭(0.2.0, 설정에서 켤 때만 사용). Chrome은 debugger를 선택 권한(optional_permissions)으로 둘 수 없다.
    "debugger",
  ],
  // 자동 로그인의 KeePassXC 연결(native messaging). 설정에서 켤 때만 요청한다.
  optional_permissions: ["nativeMessaging"],
  host_permissions: ["<all_urls>"],
  // read_document의 문서 변환기(docling.rs-wasm)가 offscreen 문서의 Worker에서 WebAssembly를 쓴다. MV3는 'wasm-unsafe-eval'만 따로 허용할 수 있다.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
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
