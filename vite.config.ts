import { build as viteBuild, defineConfig, transformWithEsbuild, type Plugin, type Rollup } from "vite";
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

const ALIAS = {
  "@": path.resolve(__dirname, "src"),
  // HWP·HWPX 변환기. kordoc를 브라우저용으로 묶은 결과물(vendor/kordoc/README.md 참고).
  "kordoc-hwp": path.resolve(__dirname, "vendor/kordoc/dist/kordoc-hwp.js"),
};
const SOURCEMAP = process.env.SBP_SOURCEMAP !== "off";

// content script를 한 파일(IIFE)로 묶는다(#215). crxjs의 content script loader는 본체를 import(chrome.runtime.getURL(…))로 불러와
// 그 조각들이 web_accessible_resources(<all_urls>)에 들어가고, 웹 페이지가 고정 주소를 불러 보아 이 확장의 설치 여부를 알 수 있다.
// 빌드가 끝나면(crxjs가 manifest를 쓴 뒤) content script만 따로 IIFE 한 파일로 빌드해 manifest의 content_scripts가 그 파일을 가리키게 하고,
// content script용 web_accessible_resources와 loader를 지운다. 프로그램 주입(getContentScriptFiles)도 manifest의 같은 파일을 쓴다.
// 개발 서버(crx HMR)에는 적용하지 않는다.
const CONTENT_FILE = "content.js";
// 같은 문서·같은 isolated world에서 다시 실행되면(설치 전 열린 탭에 주입하는 경로의 중복·동시 주입, allFrames 주입) 아무것도 다시 만들지
// 않는다 — 리스너·대상 레지스트리·승인 상태가 하나로 남는다. Symbol 키라 페이지의 요소 id(window 이름 접근)와 겹치지 않는다.
// 초기화 횟수(sbp.content.inits)도 isolated world에만 남긴다(하네스가 한 번만 초기화됐는지 본다).
const CONTENT_GUARD =
  'if (!globalThis[Symbol.for("sbp.content.loaded")]) { globalThis[Symbol.for("sbp.content.loaded")] = true; globalThis[Symbol.for("sbp.content.inits")] = (globalThis[Symbol.for("sbp.content.inits")] || 0) + 1;';
function contentScriptBundle(): Plugin {
  let outDir = path.resolve(__dirname, "dist");
  return {
    name: "content-script-bundle",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const result = await viteBuild({
        configFile: false,
        logLevel: "warn",
        resolve: { alias: ALIAS },
        build: {
          target: "es2022",
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          sourcemap: SOURCEMAP,
          lib: { entry: path.resolve(__dirname, "src/content/index.ts"), formats: ["iife"], name: "__sbpContent", fileName: () => CONTENT_FILE },
          rollupOptions: { output: { inlineDynamicImports: true, banner: CONTENT_GUARD, footer: "}" } },
        },
      });
      // 한 파일이고, 다른 조각을 불러오지 않아야 한다(불러오면 그 조각이 웹 접근 가능해야 해서 이 작업의 뜻이 없어진다).
      const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
      const chunks = outputs.flatMap((o) => o.output).filter((o): o is Rollup.OutputChunk => o.type === "chunk");
      if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
        throw new Error(`content script가 한 파일로 묶이지 않았습니다(조각 ${chunks.length}개, import ${chunks[0]?.imports.length ?? 0}, 동적 import ${chunks[0]?.dynamicImports.length ?? 0}).`);
      }
      const manifestPath = path.join(outDir, "manifest.json");
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        content_scripts?: Array<{ js?: string[] }>;
        web_accessible_resources?: Array<{ resources?: string[] }>;
      };
      const loaders = new Set<string>();
      for (const cs of m.content_scripts ?? []) {
        for (const js of cs.js ?? []) loaders.add(js);
        cs.js = [CONTENT_FILE];
      }
      // crxjs가 content script용으로 만든 항목(빌드 조각만 가리킴)을 지운다. 다른 이유의 항목이 생기면 그대로 둔다.
      const war = (m.web_accessible_resources ?? []).filter((w) => !(w.resources ?? []).every((r) => r.startsWith("assets/")));
      if (war.length) m.web_accessible_resources = war;
      else delete m.web_accessible_resources;
      fs.writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
      for (const loader of loaders) {
        fs.rmSync(path.join(outDir, loader), { force: true });
        fs.rmSync(path.join(outDir, `${loader}.map`), { force: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets(), react(), crx({ manifest }), contentScriptBundle()],
  resolve: {
    alias: ALIAS,
  },
  build: {
    target: "es2022",
    // 릴리스는 SBP_SOURCEMAP=off로 맵 없이 빌드한다(웹 스토어 ZIP·web_accessible_resources에 .map이 남지 않게).
    sourcemap: SOURCEMAP,
    rollupOptions: {
      // manifest에 적지 않는 페이지. offscreen: read_document가 chrome.offscreen으로 연다. mic: 음성 입력의 마이크 권한 받기(#184).
      input: { offscreen: "src/offscreen/index.html", mic: "src/mic/index.html" },
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
