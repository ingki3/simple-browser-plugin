// 링크 파일 읽기(read_document)·찾기(list_file_links)가 함께 쓰는 형식 판별.
// URL·응답 헤더의 이름은 서버나 페이지 작성자가 정하므로 힌트로만 쓰고, 받은 파일의 앞부분 서명을 우선한다.

export const READABLE_FORMATS = [
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "pdf",
  "hwp",
  "hwpx",
  "csv",
  "tsv",
  "txt",
  "md",
] as const;
export type ReadableFormat = (typeof READABLE_FORMATS)[number];

// docling: Office·OpenDocument, pdf: pdf.js, hwp: kordoc, table: CSV·TSV(csvTable), text: 변환 없이 원문.
// table·text는 서비스 워커에서 바로 처리한다.
export type ConvertEngine = "docling" | "pdf" | "hwp" | "table" | "text";

export function engineFor(format: ReadableFormat): ConvertEngine {
  switch (format) {
    case "pdf":
      return "pdf";
    case "hwp":
    case "hwpx":
      return "hwp";
    case "csv":
    case "tsv":
      return "table";
    case "txt":
    case "md":
      return "text";
    default:
      return "docling";
  }
}

// 서명 없이 이름·Content-Type으로만 판별하는 텍스트 형식.
export function isTextFormat(format: ReadableFormat): boolean {
  return ["csv", "tsv", "txt", "md"].includes(format);
}

// zip 기반 형식은 변환 전에 zip 검사(zipSanitize)를 거친다.
export function isZipFormat(format: ReadableFormat): boolean {
  return ["docx", "xlsx", "pptx", "odt", "ods", "odp", "hwpx"].includes(format);
}

const EXTENSION_ALIASES: Record<string, ReadableFormat> = { markdown: "md", text: "txt" };

export function formatFromExtension(ext: string | null | undefined): ReadableFormat | null {
  if (!ext) return null;
  const lower = ext.toLowerCase();
  if ((READABLE_FORMATS as readonly string[]).includes(lower)) return lower as ReadableFormat;
  return EXTENSION_ALIASES[lower] ?? null;
}

// 구형 Office(OLE) 형식. 서명이 HWP 5와 같아 이름으로만 구분된다.
const LEGACY_OFFICE = ["doc", "xls", "ppt"];

// 문서가 아닌 것이 분명한 확장자. 이런 링크는 받지 않는다(확장자 없는 링크와 .do·.php 같은 다운로드 처리기는 받는다).
const NOT_DOCUMENT = new Set([
  ...LEGACY_OFFICE,
  "html", "htm", "xhtml", "shtml", "js", "mjs", "css", "json", "xml", "svg",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "heic", "avif",
  "mp3", "mp4", "m4a", "wav", "ogg", "webm", "mov", "avi", "mkv", "flac",
  "zip", "7z", "rar", "gz", "tgz", "tar", "bz2", "xz", "alz", "egg",
  "exe", "msi", "dmg", "pkg", "apk", "ipa", "deb", "rpm", "iso", "bin",
  "rtf", "epub", "key", "pages", "numbers",
]);

export function extensionOf(name: string): string | null {
  return name.match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() ?? null;
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export interface FileUrl {
  url: string;
  // 경로 마지막 부분 또는 쿼리 값에서 찾은 파일 이름. 없으면 "".
  filename: string;
  // 이름에서 짐작한 형식. 확장자 없는 다운로드 링크면 null(받은 뒤 판별).
  hint: ReadableFormat | null;
}

export type FileUrlCheck = { ok: true; target: FileUrl } | { ok: false; reason: string };

// read_document가 받을 수 있는 URL인지 본다. 쿠키를 실어 GET을 보내므로 http(s)만 받고,
// 문서가 아닌 것이 분명한 확장자(웹 페이지·이미지·압축 파일 등)는 받지 않는다.
// 확장자 없는 다운로드 링크(download.do?fileId=… 등)는 승인 카드를 전제로 받는다.
export function checkFileUrl(rawUrl: string): FileUrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "올바른 URL이 아닙니다." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "http(s) URL만 읽을 수 있습니다." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "사용자 이름·비밀번호가 들어간 URL은 읽지 않습니다." };
  }
  const last = url.pathname.split("/").pop() ?? "";
  const pathName = safeDecode(last);
  if (pathName === null) return { ok: false, reason: "URL 경로를 해석할 수 없습니다." };
  const pathExt = extensionOf(pathName);
  if (pathExt && LEGACY_OFFICE.includes(pathExt)) {
    return { ok: false, reason: `.${pathExt}(구형 Office 형식)은 읽을 수 없습니다. .docx·.xlsx·.pptx만 지원합니다.` };
  }
  if (pathExt && NOT_DOCUMENT.has(pathExt)) {
    return { ok: false, reason: `.${pathExt} 파일은 읽을 수 있는 문서 형식이 아닙니다.` };
  }
  const pathFormat = formatFromExtension(pathExt);
  if (pathFormat) return { ok: true, target: { url: url.href, filename: pathName, hint: pathFormat } };
  // download.do?fileName=보고서.hwp처럼 쿼리에 파일 이름이 있는 경우.
  for (const value of url.searchParams.values()) {
    const name = value.split(/[\\/]/).pop() ?? "";
    const format = formatFromExtension(extensionOf(name));
    if (format) return { ok: true, target: { url: url.href, filename: name, hint: format } };
  }
  return { ok: true, target: { url: url.href, filename: pathExt ? "" : pathName, hint: null } };
}

