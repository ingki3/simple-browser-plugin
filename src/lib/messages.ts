import type { ModelId } from "./models";
import type { ReadableFormat } from "./fileFormat";
import type { ReadHint } from "./readRecipe";

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
  // 같은 구조의 페이지에서 전에 쓸모 있었던 읽기 도구 호출(읽기 레시피). 백그라운드가 붙인다.
  readHints?: ReadHint[];
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
  // allowLinksThisTurn: 카드가 제안했을 때만 유효. 이번 요청 동안 같은 사이트 안의 일반 링크 이동은 묻지 않는다.
  | { kind: "approve_tool"; callId: string; allowLinksThisTurn?: boolean }
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
      // 일반 링크 클릭 카드면 true: "이번 요청 동안 링크 이동은 묻지 않기"를 함께 보여 준다(grantableLink).
      linkGrantOffer?: boolean;
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
  // prefix는 기대하는 대상 종류("c" 클릭, "f" 입력 칸).
  | { kind: "target_inspect"; ids: string[]; callId: string; prefix: "c" | "f"; values?: string[] }
  // click_element 뒤 같은 문서에서 관찰한 변화를 읽는다.
  | { kind: "action_effect"; token: string }
  // 동작 기록용 페이지 뼈대 해시(최상위 문서).
  | { kind: "page_skeleton" };

export interface ContentResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type RuntimeMsg =
  | { kind: "settings_updated" }
  // 설정 화면의 동작 기록 개수 보기·지우기. 쓰기를 백그라운드 한곳으로 모은다.
  | { kind: "action_log_count" }
  | { kind: "action_log_clear" }
  | { kind: "translate_text_batch"; texts: string[]; targetLang: string };

export interface Settings {
  openRouterApiKey: string;
  model: ModelId;
  systemPrompt: string;
  translationTargetLang: string;
  downloadFolderPrefix: string;
  maxToolHops: number;
  // 저장할 때 MAX_TOOL_HOPS_VERSION을 붙인다(normalizeMaxToolHops).
  maxToolHopsVersion?: number;
  // 클릭·입력 동작과 읽기 레시피를 이 브라우저에 기록할지(입력 값·페이지 내용은 남기지 않음). 시크릿 창은 늘 기록하지 않는다.
  actionLogEnabled: boolean;
  // read_document가 CSV·TSV 파일을 표로 읽을 때 모델에 넘기는 최대 글자 수(모델이 따로 정하지 않았을 때).
  csvMaxChars: number;
  // 페이지 이동·클릭·입력을 승인 없이 실행할지. 켜도 결제·개인정보 제출은 묻는다(src/lib/autoApprove.ts).
  autoApprove: boolean;
  // 추론(thinking) 글자를 접이식 상자로 보일지. 끄면(기본) 추론 중에 "생각 중…" 표시만 보인다.
  showThinking: boolean;
}

export const MAX_SYSTEM_PROMPT_LENGTH = 4000;

export const DEFAULT_CSV_MAX_CHARS = 40_000;
export const MIN_CSV_MAX_CHARS = 1_000;
export const MAX_CSV_MAX_CHARS = 100_000;

export function normalizeCsvMaxChars(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_CSV_MAX_CHARS;
  return Math.min(MAX_CSV_MAX_CHARS, Math.max(MIN_CSV_MAX_CHARS, n));
}

// 여러 페이지를 거쳐 목표 페이지를 찾아가면 페이지마다 관측·찾기·클릭으로 2~3회를 쓴다.
export const DEFAULT_MAX_TOOL_HOPS = 16;
export const MIN_MAX_TOOL_HOPS = 1;
export const MAX_MAX_TOOL_HOPS = 30;
// 기본값을 8에서 16으로 올렸다. 설정 화면은 설정 전체를 저장해서, 버전 표시가 없는 예전 설정의 8은
// 사용자가 고른 값이 아니라 예전 기본값이 저장된 것으로 보고 새 기본값으로 읽는다. 이 버전 이후에 저장한
// 설정에는 maxToolHopsVersion을 붙여 사용자가 고른 8을 그대로 둔다. 배경에서 설정을 다시 쓰지 않으므로
// 설정 화면의 저장과 겹쳐 값을 잃지 않는다.
const LEGACY_DEFAULT_MAX_TOOL_HOPS = 8;
export const MAX_TOOL_HOPS_VERSION = 2;

export function normalizeMaxToolHops(raw: Partial<Settings> | undefined): number {
  const v = raw?.maxToolHops;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MAX_TOOL_HOPS;
  if (v === LEGACY_DEFAULT_MAX_TOOL_HOPS && raw?.maxToolHopsVersion !== MAX_TOOL_HOPS_VERSION) {
    return DEFAULT_MAX_TOOL_HOPS;
  }
  return Math.min(MAX_MAX_TOOL_HOPS, Math.max(MIN_MAX_TOOL_HOPS, Math.floor(v)));
}

export const SETTINGS_KEY = "settings";
export const FLAGS_KEY = "flags";
export const ACTION_LOG_KEY = "actionLog";
// 외부 본문 보호(보호 대화에서는 레시피를 저장하지 않음) 이후의 저장소 세대. 이전 세대("readRecipes")는 출처를
// 알 수 없어(보호 대화에서 생긴 인자일 수 있음) 힌트로 쓰지 않고 시작할 때 지운다(LEGACY_READ_RECIPES_KEYS).
export const READ_RECIPES_KEY = "readRecipesV2";
export const LEGACY_READ_RECIPES_KEYS = ["readRecipes"];

export const PORT_NAME = "chat";

export interface Flags {
  pdfGuidanceShown?: boolean;
}
