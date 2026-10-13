import type {
  ClickableElement,
  FileLinkList,
  FormField,
  PageContent,
  PageDescription,
  PageImage,
  ToolName,
  YoutubeTranscript,
} from "@/lib/messages";
import { toolArgsSchemas, type ToolArgs } from "@/lib/schemas";
import { normalizeNavigationUrl } from "@/lib/sanitize";
import { getSettings } from "../storage";
import { callContentTool, resolveTurnTab, type TurnTab } from "./handlers";
import { startImageDownloads } from "./downloads";
import { markOptimisticNavigation } from "../navigation";
import {
  appendRows,
  listSheets,
  parseMarkdownTable,
  readRange,
  writeRange,
} from "../google/sheets";
import { exportFile, listRecent, searchFiles } from "../google/drive";
import { readDocument } from "../document";
import { checkFileUrl } from "@/lib/fileFormat";

export interface ToolExecResult {
  ok: boolean;
  summary: string;
  data: unknown;
}

export interface ToolPreview {
  summary: string;
  details?: unknown;
}

function fmtCount(n: number, unit: string): string {
  return `${n}${unit}`;
}

export async function buildToolPreview(
  toolName: ToolName,
  parsedArgs: unknown,
): Promise<ToolPreview> {
  switch (toolName) {
    case "fill_form_fields": {
      const args = parsedArgs as ToolArgs["fill_form_fields"];
      const lines = args.fills
        .slice(0, 10)
        .map((f) => `• ${f.id}: ${truncate(f.value, 80)}`);
      const extra = args.fills.length > 10 ? `\n… 그 외 ${args.fills.length - 10}개` : "";
      return {
        summary: `${fmtCount(args.fills.length, "개")} 필드에 값을 채웁니다.`,
        details: lines.join("\n") + extra,
      };
    }
    case "download_images": {
      const args = parsedArgs as ToolArgs["download_images"];
      const { downloadFolderPrefix } = await getSettings();
      const folder = args.folderPrefix || downloadFolderPrefix;
      const sample = args.urls.slice(0, 5).map((u) => `• ${truncate(u, 100)}`);
      const extra = args.urls.length > 5 ? `\n… 그 외 ${args.urls.length - 5}개` : "";
      return {
        summary: `이미지 ${args.urls.length}개를 '${folder}/' 폴더에 저장합니다.`,
        details: sample.join("\n") + extra,
      };
    }
    case "click_element": {
      const args = parsedArgs as ToolArgs["click_element"];
      return {
        summary: `페이지 요소를 클릭합니다 (id: ${args.id}).`,
        details: `대상 id: ${args.id}\n\nfind_clickables 결과의 id로 매핑된 요소가 클릭됩니다. 링크면 해당 페이지로 이동합니다.`,
      };
    }
    case "read_document": {
      const args = parsedArgs as ToolArgs["read_document"];
      const checked = checkFileUrl(args.url);
      if (!checked.ok) throw new Error(`read_document: ${checked.reason}`);
      const target = checked.target;
      const host = new URL(target.url).host;
      const warning = `URL 전체(쿼리 포함)가 ${host}로 전송됩니다. 모르는 사이트이거나 쿼리에 대화 내용이 들어 있으면 거부하세요.`;
      if (!target.hint) {
        // 확장자가 없으면 이 주소가 파일인지 미리 알 수 없다. 승인 카드가 주된 방어선이다.
        return {
          summary: `${host}의 다운로드 링크를 로그인 쿠키와 함께 호출해, 받은 파일을 읽습니다(형식은 받은 뒤 판별).`,
          details: `${target.url}\n\n확장자가 없는 링크라 파일 다운로드가 아닌 다른 동작(로그아웃·삭제·신청 등)을 하는 주소일 수도 있습니다. 페이지에 보이는 첨부 파일 링크가 맞을 때만 허용하세요.\n${warning}`,
        };
      }
      return {
        summary: `${host}에서 파일 '${truncate(target.filename, 60)}'을(를) 로그인 쿠키와 함께 내려받아 읽습니다.`,
        details: `${target.url}\n\n${warning}`,
      };
    }
    case "navigate_to_url": {
      const args = parsedArgs as ToolArgs["navigate_to_url"];
      const url = normalizeNavigationUrl(args.url);
      const destination = new URL(url);
      return {
        summary: `현재 탭을 ${destination.hostname}(으)로 이동합니다.`,
        details: url,
      };
    }
    case "google_sheets_write_range": {
      const args = parsedArgs as ToolArgs["google_sheets_write_range"];
      const rowCount = args.values.length;
      const colCount = Math.max(...args.values.map((r) => r.length));
      const preview = args.values
        .slice(0, 5)
        .map((r) => r.slice(0, 5).map((c) => truncate(c, 40)).join(" | "))
        .join("\n");
      return {
        summary: `Google Sheets '${args.range}' 범위에 ${rowCount}×${colCount} 값 덮어쓰기.`,
        details: `스프레드시트: ${args.spreadsheetId}\n범위: ${args.range}\n\n미리보기 (최대 5×5):\n${preview}`,
      };
    }
    case "google_sheets_append_rows": {
      const args = parsedArgs as ToolArgs["google_sheets_append_rows"];
      return {
        summary: `Google Sheets '${args.range}' 끝에 ${args.values.length}행 추가.`,
        details: `스프레드시트: ${args.spreadsheetId}\n기준 범위: ${args.range}`,
      };
    }
    case "google_sheets_write_markdown_table": {
      const args = parsedArgs as ToolArgs["google_sheets_write_markdown_table"];
      return {
        summary: `Google Sheets '${args.range}'에 markdown 표 기록.`,
        details: args.markdownTable.slice(0, 400),
      };
    }
    default:
      return { summary: `도구 ${toolName} 실행` };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function parseToolArgs<T extends ToolName>(
  toolName: T,
  rawArgs: unknown,
): ToolArgs[T] {
  const schema = toolArgsSchemas[toolName];
  const result = schema.safeParse(rawArgs ?? {});
  if (!result.success) {
    throw new Error(`도구 '${toolName}' 인자 검증 실패: ${result.error.message}`);
  }
  return result.data as ToolArgs[T];
}

export async function executeTool(
  toolName: ToolName,
  parsedArgs: unknown,
  callId: string,
  turnTab: TurnTab,
  signal?: AbortSignal,
): Promise<ToolExecResult> {
  switch (toolName) {
    case "describe_page": {
      const data = await callContentTool<PageDescription>(toolName, parsedArgs, callId, turnTab);
      const regionList =
        data.landmarks.map((l) => `${l.region}(${l.clickableCount})`).join(", ") || "없음";
      return {
        ok: true,
        summary: `페이지 관측: ${truncate(data.title, 40)} / 랜드마크: ${regionList}`,
        data,
      };
    }
    case "get_page_content": {
      const data = await callContentTool<PageContent>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `본문 ${data.wordCount}자 추출: ${truncate(data.title, 60)}`,
        data,
      };
    }
    case "get_youtube_transcript": {
      const data = await callContentTool<YoutubeTranscript>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary:
          `스크립트 ${data.segmentCount}줄 추출: ${truncate(data.title, 60)}` +
          (data.truncated ? " (일부 잘림)" : "") +
          (data.complete ? "" : " (로딩 미완료, 뒷부분 누락 가능)"),
        data,
      };
    }
    case "read_document": {
      const data = await readDocument(parsedArgs as ToolArgs["read_document"], signal);
      return {
        ok: true,
        summary:
          `문서 읽기: ${truncate(data.filename, 60)} (${data.format}, ${data.totalChars}자)` +
          (data.truncated ? ` (앞 ${data.markdown.length}자만 전달)` : "") +
          (data.redirectedTo ? " (리다이렉트, 로그인 정보 없이 받음)" : ""),
        data,
      };
    }
    case "list_file_links": {
      const data = await callContentTool<FileLinkList>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary:
          `파일 링크 ${data.links.length}개 발견` +
          (data.omitted ? ` (그 외 ${data.omitted}개 생략)` : "") +
          (data.scriptDownloads ? `, 스크립트 다운로드 버튼 ${data.scriptDownloads}개(읽기 불가)` : "") +
          ".",
        data,
      };
    }
    case "translate_page": {
      const data = await callContentTool<{
        translatedNodes: number;
        scheduledNodes?: number;
        inProgress?: boolean;
        perRoot?: Array<{ name: string; collected: number }>;
        totalCollected?: number;
      }>(toolName, parsedArgs, callId, turnTab);
      const breakdown = data.perRoot?.length
        ? " [" +
          data.perRoot
            .filter((d) => d.collected > 0)
            .map((d) => `${truncate(d.name, 40)}:${d.collected}`)
            .join(", ") +
          "]"
        : "";
      const collectedHint =
        typeof data.totalCollected === "number" && data.totalCollected !== data.translatedNodes
          ? ` (수집 ${data.totalCollected})`
          : "";
      const progressSummary = data.inProgress
        ? `첫 배치 ${data.translatedNodes}개 적용, 나머지 ${data.scheduledNodes ?? 0}개 백그라운드 번역 중`
        : `페이지 내 ${data.translatedNodes}개 텍스트 노드 번역 완료`;
      return {
        ok: true,
        summary: `${progressSummary}${collectedHint}.${breakdown}`,
        data,
      };
    }
    case "find_form_fields": {
      const data = await callContentTool<FormField[]>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `입력 필드 ${data.length}개 발견.`,
        data,
      };
    }
    case "fill_form_fields": {
      const data = await callContentTool<{ filledCount: number }>(
        toolName,
        parsedArgs,
        callId,
        turnTab,
      );
      return {
        ok: true,
        summary: `${data.filledCount}개 필드 채움 완료.`,
        data,
      };
    }
    case "list_page_images": {
      const data = await callContentTool<PageImage[]>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `이미지 ${data.length}개 발견.`,
        data,
      };
    }
    case "download_images": {
      const args = parsedArgs as ToolArgs["download_images"];
      const { downloadFolderPrefix } = await getSettings();
      const folder = args.folderPrefix || downloadFolderPrefix;
      const res = await startImageDownloads(args.urls, folder);
      return {
        ok: true,
        summary: `${res.startedCount}개 다운로드 시작 (건너뜀 ${res.skippedCount}).`,
        data: res,
      };
    }
    case "query_dom": {
      const data = await callContentTool<Array<{ text: string; attrs: Record<string, string> }>>(
        toolName,
        parsedArgs,
        callId,
        turnTab,
      );
      return {
        ok: true,
        summary: `선택자 결과 ${data.length}개.`,
        data,
      };
    }
    case "navigate_to_url": {
      const args = parsedArgs as ToolArgs["navigate_to_url"];
      const url = normalizeNavigationUrl(args.url);
      const tabId = await resolveTurnTab(turnTab);
      markOptimisticNavigation(tabId);
      await chrome.tabs.update(tabId, { url });
      return {
        ok: true,
        summary: `현재 탭 이동 시작: ${truncate(url, 100)}`,
        data: { url },
      };
    }
    case "find_clickables": {
      const data = await callContentTool<ClickableElement[]>(toolName, parsedArgs, callId, turnTab);
      return {
        ok: true,
        summary: `클릭 가능 요소 ${data.length}개 발견.`,
        data,
      };
    }
    case "click_element": {
      const data = await callContentTool<{ clicked: boolean; text: string; href: string }>(
        toolName,
        parsedArgs,
        callId,
        turnTab,
      );
      if (data.clicked) {
        try {
          const tabId = await resolveTurnTab(turnTab);
          markOptimisticNavigation(tabId);
        } catch {
          /* ignore */
        }
      }
      const hint = data.href ? ` → ${truncate(data.href, 80)}` : "";
      return {
        ok: data.clicked,
        summary: `클릭 완료: "${truncate(data.text, 60) || "(텍스트 없음)"}"${hint}`,
        data,
      };
    }
    case "google_sheets_list": {
      const args = parsedArgs as ToolArgs["google_sheets_list"];
      const data = await listSheets(args.spreadsheetId);
      return {
        ok: true,
        summary: `'${truncate(data.title, 50)}' — 시트 ${data.sheets.length}개`,
        data,
      };
    }
    case "google_sheets_read_range": {
      const args = parsedArgs as ToolArgs["google_sheets_read_range"];
      const data = await readRange(args.spreadsheetId, args.range);
      const rows = data.values.length;
      const cols = Math.max(0, ...data.values.map((r) => r.length));
      return {
        ok: true,
        summary: `${data.range} 읽음 · ${rows}×${cols}`,
        data,
      };
    }
    case "google_sheets_write_range": {
      const args = parsedArgs as ToolArgs["google_sheets_write_range"];
      const data = await writeRange(args.spreadsheetId, args.range, args.values);
      return {
        ok: true,
        summary: `${args.range}에 ${data.updatedCells}개 셀 기록`,
        data,
      };
    }
    case "google_sheets_append_rows": {
      const args = parsedArgs as ToolArgs["google_sheets_append_rows"];
      const data = await appendRows(args.spreadsheetId, args.range, args.values);
      return {
        ok: true,
        summary: `${data.appendedRows}행 추가 (${data.updatedRange})`,
        data,
      };
    }
    case "google_sheets_write_markdown_table": {
      const args = parsedArgs as ToolArgs["google_sheets_write_markdown_table"];
      const values = parseMarkdownTable(args.markdownTable);
      const data = await writeRange(args.spreadsheetId, args.range, values);
      return {
        ok: true,
        summary: `markdown 표 (${values.length}행) → ${args.range}, ${data.updatedCells}셀 기록`,
        data,
      };
    }
    case "google_drive_search": {
      const args = parsedArgs as ToolArgs["google_drive_search"];
      const data = await searchFiles(args.query, args.maxResults ?? 20);
      return {
        ok: true,
        summary: `검색 결과 ${data.length}개`,
        data,
      };
    }
    case "google_drive_list_recent": {
      const args = parsedArgs as ToolArgs["google_drive_list_recent"];
      const data = await listRecent(args.mimeType, args.maxResults ?? 20);
      return {
        ok: true,
        summary: `최근 파일 ${data.length}개`,
        data,
      };
    }
    case "google_drive_export": {
      const args = parsedArgs as ToolArgs["google_drive_export"];
      const data = await exportFile(
        args.fileId,
        args.format,
        args.maxChars ?? 20_000,
      );
      return {
        ok: true,
        summary: `${args.format} export · ${data.bytes} bytes${data.truncated ? " · 잘림" : ""}`,
        data,
      };
    }
  }
}
