import type { ModelId } from "./models";
import type { ReadableFormat } from "./fileFormat";
import type { ReadHint } from "./readRecipe";
import type { LoginSite } from "./loginPolicy";

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
  | "download_files"
  | "capture_page"
  | "query_dom"
  | "navigate_to_url"
  // 사용자가 저장한 링크(템플릿)에 자리 값을 넣어 연다(#86).
  | "open_saved_link"
  | "find_clickables"
  | "click_element"
  // 로그인 양식에 KeePassXC의 로그인 정보를 넣고 제출한다(docs/design/login-automation.md). 값은 모델에 가지 않는다.
  | "sign_in"
  | "google_sheets_list"
  | "google_sheets_read_range"
  | "google_sheets_write_range"
  | "google_sheets_append_rows"
  | "google_sheets_write_markdown_table"
  | "google_drive_search"
  | "google_drive_list_recent"
  | "google_drive_export"
  | "read_other_tabs"
  | "read_linked_pages";

export const SENSITIVE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "fill_form_fields",
  "download_images",
  // 지금 페이지의 첨부·다운로드 링크를 로그인 쿠키와 함께 내려받는다(#48). 늘 사용자가 카드에서 고른다.
  "download_files",
  // 보고 있는 페이지를 캡처해 저장한다(#49). 전체 캡처는 스크롤·스타일을 잠시 바꾸므로 늘 묻는다.
  "capture_page",
  "navigate_to_url",
  // 저장한 링크를 연다(#86). 모델이 만든 자리 값이 그 사이트로 전송된다. 자동 실행이 켜져 있으면 카드 없이(보호 중·개인정보 모양은 묻기).
  "open_saved_link",
  "click_element",
  // 승인한 사이트(출처 → KeePassXC 항목)에서만 카드 없이, 그 밖에는 카드에서 항목을 고른다.
  "sign_in",
  // 모델이 고른 URL로 쿠키를 실어 GET을 보낸다. 프롬프트 주입이 쿼리에 대화 내용을 담아 외부로 보낼 수 있다.
  "read_document",
  // 사용자가 고른 다른 탭의 본문(다른 사이트의 정보)을 모델 제공자로 보낸다. 늘 사용자가 탭을 고른다.
  "read_other_tabs",
  // 지금 페이지의 링크를 쿠키 없이 받아 본문을 읽는다. 늘 사용자가 읽을 링크를 고른다.
  "read_linked_pages",
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
  // 대상이 든 묶음(행·패널·목록 항목)의 화면 글자(입력값·편집 영역·숨은 글자 제외, 200자). 같은 글자의 대상을 구분한다.
  context?: string;
  // ARIA·HTML 상태(selected·checked·pressed·expanded·current·disabled). 있는 것만.
  states?: Record<string, string>;
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
  // 관측한 창이 따라가는 팝업 창이면 그 안내(백그라운드가 붙인다).
  window?: string;
}