// 헤더 값은 바이트를 Latin-1 글자로 담아 온다. 한국 서버는 파일 이름을 UTF-8이나 EUC-KR 바이트 그대로
// 보내는 경우가 많아서, 0~255 글자로만 되어 있으면 바이트로 되돌려 다시 해석한다.
function redecodeHeaderBytes(s: string): string {
  if (![...s].some((c) => c.charCodeAt(0) > 0x7f)) return s;
  if ([...s].some((c) => c.charCodeAt(0) > 0xff)) return s;
  const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
    } catch {
      return s;
    }
  }
}

// Content-Disposition에서 파일 이름을 꺼낸다(RFC 6266의 filename*를 우선).
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*([^;]+)/i)?.[1]?.trim();
  if (star) {
    const m = star.replace(/^"|"$/g, "").match(/^([\w-]+)'[^']*'(.*)$/);
    if (m) {
      const [, charset, encoded] = m;
      const bytes: number[] = [];
      let ok = true;
      for (let i = 0; i < encoded.length; i++) {
        if (encoded[i] === "%" && /^[0-9a-f]{2}$/i.test(encoded.slice(i + 1, i + 3))) {
          bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          const code = encoded.charCodeAt(i);
          if (code > 0xff) ok = false;
          bytes.push(code & 0xff);
        }
      }
      if (ok) {
        try {
          const label = charset.toLowerCase() === "utf-8" ? "utf-8" : charset;
          const name = new TextDecoder(label, { fatal: true }).decode(Uint8Array.from(bytes));
          if (name) return baseName(name);
        } catch {
          // 아래 filename=으로 넘어간다.
        }
      }
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i)?.[1];
  const plain = quoted ?? header.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim();
  if (!plain) return null;
  let name = redecodeHeaderBytes(quoted !== undefined ? plain.replace(/\\(.)/g, "$1") : plain);
  // 일부 서버는 퍼센트 인코딩한 이름을 그대로 filename=에 넣는다.
  if (/%[0-9a-f]{2}/i.test(name)) name = safeDecode(name) ?? name;
  return baseName(name) || null;
}

function baseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? "").trim();
}

export interface SniffHints {
  // Content-Disposition 파일 이름의 확장자, URL의 확장자 순으로 앞선다.
  names: string[];
  contentType: string | null;
  // zip이면 항목 이름과 mimetype 항목 내용. 판별에 필요할 때만 채운다.
  zip?: { names: string[]; mimetype: string | null };
}

export type SniffResult = { ok: true; format: ReadableFormat } | { ok: false; reason: string };

const startsWithBytes = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HWP3_SIGNATURE = ascii("HWP Document File");

export function isZip(bytes: Uint8Array): boolean {
  return startsWithBytes(bytes, ZIP_SIGNATURE);
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  // 명세상 %PDF- 앞에 다른 바이트가 붙을 수 있다(pdf.js도 앞부분 1KB 안에서 찾는다).
  const head = bytes.subarray(0, 1024);
  const sig = ascii("%PDF-");
  for (let i = 0; i + sig.length <= head.length; i++) if (startsWithBytes(head, sig, i)) return true;
  return false;
}

