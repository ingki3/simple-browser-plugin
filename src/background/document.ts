import {
  checkFileUrl,
  decodeText,
  engineFor,
  extensionOf,
  filenameFromDisposition,
  isZip,
  sniffFormat,
  type ReadableFormat,
  type SniffHints,
} from "@/lib/fileFormat";
import { peekZip } from "@/lib/zipSanitize";
import {
  CONVERT_TIMEOUT_MS,
  OFFSCREEN_PATH,
  type DocumentJob,
  type DocumentJobResult,
  type WorkerEngine,
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
        justification: "링크된 문서(Office·PDF·한글·CSV)를 강제 종료할 수 있는 Worker에서 변환한다.",
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
  engine: WorkerEngine,
  format: ReadableFormat,
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
      engine,
      format,
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

interface Downloaded {
  bytes: Uint8Array;
  contentType: string | null;
  // Content-Disposition의 파일 이름.
  dispositionName: string | null;
  // 리다이렉트를 따라 쿠키 없이 다시 받았으면 최종 URL.
  redirectedTo: string | null;
}

function fetchFailed(err: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): Error {
  if (signal?.aborted) return new Error("사용자가 중단해 문서 읽기를 취소했습니다.");
  if (timeout.aborted) return new Error(`문서를 ${FETCH_TIMEOUT_MS / 1000}초 안에 내려받지 못했습니다.`);
  return new Error(`문서를 내려받지 못했습니다(${err instanceof Error ? err.message : String(err)}).`);
}

async function fetchDocument(url: string, signal?: AbortSignal): Promise<Downloaded> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  let redirectedTo: string | null = null;
  try {
    // 쿠키를 실은 요청은 리다이렉트를 따라가지 않는다. 승인한 URL이 로그인된 다른 사이트의 상태 변경 GET으로
    // 302를 보내면 쿠키를 실어 그대로 실행되기 때문이다(승인 카드에는 시작 URL만 보인다).
    res = await fetch(url, { credentials: "include", redirect: "error", signal: combined });
  } catch (err) {
    if (!(err instanceof TypeError) || combined.aborted) throw fetchFailed(err, signal, timeout);
    // 리다이렉트(CDN 서명 주소·단축 주소 등)는 TypeError로 온다. 쿠키 없이 다시 받으면 다른 사이트에
    // 로그인한 사용자로 요청이 가지 않는다. 네트워크 오류였어도 같은 URL을 한 번 더 보낼 뿐이다.
    try {
      res = await fetch(url, { credentials: "omit", redirect: "follow", signal: combined });
    } catch (retryErr) {
      throw fetchFailed(retryErr, signal, timeout);
    }
    if (res.redirected) redirectedTo = res.url;
    debugLog("document:redirect_retry", res.redirected ? new URL(res.url).host : "no redirect");
  }
  try {
    return await readResponse(res, redirectedTo);
  } catch (err) {
    if (signal?.aborted) throw new Error("사용자가 중단해 문서 읽기를 취소했습니다.");
    if (timeout.aborted) throw new Error(`문서를 ${FETCH_TIMEOUT_MS / 1000}초 안에 내려받지 못했습니다.`);
    throw err;
  }
}

async function readResponse(res: Response, redirectedTo: string | null): Promise<Downloaded> {
  const loginHint = redirectedTo
    ? " 리다이렉트되는 링크는 안전을 위해 로그인 정보 없이 다시 받았으므로, 로그인이 필요한 파일이면 읽을 수 없습니다."
    : "";
  if (!res.ok) {
    // 본문을 끊지 않으면 도구는 실패했는데 요청은 시간 제한까지 남는다.
    await res.body?.cancel().catch(() => {});
    throw new Error(`문서 가져오기 실패: HTTP ${res.status} ${res.statusText}.${loginHint}`);
  }
  const contentType = res.headers.get("content-type");
  const dispositionName = filenameFromDisposition(res.headers.get("content-disposition"));
  // 로그인이 필요하면 문서 대신 HTML 로그인 페이지가 오는 경우가 많다.
  // 첨부 파일 이름을 붙여 보내면서 Content-Type만 잘못 단 서버도 있어, 그때는 내용을 보고 판단한다.
  if (/text\/html/i.test(contentType ?? "") && !dispositionName) {
    await res.body?.cancel().catch(() => {});
    throw new Error(
      `파일 대신 웹 페이지(HTML)가 응답으로 왔습니다. 로그인이 필요하거나 미리보기 페이지 링크일 수 있습니다. 브라우저에서 파일이 바로 내려받아지는 링크인지 확인해 주세요.${loginHint}`,
    );
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOCUMENT_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(declared);
  }
  const bytes = await readCapped(res);
  if (bytes.byteLength === 0) throw new Error("문서가 비어 있습니다.");
  return { bytes, contentType, dispositionName, redirectedTo };
}