// 모델에 돌려주는 입력 칸(#43). 사용자가 입력한 값은 담지 않는다.
export interface FormField {
  id: string;
  label: string;
  placeholder: string;
  type: string;
  role: string;
  // 칸이 든 행·묶음의 화면 글자(입력값·편집 영역·숨은 글자 제외, 표제가 있으면 앞에, 200자). 라벨 없는 행 체크박스를
  // 보낸 사람·제목 같은 행 글자로 구분한다(#56).
  context?: string;
  // 글자 칸(input·textarea): 값이 있는지만.
  hasValue?: boolean;
  // checkbox·radio: 체크 여부만(value 속성은 담지 않는다).
  checked?: boolean;
  // select: 선택지의 보이는 글자(option.label)와 비활성 여부. 고를 때는 이 글자를 그대로 쓴다.
  // hidden: 숨긴 선택지(글자를 보내지 않고 고를 수 없음). truncated: 글자가 길어 잘림(그 글자로는 고를 수 없음).
  options?: Array<{ label: string; disabled?: boolean; hidden?: boolean; truncated?: boolean }>;
  // 선택된 선택지의 위치(0부터). 다중 선택 칸이나 개인정보 단서가 있는 칸이면 담지 않는다.
  selectedIndex?: number;
  // 다중 선택 칸(채우기는 지원하지 않는다).
  multiple?: boolean;
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
  // false면 read_document로 읽을 수 없고 download_files로 저장만 할 수 있는 파일(zip·구형 Office·이미지 등, #48).
  readable?: false;
  // readable=false인 링크의 확장자.
  ext?: string;
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
  // choiceIds: 선택 카드(choices)에서 고른 후보 id. 백그라운드가 고정한 후보의 부분집합만 받아들인다.
  // allowToolThisChat: 카드가 제안했을 때만 유효(chatGrantOffer). 이번 대화 동안 이 도구는 같은 조건이면 묻지 않는다(#53).
  // allowUrlsThisChat: 카드가 제안했을 때만 유효(personalUrlOffer). 카드에 보인 개인정보 모양 주소를 이번 대화에서 다시 묻지 않는다.
  | {
      kind: "approve_tool";
      callId: string;
      allowLinksThisTurn?: boolean;
      choiceIds?: string[];
      allowToolThisChat?: boolean;
      allowUrlsThisChat?: boolean;
      // 자동 로그인 카드(loginSiteOffer)에서 고른 항목을 이 출처에 묶어 다음부터 자동 로그인한다.
      rememberLoginSite?: boolean;
    }
  | { kind: "cancel_tool"; callId: string }
  // 이 대화에서 허락한 도구를 취소한다(#53).
  | { kind: "revoke_chat_grant"; tool: string }
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
  // 이번 요청에서 몇 번째 모델 요청(도구 순환 단계)인지와 지금 한도(#55). 이어 가기를 허락하면 한도가 늘어난다.
  | { kind: "hop_progress"; used: number; limit: number }
  // 도구 호출 순환 한도에 닿음: 지금까지 한 일 요약과 함께 extra번 더 진행할지 묻는다(#55).
  // 허락·거부는 승인 카드와 같은 approve_tool·cancel_tool(callId)로 돌려준다. 거부하면 도구 없이 지금까지의 결과로 답한다.
  | {
      kind: "hop_limit";
      callId: string;
      used: number;
      extra: number;
      summary: { total: number; failed: number; cancelled: number; byTool: Array<{ tool: string; count: number }>; recent: string[] };
    }
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
      // 이번 대화 허락 대상 도구(src/lib/chatGrant.ts)이고 허락으로 덮을 수 있는 호출이면 true:
      // "승인 + 이번 대화 동안 이 도구 묻지 않기"를 함께 보여 준다(#53).
      chatGrantOffer?: boolean;
      // 카드가 뜬 이유가 개인정보 모양 주소뿐이면 true: "승인 + 이 주소는 이번 대화에서 다시 묻지 않기"를 함께 보여 준다.
      personalUrlOffer?: boolean;
      // sign_in 카드: 이 출처(정확한 출처)를 자동 로그인 사이트로 묶자는 제안. 값은 표시할 출처.
      loginSiteOffer?: string;
      // 선택 카드(다른 탭 고르기): 후보와 최대 선택 수. 고른 id만 승인 메시지로 돌려준다.
      choices?: Array<{ id: string; label: string; sub: string }>;
      choiceLimit?: number;
      // 처음부터 체크해 둘 후보(경고가 붙은 후보는 빼서 사용자가 직접 고르게).
      choiceDefaults?: string[];
      // 직접 조작할 사이트의 손 넘기기 카드(0.2.2): 사용자가 페이지에서 직접 하고 "했어요"(approve_tool)를 누른다.
      // 표시한 대상을 사용자가 누르면 백그라운드가 카드 없이 이어 간다(결과 줄이 오면 카드를 닫는다).
      handoff?: boolean;
    }
  | {
      kind: "tool_result";
      callId: string;
      toolName: ToolName;
      ok: boolean;
      summary: string;
    }
  // 이 대화에서 허락한 도구와 범위(download_images는 저장 폴더). 바뀔 때와 요청을 시작할 때 보낸다(#53).
  | { kind: "chat_grants"; grants: Array<{ tool: ToolName; scope: string }> }
  | { kind: "error"; message: string }
  | { kind: "info"; title: string; message: string }
  // 턴을 마친 뒤 탭이 다른 화면에 있으면 "이 페이지 기억하기" 제안(저장은 사용자가 이름을 확인하고 누를 때만).
  | { kind: "page_save_offer"; offer: PageOfferData }
  | { kind: "settings_warning"; message: string };

