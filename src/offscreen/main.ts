// read_document 변환 전용 offscreen 문서. 서비스 워커는 Worker를 만들 수 없어서 여기서 만든다.
// 작업마다 새 Worker에서 변환하고, 시간 초과·중단 요청이 오면 terminate()로 바로 끝내 메모리를 돌려받는다.
import doclingWasmUrl from "docling.rs-wasm/web/docling_wasm_bg.wasm?url";
import {
  CONVERT_TIMEOUT_MS,
  type DocumentJob,
  type DocumentJobResult,
  type HtmlExtractJob,
  type HtmlExtractResult,
  type WorkerJob,
} from "@/lib/documentJob";
import { extractParsedDocument } from "@/content/extract";
import type { StitchJob, StitchReleaseJob, StitchResult } from "@/lib/pageCapture";

// docling wasm(약 15MB)은 한 번만 컴파일하고 모듈을 Worker에 넘긴다.
let compiled: Promise<WebAssembly.Module> | null = null;
// 서비스 워커가 문서를 닫기 전에 종료되면 닫는 타이머도 사라진다. 그래도 컴파일한 모듈은 놓아 메모리를 돌려준다.
const MODULE_IDLE_MS = 60_000;
let activeJobs = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function doclingModule(): Promise<WebAssembly.Module> {
  if (!compiled) {
    compiled = WebAssembly.compileStreaming(fetch(doclingWasmUrl)).catch((err: unknown) => {
      compiled = null;
      throw err;
    });
  }
  return compiled;
}

function runJob(job: DocumentJob, port: MessagePort): void {
  activeJobs++;
  if (idleTimer) clearTimeout(idleTimer);
  const worker = new Worker(new URL("./convert.worker.ts", import.meta.url), { type: "module" });
  let done = false;
  const finish = (result: DocumentJobResult) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    worker.terminate();
    port.postMessage(result);
    port.close();
    if (--activeJobs === 0) {
      idleTimer = setTimeout(() => {
        if (activeJobs === 0) compiled = null;
      }, MODULE_IDLE_MS);
    }
  };
  const timer = setTimeout(() => finish({ ok: false, kind: "timeout" }), CONVERT_TIMEOUT_MS);
  port.onmessage = (ev: MessageEvent) => {
    if ((ev.data as { kind?: string } | null)?.kind === "cancel") finish({ ok: false, kind: "cancelled" });
  };
  worker.onmessage = (ev: MessageEvent<DocumentJobResult>) => {
    // 변환기 라이브러리가 Worker 전역으로 보내는 다른 메시지를 결과로 착각하지 않는다.
    if (typeof (ev.data as { ok?: unknown } | null)?.ok !== "boolean") return;
    finish(ev.data);
  };
  worker.onerror = (ev: ErrorEvent) => {
    ev.preventDefault();
    finish({ ok: false, kind: "crashed", message: ev.message || "변환기 Worker 오류" });
  };
  // docling wasm은 docling으로 변환하는 형식(Office·OpenDocument)에만 컴파일한다.
  const loaded = job.engine === "docling" ? doclingModule() : Promise.resolve(null);
  loaded.then(
    (module) => {
      if (done) return;
      const { kind: _kind, ...rest } = job;
      const workerJob: WorkerJob = { ...rest, module };
      worker.postMessage(workerJob, [job.bytes]);
    },
    (err: unknown) => finish({ ok: false, kind: "crashed", message: `변환기를 불러오지 못했습니다: ${String(err)}` }),
  );
}

// 기사 HTML 본문 추출. DOMParser 문서는 스크립트를 실행하지 않고 하위 자원을 요청하지 않으며(실측),
// 이 페이지의 CSP도 외부 자원을 막는다. 파싱한 노드를 이 문서에 넣지 않는다. 동기 처리라 중간 취소는 없고,
// 서비스 워커가 취소한 작업의 결과는 그쪽에서 버린다.
function runHtmlJob(job: HtmlExtractJob, port: MessagePort): void {
  let result: HtmlExtractResult;
  try {
    const doc = new DOMParser().parseFromString(job.html, "text/html");
    result = { ok: true, ...extractParsedDocument(doc, job.maxChars) };
  } catch (err) {
    result = { ok: false, kind: "failed", message: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(result);
  port.close();
}

// 페이지 전체 캡처(#49)의 이어 붙이기. 조각마다 캔버스를 하나씩 만들어 그 조각에 걸친 화면만 디코드해 그리고,
// PNG로 만든 뒤 캔버스를 놓는다(한 번에 하나의 조각만 메모리에 둔다). 결과는 이 문서의 blob: 주소로 돌려주며,
// 서비스 워커가 저장을 마치면 놓는다(놓지 않아도 일정 시간 뒤 스스로 놓는다).
const STITCH_URL_TTL_MS = 5 * 60_000;
const stitchUrls = new Set<string>();

function releaseStitchUrls(urls: readonly string[]): void {
  for (const url of urls) {
    if (stitchUrls.delete(url)) URL.revokeObjectURL(url);
  }
}

async function runStitchJob(job: StitchJob, port: MessagePort): Promise<void> {
  let cancelled = false;
  port.onmessage = (ev: MessageEvent) => {
    if ((ev.data as { kind?: string } | null)?.kind === "cancel") cancelled = true;
  };
  const parts: Array<{ url: string; bytes: number; width: number; height: number }> = [];
  try {
    const { plan } = job;
    for (const part of plan.parts) {
      if (cancelled) throw new Error("cancelled");
      const canvas = new OffscreenCanvas(plan.width, part.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("캔버스를 만들지 못함");
      for (const d of part.draws) {
        if (cancelled) throw new Error("cancelled");
        const bmp = await createImageBitmap(job.tiles[d.tile]);
        try {
          // 화면 이미지의 배율(장치 px / CSS px)은 이미지 폭으로 구한다(스크롤 막대 포함 폭 = windowWidth).
          // 세로 스크롤 막대(viewportWidth 오른쪽)는 잘라 낸다.
          const k = bmp.width / job.windowWidth;
          ctx.drawImage(bmp, 0, d.srcY * k, job.viewportWidth * k, d.srcHeight * k, 0, d.destY, plan.width, d.destHeight);
        } finally {
          bmp.close();
        }
      }
      const blob = await canvas.convertToBlob({ type: "image/png" });
      canvas.width = 0;
      canvas.height = 0;
      const url = URL.createObjectURL(blob);
      stitchUrls.add(url);
      setTimeout(() => releaseStitchUrls([url]), STITCH_URL_TTL_MS);
      parts.push({ url, bytes: blob.size, width: plan.width, height: part.height });
    }
    port.postMessage({ ok: true, parts } satisfies StitchResult);
  } catch (err) {
    releaseStitchUrls(parts.map((p) => p.url));
    if (!cancelled) console.warn("[capture_page] stitch failed", err);
    port.postMessage({ ok: false, kind: cancelled ? "cancelled" : "failed" } satisfies StitchResult);
  }
  port.close();
}

navigator.serviceWorker.onmessage = (ev: MessageEvent) => {
  const job = ev.data as DocumentJob | HtmlExtractJob | StitchJob | StitchReleaseJob | null;
  const port = ev.ports[0];
  if (!port) return;
  if (job?.kind === "document_convert") runJob(job, port);
  else if (job?.kind === "html_extract") runHtmlJob(job, port);
  else if (job?.kind === "capture_stitch") void runStitchJob(job, port);
  else if (job?.kind === "capture_release") {
    releaseStitchUrls(job.urls);
    port.postMessage({ ok: true });
    port.close();
  }
};
