import type { ModelId } from "./models";
import type { ReadableFormat } from "./fileFormat";

export type ToolName =
  | "describe_page"
  | "get_page_content"
  | "get_youtube_transcript"
  | "read_document"
  | "list_file_links"
  | "translate_page"
  | "find_form_fields"
  | "fill_form_fields"
  | "list_page_images"
  | "download_images"
  | "query_dom"
  | "navigate_to_url"
  | "find_clickables"
  | "click_element"
  | "google_sheets_list"
  | "google_sheets_read_range"
  | "google_sheets_write_range"
  | "google_sheets_append_rows"
  | "google_sheets_write_markdown_table"
  | "google_drive_search"
  | "google_drive_list_recent"
  | "google_drive_export";

export const SENSITIVE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "fill_form_fields",
  "download_images",
  "navigate_to_url",
  "click_element",
  // 모델이 고른 URL로 쿠키를 실어 GET을 보낸다. 프롬프트 주입이 쿼리에 대화 내용을 담아 외부로 보낼 수 있다.
  "read_document",
  "google_sheets_write_range",
  "google_sheets_append_rows",
  "google_sheets_write_markdown_table",
]);

export type PageRegion = "main" | "article" | "nav" | "aside" | "header" | "footer" | "other";

export interface ClickableElement {
  id: string;
  text: string;
  href: string;
  tag: string;
  role: string;
  region: PageRegion;
  inViewport: boolean;
}

export interface LandmarkSnapshot {
  region: PageRegion;
  elementCount: number;
  clickableCount: number;
  textPreview: string;
  sampleClickables: Array<{ text: string; href: string }>;
}

export interface PageDescription {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  landmarks: LandmarkSnapshot[];
  headings: string[];
  fallbackExcerpt: string;
}

export interface FormField {
  id: string;
  label: string;
  placeholder: string;
  type: string;
  role: string;
  currentValue: string;
}

export interface PageImage {
  url: string;
  alt: string;
  width: number;
  height: number;
}

export interface YoutubeTranscript {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  segmentCount: number;
  transcript: string;
  truncated: boolean;
  // false면 대기 시간 안에 패널이 다 그려지지 않아 뒷부분이 빠졌을 수 있다.
  complete: boolean;
}

export interface DocumentContent {
  url: string;
  // Content-Disposition 또는 URL에서 얻은 파일 이름.
  filename: string;
  // 받은 파일의 서명(텍스트면 이름·Content-Type)으로 정한 형식.
  format: ReadableFormat;
  bytes: number;
  // 변환된 Markdown 전체 길이. truncated면 markdown은 앞부분만 담는다.
  // PDF는 글자 수가 차면 남은 쪽을 읽지 않으므로 읽은 부분까지의 길이다(note에 쪽 수).
  totalChars: number;
  markdown: string;
  truncated: boolean;
  // 인코딩·읽은 쪽 수 등 덧붙임.
  note?: string;
}

export interface FileLink {
  text: string;
  url: string;
  // 이름으로 짐작한 형식. null이면 확장자 없는 다운로드 링크(받은 뒤 판별).
  format: ReadableFormat | null;
}

export interface FileLinkList {
  links: FileLink[];
  // 개수 제한으로 빠진 링크 수.
  omitted: number;
  // href 없이 자바스크립트로 내려받는 버튼 수. read_document로 읽을 수 없다.
  scriptDownloads: number;
}

export interface PageContent {
  title: string;
  url: string;
  mainText: string;
  wordCount: number;
}

export type PanelToBg =
  | { kind: "user_msg"; text: string; conversationId: string }
  | { kind: "approve_tool"; callId: string }
  | { kind: "cancel_tool"; callId: string }
  | { kind: "abort_stream" }
  | { kind: "reset_conversation"; conversationId: string }
  | { kind: "heartbeat" };

export type DebugLevel = "info" | "warn" | "error";
export interface DebugEvent {
  ts: number;
  source: "bg" | "content" | "panel";
  tag: string;
  level: DebugLevel;
  detail?: string;
}

export type BgToPanel =
  | { kind: "assistant_chunk"; text: string }
  | { kind: "thought_chunk"; text: string }
  | { kind: "assistant_done"; finishReason?: string }
  | { kind: "status"; text: string | null }
  | { kind: "debug"; event: DebugEvent }
  | {
      kind: "tool_pending";
      callId: string;
      toolName: ToolName;
      args: unknown;
      previewSummary: string;
      previewDetails?: unknown;
    }
  | {
      kind: "tool_result";
      callId: string;
      toolName: ToolName;
      ok: boolean;
      summary: string;
    }
  | { kind: "error"; message: string }
  | { kind: "info"; title: string; message: string }
  | { kind: "settings_warning"; message: string };

export type BgToContent =
  | { kind: "tool_exec"; toolName: ToolName; args: unknown; callId: string }
  | { kind: "translate_batch"; texts: string[]; targetLang: string }
  | { kind: "translate_stop" }
  // 승인 카드용: id들이 find_* 때와 같은 요소인지 확인하고 이 호출의 승인 대상으로 남긴다.
  | { kind: "target_inspect"; ids: string[]; callId: string }
  // click_element 뒤 같은 문서에서 관찰한 변화를 읽는다.
  | { kind: "action_effect"; token: string };

export interface ContentResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type RuntimeMsg =
  | { kind: "settings_updated" }
  | { kind: "translate_text_batch"; texts: string[]; targetLang: string };

export interface Settings {
  openRouterApiKey: string;
  model: ModelId;
  systemPrompt: string;
  translationTargetLang: string;
  downloadFolderPrefix: string;
  maxToolHops: number;
}

export const MAX_SYSTEM_PROMPT_LENGTH = 4000;

export const DEFAULT_MAX_TOOL_HOPS = 8;
export const MIN_MAX_TOOL_HOPS = 1;
export const MAX_MAX_TOOL_HOPS = 30;

export const SETTINGS_KEY = "settings";
export const FLAGS_KEY = "flags";

export const PORT_NAME = "chat";

export interface Flags {
  pdfGuidanceShown?: boolean;
}