// "이 페이지 기억하기" 카드(#30·#86). params: 주소의 쿼리 값(카드에서 고정·자리·빼기를 고른다). evicts: 저장 링크가 가득 차
// 새 링크를 저장하면 지워질 링크 이름.
export interface PageOfferData {
  offerId: string;
  url: string;
  title: string;
  site: string;
  warning: string | null;
  params: Array<{ key: string; value: string }>;
  evicts: string | null;
  savedTemplates: string[];
}

export type BgToContent =
  // trusted: click_element를 실제 입력 클릭으로 준비만 하라는 가드 토큰(0.2.0). 모델 인자가 아니라 백그라운드가 붙인다.
  | { kind: "tool_exec"; toolName: ToolName; args: unknown; callId: string; trusted?: string }
  // 실제 입력 클릭의 단계(src/lib/trustedClick.ts). check·result·cancel은 준비한 top 문서에만, guard_arm·guard_disarm은
  // top이 아닌 프레임마다 그 문서에 보낸다.
  | { kind: "trusted_click_check"; token: string }
  | { kind: "trusted_click_result"; token: string }
  // 떼기 전: 가드 리스너가 아직 이 문서에 살아 있는지(cancel이면 먼저 막힘으로 바꾼다).
  | { kind: "trusted_click_alive"; token: string; cancel: boolean }
  | { kind: "trusted_click_cancel"; token: string; reason: string }
  | { kind: "input_guard_arm"; token: string; ms: number }
  | { kind: "input_guard_disarm"; token: string }
  // 손 넘기기(직접 조작할 사이트, 0.2.2): 승인 대상을 표시하고(show), 사용자가 표시한 대상을 눌렀는지 묻고(status), 표시를
  // 뗀다(end). 표시한 top 문서에만 보낸다.
  | { kind: "handoff_show"; token: string; ids: string[]; callId: string; prefix: "c" | "f" }
  | { kind: "handoff_status"; token: string }
  | { kind: "handoff_end"; token: string }
  | { kind: "translate_batch"; texts: string[]; targetLang: string }
  | { kind: "translate_stop" }
  // 승인 카드용: id들이 find_* 때와 같은 요소인지 확인하고 이 호출의 승인 대상으로 남긴다.
  // prefix는 기대하는 대상 종류("c" 클릭, "f" 입력 칸).
  | { kind: "target_inspect"; ids: string[]; callId: string; prefix: "c" | "f"; values?: string[] }
  // 자동 로그인(sign_in): 칸 둘레의 로그인 양식 모양을 읽고 넣을 칸·제출 버튼을 이 호출의 승인 대상으로 남긴다(login_inspect),
  // 비밀번호 관리자의 값을 넣고 제출한다(login_fill — 값은 백그라운드에서만 오고 응답에 싣지 않는다), 제출 뒤 칸이 그대로인지 본다.
  | { kind: "login_inspect"; id: string; callId: string }
  | {
      kind: "login_fill";
      callId: string;
      fills: Array<{ id: string; value: string }>;
      submit: { submitId?: string; submitUrls: string[]; submitMethods: string[] } | null;
      approved: { origin: string; blocks: string[] } | null;
    }
  | { kind: "login_field_shown"; id: string }
  // 도구가 중단됐다: 아직 제출하지 않았으면 이 호출의 제출을 하지 않는다.
  | { kind: "login_cancel"; callId: string }
  // click_element 뒤 같은 문서에서 관찰한 변화를 읽는다.
  | { kind: "action_effect"; token: string }
  // 동작 기록용 페이지 뼈대 해시(최상위 문서).
  | { kind: "page_skeleton" }
  // 다른 탭 참조: 이 문서의 본문. 지금 주소가 expectUrl과 다르면 읽지 않는다.
  | { kind: "read_page_text"; expectUrl: string }
  // 저장 카드 초안(#86): 이 문서의 화면 글자(modelText — 입력 칸 값·편집 영역·숨은 내용 제외). 주소가 expectUrl과 다르면 읽지 않는다.
  | { kind: "screen_text"; expectUrl: string; max: number }
  // read_linked_pages: 이 주소들이 지금 문서(최상위 + 접근 가능한 같은 출처 프레임)의 링크에 있는지와 링크 글자.
  | { kind: "link_lookup"; urls: string[] }
  // download_files(#48): 지금 문서(최상위 + 접근 가능한 같은 출처 프레임)의 http(s) 링크(후보 고정용).
  // urls(모델이 넘긴 주소)는 돌려주는 수의 한도와 관계없이 끝까지 찾는다.
  | { kind: "download_links"; urls: string[] }
  // capture_page(#49) 전체 캡처의 단계. begin은 도구 실행(tool_exec)으로 받고(주입 포함), 그 뒤 단계는 같은 문서에만
  // 보낸다(문서가 바뀌었으면 받는 쪽이 없어 실패). token은 begin이 돌려준 세션 값.
  | { kind: "capture_step"; token: string; step: "scroll"; y: number }
  | { kind: "capture_step"; token: string; step: "hide_fixed" | "measure" | "end" };

