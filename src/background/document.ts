import { parseDocumentUrl } from "@/lib/documentUrl";
import {
  CONVERT_TIMEOUT_MS,
  OFFSCREEN_PATH,
  type DocumentJob,
  type DocumentJobResult,
} from "@/lib/documentJob";
import type { DocumentContent } from "@/lib/messages";
import { debugLog, timeSpan } from "./debug";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 40_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_XML_BYTES = 6 * 1024 * 1024;
// 이미지 등 포함 전체. 압축 해제 작업량을 묶는다.
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
// offscreen 문서가 응답하지 않을 때를 대비한 서비스 워커 쪽 상한(wasm 첫 컴파일 시간 포함 여유).
const JOB_GUARD_MS = CONVERT_TIMEOUT_MS + 10_000;
// 마지막 변환 뒤 이 시간 동안 새 작업이 없으면 offscreen 문서를 닫아 wasm 메모리를 돌려준다.
const OFFSCREEN_IDLE_MS = 60_000;

interface OffscreenClient {
  url: string;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

// 서비스 워커 전역의 clients(타입 정의는 DOM lib 기준이라 필요한 부분만 적는다).
const swClients = (globalThis as unknown as {
  clients: { matchAll(options: { includeUncontrolled: boolean; type: "window" }): Promise<readonly OffscreenClient[]> };
}).clients;

let activeJobs = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let creating: Promise<void> | null = null;
let closing: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (closing) await closing;
  if (await hasOffscreen()) return;
  if (!creating) {
    const end = timeSpan("document:offscreen_create");
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "Word·Excel·PowerPoint 문서를 강제 종료할 수 있는 Worker에서 변환한다.",
      })
      .then(
        () => end("ok"),
        (err: unknown) => {
          end("fail");
          throw err;
        },
      )
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function offscreenClient(): Promise<OffscreenClient> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const all = await swClients.matchAll({ includeUncontrolled: true, type: "window" });
  const client = all.find((c) => c.url === url);
  if (!client) throw new Error("문서 변환기(offscreen 문서)를 찾지 못했습니다.");
  return client;
}

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeJobs > 0 || closing) return;
    closing = chrome.offscreen
      .closeDocument()
      .catch(() => {})
      .finally(() => {
        closing = null;
      });
  }, OFFSCREEN_IDLE_MS);
}

// 닫는 타이머는 서비스 워커 종료와 함께 사라지므로, 다시 뜰 때 이전 실행에서 남은 offscreen 문서를 닫는다.
closing = hasOffscreen()
  .then((open) => (open ? chrome.offscreen.closeDocument() : undefined))
  .catch(() => {})
  .finally(() => {
    closing = null;
  });

