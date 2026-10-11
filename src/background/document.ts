import initDocling, { convert } from "docling.rs-wasm/web";
import doclingWasmUrl from "docling.rs-wasm/web/docling_wasm_bg.wasm?url";
import { parseDocumentUrl } from "@/lib/documentUrl";
import type { DocumentContent } from "@/lib/messages";
import { debugLog, timeSpan } from "./debug";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 40_000;

// wasm(약 15MB)은 처음 문서를 읽을 때 한 번만 컴파일한다. 서비스 워커가 다시 뜨면 다시 초기화된다.
let doclingReady: Promise<unknown> | null = null;

function ensureDocling(): Promise<unknown> {
  if (!doclingReady) {
    const end = timeSpan("document:wasm_init");
    // Vite가 주는 경로는 "/assets/…" 형태라 확장 루트 기준 URL로 바꾼다.
    const wasmUrl = chrome.runtime.getURL(doclingWasmUrl.replace(/^\//, ""));
    doclingReady = initDocling({ module_or_path: wasmUrl }).then(
      (r) => {
        end("ok");
        return r;
      },
      (err: unknown) => {
        end("fail");
        doclingReady = null;
        throw err;
      },
    );
  }
  return doclingReady;
}

async function fetchDocument(url: string, filename: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`문서를 내려받지 못했습니다(네트워크 오류: ${msg}). 브라우저에서 이 URL이 직접 열리는지 확인해 주세요.`);
  }
  if (!res.ok) {
    throw new Error(`문서 가져오기 실패: HTTP ${res.status} ${res.statusText}`);
  }
  // 로그인이 필요하면 문서 대신 HTML 로그인 페이지가 오는 경우가 많다.
  const contentType = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(contentType)) {
    throw new Error(
      `${filename} 대신 웹 페이지(HTML)가 응답으로 왔습니다. 로그인이 필요하거나 미리보기 페이지 링크일 수 있습니다. 브라우저에서 파일이 바로 내려받아지는 링크인지 확인해 주세요.`,
    );
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOCUMENT_BYTES) {
    throw new Error(`문서가 너무 큽니다(${Math.round(declared / 1024 / 1024)}MB). 20MB 이하만 지원합니다.`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error("문서가 비어 있습니다.");
  if (buf.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`문서가 너무 큽니다(${Math.round(buf.byteLength / 1024 / 1024)}MB). 20MB 이하만 지원합니다.`);
  }
  return new Uint8Array(buf);
}

export async function readDocument(args: { url: string; maxChars?: number }): Promise<DocumentContent> {
  const target = parseDocumentUrl(args.url);
  if (!target) {
    throw new Error(
      "read_document는 경로가 .docx, .xlsx, .pptx로 끝나는 http(s) URL만 읽을 수 있습니다. 확장자가 없는 다운로드 링크나 미리보기 페이지는 지원하지 않습니다.",
    );
  }
  const [bytes] = await Promise.all([fetchDocument(target.url, target.filename), ensureDocling()]);

  const endConvert = timeSpan("document:convert");
  let markdown: string;
  try {
    markdown = convert(bytes, target.filename, "md");
    endConvert("ok");
  } catch (err) {
    endConvert("fail");
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("document:convert_error", msg, "warn");
    throw new Error(`${target.filename}을(를) 해석하지 못했습니다: ${msg}. 파일이 손상됐거나 암호가 걸려 있을 수 있습니다.`);
  }
  markdown = markdown.trim();
  if (!markdown) {
    throw new Error(`${target.filename}에서 텍스트를 찾지 못했습니다. 이미지·차트만 있는 문서일 수 있습니다.`);
  }

  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = markdown.length > maxChars;
  return {
    url: target.url,
    filename: target.filename,
    format: target.extension,
    bytes: bytes.byteLength,
    totalChars: markdown.length,
    markdown: truncated ? markdown.slice(0, maxChars) : markdown,
    truncated,
  };
}
