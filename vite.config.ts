import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // manifest에 적지 않는 페이지. read_document가 chrome.offscreen으로 연다.
      input: { offscreen: "src/offscreen/index.html" },
    },
  },
  // offscreen 문서의 변환 Worker가 모듈 import를 쓴다.
  worker: { format: "es" },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5174 },
  },
});
