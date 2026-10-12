// 문서 한 건을 변환하고 끝나는 Worker. offscreen 문서가 시간 초과·중단 시 terminate()한다.
import { initSync, convert } from "docling.rs-wasm/web";
import { sanitizeOfficeZip, ZipRejected } from "@/lib/zipSanitize";
import type { DocumentJobResult, WorkerJob } from "@/lib/documentJob";

async function run(job: WorkerJob): Promise<DocumentJobResult> {
  // zip 목차의 크기 값은 꾸밀 수 있으므로 직접 풀며 세고, 검증된 내용으로 다시 만든 zip만 변환기에 넘긴다.
  let sanitized: Uint8Array;
  try {
    sanitized = (await sanitizeOfficeZip(new Uint8Array(job.bytes), job.limits)).bytes;
  } catch (err) {
    if (err instanceof ZipRejected) return { ok: false, kind: "rejected", message: err.message, tooLarge: err.tooLarge };
    throw err;
  }
  initSync({ module: job.module });
  let markdown: string;
  try {
    markdown = convert(sanitized, job.filename, "md").trim();
  } catch (err) {
    return { ok: false, kind: "convert", message: err instanceof Error ? err.message : String(err) };
  }
  if (!markdown) return { ok: false, kind: "empty" };
  // 긴 결과를 통째로 넘기지 않도록 여기서 자른다.
  const truncated = markdown.length > job.maxChars;
  return {
    ok: true,
    markdown: truncated ? markdown.slice(0, job.maxChars) : markdown,
    totalChars: markdown.length,
    truncated,
  };
}

self.onmessage = (ev: MessageEvent<WorkerJob>) => {
  run(ev.data).then(
    (result) => self.postMessage(result),
    (err: unknown) =>
      self.postMessage({ ok: false, kind: "crashed", message: err instanceof Error ? err.message : String(err) }),
  );
};
