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

navigator.serviceWorker.onmessage = (ev: MessageEvent) => {
  const job = ev.data as DocumentJob | HtmlExtractJob | null;
  const port = ev.ports[0];
  if (!port) return;
  if (job?.kind === "document_convert") runJob(job, port);
  else if (job?.kind === "html_extract") runHtmlJob(job, port);
};
