import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import fs from "node:fs";
import path from "node:path";
import manifest from "./manifest.config";
import { patchPdfWorker } from "./scripts/pdfjsWorkerPatch";

// pdf.js 자원을 public/pdfjs/에 만든다(생성물, git 제외). 개발 서버(crx)와 빌드 모두 public/을 확장에 넣는다.
// - pdf.worker.mjs: 압축 해제 한도를 넣은 pdf.js 워커(legacy 빌드, scripts/pdfjsWorkerPatch.ts)
// - cmaps/: 한·중·일 글꼴의 글자 코드를 해석할 때 읽는 표(약 1.6MB)
function pdfjsAssets(): Plugin {
  const pkg = path.resolve(__dirname, "node_modules/pdfjs-dist");
  const out = path.resolve(__dirname, "public/pdfjs");
  return {
    name: "pdfjs-assets",
    async config() {
      const source = fs.readFileSync(path.join(pkg, "legacy/build/pdf.worker.mjs"), "utf8");
      const { code } = await transformWithEsbuild(patchPdfWorker(source), "pdf.worker.mjs", {
        minify: true,
        format: "esm",
        legalComments: "inline",
      });
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(path.join(out, "cmaps"), { recursive: true });
      fs.writeFileSync(path.join(out, "pdf.worker.mjs"), code);
      for (const name of fs.readdirSync(path.join(pkg, "cmaps"))) {
        fs.copyFileSync(path.join(pkg, "cmaps", name), path.join(out, "cmaps", name));
      }
      fs.copyFileSync(path.join(pkg, "LICENSE"), path.join(out, "LICENSE"));
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets(), react(), crx({ manifest })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // HWP·HWPX 변환기. kordoc를 브라우저용으로 묶은 결과물(vendor/kordoc/README.md 참고).
      "kordoc-hwp": path.resolve(__dirname, "vendor/kordoc/dist/kordoc-hwp.js"),
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
