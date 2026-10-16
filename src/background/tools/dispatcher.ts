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
import { callContentTool, isMissingReceiver, queryContent, resolveTurnTab, type TurnTab } from "./handlers";
import { startImageDownloads } from "./downloads";
import { markOptimisticNavigation, waitForNavigationSettle } from "../navigation";
import {
  clickCard,
  describeEffect,
  fillCard,
  navKind,
  type ClickEffect,
  type DomEffect,
  type TargetInfo,
} from "@/lib/actionTarget";
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

// 승인 카드를 띄우기 전에 대상이 find_* 때와 같은 요소인지 페이지에서 확인하고, 사람이 알아볼 기술을 받는다.
// content script는 이 기술을 이 호출(callId)의 승인 대상으로 남기고, 실행 직전에 다시 같은지 본다.
async function inspectTargets(ids: string[], callId: string, turnTab: TurnTab): Promise<TargetInfo[]> {
  const tabId = await resolveTurnTab(turnTab);
  await waitForNavigationSettle(tabId, 10_000);
  try {
    return await queryContent<TargetInfo[]>(tabId, { kind: "target_inspect", ids, callId }, 5_000, "대상 확인");
  } catch (err) {
    if (isMissingReceiver(err)) {
      throw new Error("대상을 찾은 페이지가 바뀌었습니다. find_clickables·find_form_fields로 다시 찾으세요.");
    }
    throw err;
  }
}

export async function buildToolPreview(
  toolName: ToolName,
  parsedArgs: unknown,
  callId: string,
  turnTab: TurnTab,
): Promise<ToolPreview> {
  switch (toolName) {
    case "fill_form_fields": {
      const args = parsedArgs as ToolArgs["fill_form_fields"];
      const infos = await inspectTargets(
        args.fills.map((f) => f.id),
        callId,
        turnTab,
      );
      return fillCard(infos.map((info, i) => ({ info, value: args.fills[i].value })));
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
      const [info] = await inspectTargets([args.id], callId, turnTab);
      return clickCard(info);
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

// 클릭 뒤 이동이 시작될 틈. markOptimisticNavigation은 500ms 안에 이동이 시작되지 않으면 기다림을 푼다.
const CLICK_SETTLE_MS = 700;

async function tabUrl(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? "";
  } catch {
    return "";
  }
}

// 이 탭이 연 새 탭(target=_blank, window.open)을 센다. 돌려준 함수를 부르면 관찰을 끝내고 결과를 준다.
function watchNewTabs(tabId: number): () => boolean {
  let opened = false;
  const onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId === tabId) opened = true;
  };
  chrome.tabs.onCreated.addListener(onCreated);
  return () => {
    chrome.tabs.onCreated.removeListener(onCreated);
    return opened;
  };
}

async function observeClickEffect(
  tabId: number,
  before: string,
  token: string,
  newTabs: () => boolean,
): Promise<ClickEffect> {
  await new Promise((r) => setTimeout(r, CLICK_SETTLE_MS));
  await waitForNavigationSettle(tabId, 10_000);
  const url = (await tabUrl(tabId)) || before;
  let dom: DomEffect | null = null;
  let sameDocument: boolean | null;
  try {
    dom = await queryContent<DomEffect | null>(tabId, { kind: "action_effect", token }, 1_500, "클릭 결과 확인");
    // 관찰 기록이 없으면 클릭한 문서가 아니다(새 페이지가 떴다).
    sameDocument = dom !== null;
  } catch (err) {
    // 받는 쪽이 없으면 문서가 바뀌는 중이거나 content script가 없는 페이지다. 시간 초과는 페이지가 멈춘 것(알림창 등).
    sameDocument = isMissingReceiver(err) ? false : null;
  }
  return { navigation: navKind(before, url), url, sameDocument, newTab: newTabs(), dom };
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
          (data.truncated ? ` (앞 ${data.markdown.length}자만 전달)` : ""),
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
      const data = await callContentTool<{
        filledCount: number;
        results: Array<{ id: string; label: string; applied: boolean; note?: string }>;
      }>(toolName, parsedArgs, callId, turnTab);
      const failed = data.results.filter((r) => !r.applied);
      const failNote = failed.length
        ? ` 반영 안 됨 ${failed.length}개: ${failed
            .slice(0, 3)
            .map((r) => `${r.label || r.id}(${truncate(r.note ?? "", 60)})`)
            .join(", ")}`
        : "";
      return {
        ok: data.filledCount > 0,
        summary: `${data.results.length}개 중 ${data.filledCount}개 칸에 값이 반영됐습니다.${failNote}`,
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
      const tabId = await resolveTurnTab(turnTab);
      const before = await tabUrl(tabId);
      const newTabs = watchNewTabs(tabId);
      let data: { clicked: boolean; text: string; href: string; effectToken: string };
      try {
        data = await callContentTool(toolName, parsedArgs, callId, turnTab);
      } catch (err) {
        newTabs();
        throw err;
      }
      markOptimisticNavigation(tabId);
      const effect = await observeClickEffect(tabId, before, data.effectToken, newTabs);
      return {
        ok: data.clicked,
        summary: `'${truncate(data.text, 60) || "(글자 없음)"}' 클릭: ${describeEffect(effect)}`,
        data: { text: data.text, href: data.href, effect },
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
