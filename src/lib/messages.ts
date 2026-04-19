import type { ModelId } from "./models";

export type ToolName =
  | "describe_page"
  | "get_page_content"
  | "translate_page"
  | "find_form_fields"
  | "fill_form_fields"
  | "list_page_images"
  | "download_images"
  | "query_dom"
  | "find_clickables"
  | "click_element";

export const SENSITIVE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "fill_form_fields",
  "download_images",
  "click_element",
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
  | { kind: "settings_warning"; message: string };

export type BgToContent =
  | { kind: "tool_exec"; toolName: ToolName; args: unknown; callId: string }
  | { kind: "translate_batch"; texts: string[]; targetLang: string };

export interface ContentResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export type RuntimeMsg =
  | { kind: "settings_updated" }
  | { kind: "translate_text_batch"; texts: string[]; targetLang: string };

export interface Settings {
  apiKey: string;
  model: ModelId;
  translationTargetLang: string;
  downloadFolderPrefix: string;
  maxToolHops: number;
}

export const DEFAULT_MAX_TOOL_HOPS = 8;
export const MIN_MAX_TOOL_HOPS = 1;
export const MAX_MAX_TOOL_HOPS = 30;

export const SETTINGS_KEY = "settings";

export const PORT_NAME = "chat";