export interface ContentResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  // 실패 진단(디버그 로그 전용, 모델에 보내지 않는다 — 글자 내용 없이 종류·길이만).
  diag?: string;
}

export type RuntimeMsg =
  | { kind: "settings_updated" }
  // 바꾼 필드만 최신 설정에 합쳐 저장(#99). 백그라운드가 차례로 처리해 겹친 저장이 서로 덮지 않는다.
  | { kind: "settings_patch"; patch: Partial<Settings> }
  // 설정 화면의 동작 기록 개수 보기·지우기. 쓰기를 백그라운드 한곳으로 모은다.
  | { kind: "action_log_count" }
  | { kind: "action_log_clear" }
  | { kind: "translate_text_batch"; texts: string[]; targetLang: string };

export interface Settings {
  // 모델 제공자(#97). OpenRouter의 키·모델은 아래 openRouterApiKey·model(예전 설정 그대로), 다른 제공자는 apiKeys·providerModels.
  provider: "openrouter" | "openai" | "gemini" | "anthropic";
  openRouterApiKey: string;
  model: ModelId;
  apiKeys: { openai?: string; gemini?: string; anthropic?: string };
  providerModels: { openai?: string; gemini?: string; anthropic?: string };
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
  // "이 페이지 기억하기": 사용자가 저장한 페이지를 같은 사이트에서 모델에 이동 후보로 준다(#30).
  rememberPages: boolean;
  // 클릭을 chrome.debugger의 실제 마우스 입력으로 보낼지(0.2.0). 끄면(기본) 페이지 스크립트로 누른다.
  trustedInput: boolean;
  // 직접 조작할 사이트(출처 목록, 0.2.2). 이 사이트에서는 클릭·입력을 대신하지 않고 대상을 표시해 사용자가 직접 한다.
  manualSites: string[];
  // 자동 로그인을 승인한 사이트(정확한 출처 → KeePassXC 항목 묶음, docs/design/login-automation.md). 사용자가 카드나 설정에서
  // 고른 것만 들어간다. 아이디·비밀번호는 두지 않는다.
  loginSites: LoginSite[];
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
// 여러 페이지를 거치는 작업(검색 → 날짜·인원 → 결과 비교)을 위해 100까지 고를 수 있다(#55). 한도에 닿으면
// 끝내지 않고 이어 가기 카드로 묻고, 같은 호출 반복·같은 실패는 한도와 별개로 멈춘다(src/lib/hopGuard.ts).
export const MAX_MAX_TOOL_HOPS = 100;
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
