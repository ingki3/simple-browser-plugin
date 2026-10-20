// 서비스 워커 → offscreen 문서 → 변환 Worker 사이에 오가는 문서 변환 작업 형식.
// 변환기(docling.rs-wasm, pdf.js, kordoc)는 입력에 따라 메모리·시간이 크게 늘 수 있어(예: 엑셀 공유 문자열을
// 수많은 셀이 참조, HWP 압축 스트림) 강제로 끝낼 수 있는 Worker에서만 실행한다.

import type { ConvertEngine, ReadableFormat } from "./fileFormat";
import type { SanitizeLimits } from "./zipSanitize";

export const OFFSCREEN_PATH = "src/offscreen/index.html";
// offscreen 문서가 작업을 받은 뒤 Worker를 끝내기까지의 시간. 정상 문서는 대개 1초 안에 끝난다(실측 최대 약 0.7초).
// 악성 입력은 이 동안 계속 메모리를 늘린다(공유 문자열 10만 참조: 60초에 약 1.9GB).
export const CONVERT_TIMEOUT_MS = 10_000;

// 텍스트(txt·md)와 표(csv·tsv)는 서비스 워커에서 처리하므로 Worker로 오지 않는다.
export type WorkerEngine = Exclude<ConvertEngine, "text" | "table">;

export interface DocumentJob {
  kind: "document_convert";
  engine: WorkerEngine;
  // 받은 파일의 서명으로 정한 형식. 확장자 없는 링크도 여기에 맞춰 변환한다.
  format: ReadableFormat;
  // 내려받은 원본 파일. 소유권을 넘긴다(transfer).
  bytes: ArrayBuffer;
  filename: string;
  maxChars: number;
  limits: SanitizeLimits;
}

// 받아 온 기사 HTML의 본문 추출(read_linked_pages). offscreen 문서의 DOMParser에서 동기로 처리한다.
export interface HtmlExtractJob {
  kind: "html_extract";
  html: string;
  maxChars: number;
}

export type HtmlExtractResult =
  | { ok: true; title: string; text: string; truncated: boolean }
  | { ok: false; kind: "failed" | "cancelled" | "timeout" | "closed"; message?: string };

// 서비스 워커가 진행 중인 작업을 끝내 달라고 보낼 때 쓴다.
export interface DocumentJobCancel {
  kind: "cancel";
}

export type DocumentJobFailure =
  // zip 검사에서 거부(손상·미지원 형식). tooLarge면 크기 한도 초과.
  | { ok: false; kind: "rejected"; message: string; tooLarge: boolean }
  | { ok: false; kind: "convert"; message: string }
  | { ok: false; kind: "empty" }
  | { ok: false; kind: "encrypted" }
  | { ok: false; kind: "timeout" }
  | { ok: false; kind: "cancelled" }
  | { ok: false; kind: "crashed"; message: string };

export type DocumentJobResult =
  // note: 사용자에게 전할 덧붙임(예: PDF를 몇 쪽까지 읽었는지).
  | { ok: true; markdown: string; totalChars: number; truncated: boolean; note?: string }
  | DocumentJobFailure;

// offscreen 문서 → Worker. docling이면 컴파일한 wasm 모듈을 함께 넘겨 Worker마다 다시 컴파일하지 않는다.
export interface WorkerJob extends Omit<DocumentJob, "kind"> {
  module: WebAssembly.Module | null;
}
