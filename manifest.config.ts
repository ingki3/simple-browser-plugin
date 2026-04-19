import { defineManifest } from "@crxjs/vite-plugin";

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
  ],
  host_permissions: ["<all_urls>"],
  minimum_chrome_version: "116",
});
