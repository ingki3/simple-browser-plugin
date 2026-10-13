// 문서 한 건을 변환하고 끝나는 Worker. offscreen 문서가 시간 초과·중단 시 terminate()한다.
// 변환기는 형식에 맞는 것만 불러온다(docling wasm은 offscreen 문서가 컴파일해 넘긴다).
import { initSync, convert } from "docling.rs-wasm/web";
import { sanitizeOfficeZip, ZipRejected } from "@/lib/zipSanitize";
import { isZipFormat } from "@/lib/fileFormat";
import type { DocumentJobFailure, DocumentJobResult, WorkerJob } from "@/lib/documentJob";
import { convertPdf } from "./engines/pdf";
import { convertHwp } from "./engines/hwp";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function toMarkdown(job: WorkerJob): Promise<DocumentJobFailure | { ok: true; markdown: string }> {
  let bytes: Uint8Array = new Uint8Array(job.bytes);
  // zip 목차의 크기 값은 꾸밀 수 있으므로 직접 풀며 세고, 검증된 내용으로 다시 만든 zip만 변환기에 넘긴다.
  if (isZipFormat(job.format)) {
    try {
      bytes = (await sanitizeOfficeZip(bytes, job.limits)).bytes;
    } catch (err) {
      if (err instanceof ZipRejected) return { ok: false, kind: "rejected", message: err.message, tooLarge: err.tooLarge };
      throw err;
    }
  }
  if (job.engine === "hwp") return convertHwp(bytes);
  if (!job.module) throw new Error("docling 변환기 모듈이 없습니다.");
  initSync({ module: job.module });
  try {
    return { ok: true, markdown: convert(bytes, job.filename, "md") };
  } catch (err) {
    return { ok: false, kind: "convert", message: errorText(err) };
  }
}

async function run(job: WorkerJob): Promise<DocumentJobResult> {
  // PDF는 쪽 단위로 읽다가 글자 수가 차면 멈추므로 따로 처리한다.
  if (job.engine === "pdf") return convertPdf(new Uint8Array(job.bytes), job.maxChars);
  const result = await toMarkdown(job);
  if (!result.ok) return result;
  const markdown = result.markdown.trim();
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
    (err: unknown) => self.postMessage({ ok: false, kind: "crashed", message: errorText(err) }),
  );
};
