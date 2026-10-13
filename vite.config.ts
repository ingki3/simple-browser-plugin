import { defineConfig, transformWithEsbuild, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import fs from "node:fs";
import path from "node:path";
import manifest from "./manifest.config";
import { patchPdfWorker } from "./scripts/pdfjsWorkerPatch";

// pdf.js가 한·중·일 글꼴의 글자 코드를 해석할 때 읽는 표(약 1.6MB). 확장 안 pdfjs/cmaps/로 넣는다.
function pdfjsCmaps(): Plugin {
  const dir = path.resolve(__dirname, "node_modules/pdfjs-dist/cmaps");
  return {
    name: "pdfjs-cmaps",
    apply: "build",
    generateBundle() {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".bcmap")) continue;
        this.emitFile({ type: "asset", fileName: `pdfjs/cmaps/${name}`, source: fs.readFileSync(path.join(dir, name)) });
      }
      this.emitFile({ type: "asset", fileName: "pdfjs/cmaps/LICENSE", source: fs.readFileSync(path.join(dir, "LICENSE")) });
    },
  };
}

// pdf.js 워커(legacy 빌드)에 압축 해제 한도를 넣어 pdfjs/pdf.worker.mjs로 넣는다(scripts/pdfjsWorkerPatch.ts).
function pdfjsWorker(): Plugin {
  const file = path.resolve(__dirname, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs");
  return {
    name: "pdfjs-worker",
    apply: "build",
    async generateBundle() {
      const patched = patchPdfWorker(fs.readFileSync(file, "utf8"));
      const { code } = await transformWithEsbuild(patched, "pdf.worker.mjs", { minify: true, format: "esm", legalComments: "inline" });
      this.emitFile({ type: "asset", fileName: "pdfjs/pdf.worker.mjs", source: code });
    },
  };
}

export default defineConfig({
  plugins: [react(), crx({ manifest }), pdfjsCmaps(), pdfjsWorker()],
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