// 변환기는 이름의 확장자로 형식을 고르므로(docling) 실제 형식과 맞는 이름을 넘긴다.
function convertName(filename: string, format: ReadableFormat): string {
  return extensionOf(filename) === format ? filename : `document.${format}`;
}

export async function readDocument(
  args: { url: string; maxChars?: number },
  signal?: AbortSignal,
): Promise<DocumentContent> {
  const checked = checkFileUrl(args.url);
  if (!checked.ok) throw new Error(`read_document: ${checked.reason}`);
  const target = checked.target;
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const got = await fetchDocument(target.url, signal);
  if (signal?.aborted) throw new Error("사용자가 중단해 문서 읽기를 취소했습니다.");

  const filename = got.dispositionName || target.filename || "";
  const hints: SniffHints = {
    names: [got.dispositionName, target.filename].filter((n): n is string => !!n),
    contentType: got.contentType,
  };
  if (isZip(got.bytes)) {
    try {
      hints.zip = peekZip(got.bytes);
    } catch (err) {
      throw new Error(`zip 형식 문서를 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const sniffed = sniffFormat(got.bytes, hints);
  if (!sniffed.ok) throw new Error(`${filename || "받은 파일"}: ${sniffed.reason}`);
  const format = sniffed.format;
  const label = filename || `(이름 없는 ${format} 파일)`;
  const base = {
    url: target.url,
    filename: label,
    format,
    bytes: got.bytes.byteLength,
    ...(got.redirectedTo ? { redirectedTo: got.redirectedTo } : {}),
  };

  const engine = engineFor(format);
  if (engine === "text") {
    const { text, encoding } = decodeText(got.bytes);
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`${label}에 내용이 없습니다.`);
    const truncated = trimmed.length > maxChars;
    return {
      ...base,
      totalChars: trimmed.length,
      markdown: truncated ? trimmed.slice(0, maxChars) : trimmed,
      truncated,
      ...(encoding !== "utf-8" ? { note: `${encoding} 인코딩으로 읽었습니다.` } : {}),
    };
  }

  let bytes = got.bytes;
  let note: string | undefined;
  if (format === "csv" || format === "tsv") {
    // 변환기는 UTF-8만 읽는다. 한국어 엑셀이 저장한 CSV(CP949)도 여기서 UTF-8로 바꿔 넘긴다.
    const { text, encoding } = decodeText(bytes);
    bytes = new TextEncoder().encode(text);
    if (encoding !== "utf-8") note = `${encoding} 인코딩으로 읽었습니다.`;
  }
  const result = await convertInWorker(bytes, engine, format, convertName(filename, format), maxChars, signal);
  if (!result.ok) {
    if (result.kind !== "cancelled") debugLog("document:convert_error", JSON.stringify(result), "warn");
    throw new Error(failureMessage(label, format, result));
  }
  return {
    ...base,
    totalChars: result.totalChars,
    markdown: result.markdown,
    truncated: result.truncated,
    ...(result.note || note ? { note: [note, result.note].filter(Boolean).join(" ") } : {}),
  };
}

function failureMessage(
  filename: string,
  format: ReadableFormat,
  result: Exclude<DocumentJobResult, { ok: true }>,
): string {
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
      if (format === "pdf") {
        return `${filename}에서 글자를 찾지 못했습니다. 스캔한 이미지로 된 PDF일 수 있습니다. 사용자가 이 PDF를 탭에서 열고 다시 물으면 PDF 첨부 방식(글자 인식 포함)으로 읽을 수 있다고 안내하세요.`;
      }
      return `${filename}에서 텍스트를 찾지 못했습니다. 이미지·차트만 있는 문서일 수 있습니다.`;
    case "encrypted":
      return `${filename}은(는) 암호로 보호된 문서라 읽을 수 없습니다.`;
    case "timeout":
      return `${filename} 변환이 ${CONVERT_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다. 내용이 매우 많거나(같은 값이 아주 많은 셀에 반복되는 엑셀 등) 비정상적인 파일일 수 있습니다. 다시 시도하지 마세요.`;
    case "cancelled":
      return "사용자가 중단해 문서 읽기를 취소했습니다.";
    case "crashed":
      return `${filename}을(를) 변환하다 변환기가 비정상 종료됐습니다: ${result.message}`;
  }
}