// 변환을 offscreen 문서의 Worker에 맡긴다. 중단·시간 초과 시 Worker가 강제 종료된다.
async function convertInWorker(
  bytes: Uint8Array,
  filename: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<DocumentJobResult> {
  activeJobs++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const end = timeSpan("document:convert");
  try {
    await ensureOffscreen();
    if (signal?.aborted) return { ok: false, kind: "cancelled" };
    const client = await offscreenClient();
    const channel = new MessageChannel();
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    const job: DocumentJob = {
      kind: "document_convert",
      bytes: buffer,
      filename,
      maxChars,
      limits: { maxXmlBytes: MAX_XML_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
    };
    const result = await new Promise<DocumentJobResult>((resolve) => {
      let settled = false;
      const settle = (r: DocumentJobResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        signal?.removeEventListener("abort", onAbort);
        channel.port1.close();
        resolve(r);
      };
      const onAbort = () => {
        channel.port1.postMessage({ kind: "cancel" });
        settle({ ok: false, kind: "cancelled" });
      };
      const guard = setTimeout(() => {
        // offscreen 문서가 멈췄으면 닫아서 Worker까지 함께 끝낸다.
        channel.port1.postMessage({ kind: "cancel" });
        chrome.offscreen.closeDocument().catch(() => {});
        settle({ ok: false, kind: "timeout" });
      }, JOB_GUARD_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      // offscreenClient()를 기다리는 사이에 중단됐으면 리스너가 불리지 않으므로 여기서 처리한다.
      if (signal?.aborted) return onAbort();
      channel.port1.onmessage = (ev: MessageEvent<DocumentJobResult>) => settle(ev.data);
      client.postMessage(job, [channel.port2, buffer]);
    });
    end(result.ok ? "ok" : result.kind);
    return result;
  } catch (err) {
    end("fail");
    throw err;
  } finally {
    activeJobs--;
    if (activeJobs === 0) scheduleIdleClose();
  }
}

function tooLarge(bytes: number): Error {
  return new Error(`문서가 너무 큽니다(${Math.round(bytes / 1024 / 1024)}MB 이상). 20MB 이하만 지원합니다.`);
}

// 길이 헤더가 없거나 거짓이어도 20MB를 넘는 순간 끊는다.
async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function fetchDocument(url: string, filename: string, signal?: AbortSignal): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    // 리다이렉트는 따라가지 않는다. 승인한 URL이 로그인된 다른 사이트의 상태 변경 GET으로
    // 302를 보내면 쿠키를 실어 그대로 실행되기 때문이다(승인 카드에는 시작 URL만 보인다).
    const res = await fetch(url, { credentials: "include", redirect: "error", signal: combined });
    return await readResponse(res, filename);
  } catch (err) {
    if (signal?.aborted) throw new Error("사용자가 중단해 문서 읽기를 취소했습니다.");
    if (timeout.aborted) throw new Error(`문서를 ${FETCH_TIMEOUT_MS / 1000}초 안에 내려받지 못했습니다.`);
    if (err instanceof TypeError) {
      // redirect: "error"로 막힌 경우도 TypeError로 온다.
      throw new Error(
        `문서를 내려받지 못했습니다(${err.message}). 다른 주소로 리다이렉트되는 링크(로그인·다운로드 중계 페이지 등)는 안전을 위해 읽지 않습니다. 파일을 직접 가리키는 URL인지 확인해 주세요.`,
      );
    }
    throw err;
  }
}

async function readResponse(res: Response, filename: string): Promise<Uint8Array> {
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
    await res.body?.cancel().catch(() => {});
    throw tooLarge(declared);
  }
  const bytes = await readCapped(res);
  if (bytes.byteLength === 0) throw new Error("문서가 비어 있습니다.");
  return bytes;
}

export async function readDocument(
  args: { url: string; maxChars?: number },
  signal?: AbortSignal,
): Promise<DocumentContent> {
  const target = parseDocumentUrl(args.url);
  if (!target) {
    throw new Error(
      "read_document는 경로가 .docx, .xlsx, .pptx로 끝나는 http(s) URL만 읽을 수 있습니다. 확장자가 없는 다운로드 링크나 미리보기 페이지는 지원하지 않습니다.",
    );
  }
  const bytes = await fetchDocument(target.url, target.filename, signal);
  const size = bytes.byteLength;
  if (signal?.aborted) throw new Error("사용자가 중단해 문서 읽기를 취소했습니다.");

  const result = await convertInWorker(bytes, target.filename, args.maxChars ?? DEFAULT_MAX_CHARS, signal);
  if (!result.ok) {
    if (result.kind !== "cancelled") debugLog("document:convert_error", JSON.stringify(result), "warn");
    throw new Error(failureMessage(target.filename, result));
  }
  return {
    url: target.url,
    filename: target.filename,
    format: target.extension,
    bytes: size,
    totalChars: result.totalChars,
    markdown: result.markdown,
    truncated: result.truncated,
  };
}

function failureMessage(filename: string, result: Exclude<DocumentJobResult, { ok: true }>): string {
  switch (result.kind) {
    case "rejected": {
      const hint = result.tooLarge
        ? "문서를 나누거나 필요한 부분만 복사해 붙여 주세요."
        : "파일이 손상됐거나 지원하지 않는 형식일 수 있습니다.";
      return `${filename}을(를) 읽을 수 없습니다: ${result.message}. ${hint}`;
    }
    case "convert":
      return `${filename}을(를) 해석하지 못했습니다: ${result.message}. 파일이 손상됐거나 암호가 걸려 있을 수 있습니다.`;
    case "empty":
      return `${filename}에서 텍스트를 찾지 못했습니다. 이미지·차트만 있는 문서일 수 있습니다.`;
    case "timeout":
      return `${filename} 변환이 ${CONVERT_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다. 내용이 매우 많거나(같은 값이 아주 많은 셀에 반복되는 엑셀 등) 비정상적인 파일일 수 있습니다. 다시 시도하지 마세요.`;
    case "cancelled":
      return "사용자가 중단해 문서 읽기를 취소했습니다.";
    case "crashed":
      return `${filename}을(를) 변환하다 변환기가 비정상 종료됐습니다: ${result.message}`;
  }
}
