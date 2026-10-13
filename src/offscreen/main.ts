// read_document 변환 전용 offscreen 문서. 서비스 워커는 Worker를 만들 수 없어서 여기서 만든다.
// 작업마다 새 Worker에서 변환하고, 시간 초과·중단 요청이 오면 terminate()로 바로 끝내 메모리를 돌려받는다.
import doclingWasmUrl from "docling.rs-wasm/web/docling_wasm_bg.wasm?url";
import { CONVERT_TIMEOUT_MS, type DocumentJob, type DocumentJobResult, type WorkerJob } from "@/lib/documentJob";

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
  // docling wasm은 docling으로 변환하는 형식(Office·OpenDocument·CSV)에만 컴파일한다.
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

navigator.serviceWorker.onmessage = (ev: MessageEvent) => {
  const job = ev.data as DocumentJob | null;
  const port = ev.ports[0];
  if (job?.kind !== "document_convert" || !port) return;
  runJob(job, port);
};
