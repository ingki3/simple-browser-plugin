// kordoc(Node용)를 브라우저 module Worker에서 돌 수 있게 묶는다. 결과: dist/kordoc-hwp.js
// Node 내장 모듈은 shims/로 바꾸고, HWP 읽기에 쓰지 않는 선택 의존성(OCR·PDF·MCP 등)은 빈 모듈로 둔다.
import { build } from "esbuild";
import { copyFile, readFile, writeFile } from "node:fs/promises";

const here = (p) => new URL(p, import.meta.url).pathname;
const stub = here("./shims/stub.mjs");
const nodeBuiltins = ["fs", "fs/promises", "path", "os", "url", "child_process", "worker_threads", "crypto", "module", "stream", "stream/promises", "events", "util", "readline/promises", "process", "http", "https", "dns/promises"];
const escape = (s) => s.replace(/[/]/g, "\\/");

const result = await build({
  entryPoints: [here("./entry.mjs")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  // 디버깅할 때는 NOMIN=1 node build.mjs
  minify: !process.env.NOMIN,
  legalComments: "eof",
  outfile: here("./dist/kordoc-hwp.js"),
  metafile: true,
  logLimit: 0,
  plugins: [
    {
      name: "kordoc-browser-patch",
      setup(b) {
        // jszip의 nodeStream은 브라우저에서 지원되지 않는다. 같은 이벤트를 내는 internalStream으로 바꾼다.
        b.onLoad({ filter: /kordoc\/dist\/.*\.js$/ }, async (a) => {
          const code = await readFile(a.path, "utf8");
          const patched = code.replaceAll(
            'file.nodeStream("nodebuffer")',
            '((s) => (queueMicrotask(() => s.resume()), s))(file.internalStream("uint8array"))',
          );
          return { contents: patched, loader: "js", resolveDir: new URL(".", "file://" + a.path).pathname };
        });
      },
    },
    {
      name: "node-shims",
      setup(b) {
        b.onResolve({ filter: /^pdfjs-dist(\/.*)?$/ }, () => ({ path: here("./shims/pdfjs.mjs") }));
        b.onResolve(
          { filter: /^(onnxruntime-node|onnxruntime-web|sharp|@huggingface\/transformers|@hyzyla\/pdfium|puppeteer-core|@modelcontextprotocol\/sdk|commander)(\/.*)?$/ },
          () => ({ path: stub }),
        );
        b.onResolve({ filter: /^(node:)?buffer$/ }, () => ({ path: here("./node_modules/buffer/index.js") }));
        b.onResolve({ filter: /^(node:)?zlib$/ }, () => ({ path: here("./shims/zlib.mjs") }));
        b.onResolve({ filter: new RegExp(`^(node:)?(${nodeBuiltins.map(escape).join("|")})$`) }, () => ({ path: stub }));
      },
    },
  ],
  inject: [here("./shims/globals.mjs")],
  define: { "process.env.NODE_ENV": '"production"' },
});

const inputs = Object.entries(result.metafile.inputs).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10);
for (const [k, v] of inputs) console.log(`${(v.bytes / 1024).toFixed(0)}KB  ${k}`);
const out = await readFile(here("./dist/kordoc-hwp.js"));
console.log(`dist/kordoc-hwp.js ${(out.byteLength / 1024).toFixed(0)}KB`);
await copyFile(here("./node_modules/kordoc/LICENSE"), here("./dist/LICENSE.kordoc"));
await copyFile(here("./node_modules/kordoc/NOTICE"), here("./dist/NOTICE.kordoc"));
await writeFile(here("./dist/VERSION"), `kordoc ${JSON.parse(await readFile(here("./node_modules/kordoc/package.json"), "utf8")).version}\n`);