function zipFormat(zip: { names: string[]; mimetype: string | null }): ReadableFormat | null {
  const has = (n: string) => zip.names.includes(n);
  if (has("word/document.xml")) return "docx";
  if (has("xl/workbook.xml")) return "xlsx";
  if (has("ppt/presentation.xml")) return "pptx";
  const mime = zip.mimetype?.trim();
  if (mime === "application/hwp+zip" || has("Contents/content.hpf")) return "hwpx";
  if (mime === "application/vnd.oasis.opendocument.text") return "odt";
  if (mime === "application/vnd.oasis.opendocument.spreadsheet") return "ods";
  if (mime === "application/vnd.oasis.opendocument.presentation") return "odp";
  return null;
}

const TEXT_TYPES: Record<string, ReadableFormat> = {
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
};

// 앞부분에 NUL이 있으면 텍스트가 아니다(UTF-16은 BOM이 있을 때만 텍스트로 본다).
function looksBinary(bytes: Uint8Array): boolean {
  if (startsWithBytes(bytes, [0xff, 0xfe]) || startsWithBytes(bytes, [0xfe, 0xff])) return false;
  const head = bytes.subarray(0, 8192);
  return head.includes(0);
}

// 받은 파일의 형식을 정한다. 바이너리 서명이 있으면 그것을 따르고, 없으면 이름·Content-Type으로 텍스트 형식을 고른다.
export function sniffFormat(bytes: Uint8Array, hints: SniffHints): SniffResult {
  const exts = hints.names.map(extensionOf).filter((e): e is string => !!e);
  const type = (hints.contentType ?? "").split(";")[0].trim().toLowerCase();

  if (hasPdfHeader(bytes)) return { ok: true, format: "pdf" };
  if (startsWithBytes(bytes, HWP3_SIGNATURE)) return { ok: true, format: "hwp" };
  if (startsWithBytes(bytes, OLE_SIGNATURE)) {
    const legacy = exts.find((e) => LEGACY_OFFICE.includes(e));
    if (legacy || /msword|ms-excel|ms-powerpoint/.test(type)) {
      return { ok: false, reason: `구형 Office 형식(${legacy ? "." + legacy : type})은 읽을 수 없습니다. .docx·.xlsx·.pptx만 지원합니다.` };
    }
    // HWP 5와 구형 Office는 서명이 같다. HWP가 아니면 변환기가 지원하지 않는 형식이라고 알린다.
    return { ok: true, format: "hwp" };
  }
  if (isZip(bytes)) {
    if (!hints.zip) return { ok: false, reason: "zip 목차를 읽지 못했습니다." };
    const format = zipFormat(hints.zip);
    if (format) return { ok: true, format };
    return { ok: false, reason: "지원하지 않는 압축(zip) 파일입니다. Office·OpenDocument·HWPX 문서가 아닙니다." };
  }
  if (looksBinary(bytes)) return { ok: false, reason: "지원하지 않는 형식의 파일입니다." };

  const named = exts.map(formatFromExtension).filter((f): f is ReadableFormat => f !== null);
  const textHint = named.find(isTextFormat) ?? TEXT_TYPES[type] ?? null;
  const binaryHint = named.find((f) => !isTextFormat(f));
  if (!textHint && binaryHint) {
    return { ok: false, reason: `.${binaryHint} 파일이라고 했지만 내용이 그 형식이 아닙니다(손상됐거나 다른 파일).` };
  }
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) {
    return { ok: false, reason: "파일 대신 웹 페이지(HTML)가 왔습니다. 로그인이 필요하거나 미리보기 페이지 링크일 수 있습니다." };
  }
  if (textHint) return { ok: true, format: textHint };
  // 이름도 형식도 없는 텍스트(application/octet-stream 등)는 일반 텍스트로 읽는다.
  if (!type || type === "application/octet-stream" || type.startsWith("text/")) return { ok: true, format: "txt" };
  return { ok: false, reason: `지원하지 않는 형식(${type})입니다.` };
}

// 텍스트 파일을 해석한다. BOM을 따르고, 없으면 UTF-8로 엄격히 읽어 보고 실패하면 EUC-KR(CP949)로 읽는다.
// 한국어 엑셀이 저장한 CSV는 대개 CP949다.
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  if (startsWithBytes(bytes, [0xff, 0xfe])) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (startsWithBytes(bytes, [0xfe, 0xff])) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("euc-kr").decode(bytes), encoding: "euc-kr" };
  }
}
