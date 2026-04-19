import type {
  ClickableElement,
  FormField,
  PageContent,
  PageDescription,
  PageImage,
  ToolName,
} from "@/lib/messages";
import { toolArgsSchemas, type ToolArgs } from "@/lib/schemas";
import { getSettings } from "../storage";
import { callContentTool, getActiveTabId } from "./handlers";
import { startImageDownloads } from "./downloads";
import { markOptimisticNavigation } from "../navigation";

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
): Promise<ToolExecResult> {
  switch (toolName) {
    case "describe_page": {
      const data = await callContentTool<PageDescription>(toolName, parsedArgs, callId);
      const regionList =
        data.landmarks.map((l) => `${l.region}(${l.clickableCount})`).join(", ") || "없음";
      return {
        ok: true,
        summary: `페이지 관측: ${truncate(data.title, 40)} / 랜드마크: ${regionList}`,
        data,
      };
    }
    case "get_page_content": {
      const data = await callContentTool<PageContent>(toolName, parsedArgs, callId);
      return {
        ok: true,
        summary: `본문 ${data.wordCount}자 추출: ${truncate(data.title, 60)}`,
        data,
      };
    }
    case "translate_page": {
      const data = await callContentTool<{
        translatedNodes: number;
        perRoot?: Array<{ name: string; collected: number }>;
        totalCollected?: number;
      }>(toolName, parsedArgs, callId);
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
      return {
        ok: true,
        summary: `페이지 내 ${data.translatedNodes}개 텍스트 노드 번역 완료${collectedHint}.${breakdown}`,
        data,
      };
    }
    case "find_form_fields": {
      const data = await callContentTool<FormField[]>(toolName, parsedArgs, callId);
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
      );
      return {
        ok: true,
        summary: `${data.filledCount}개 필드 채움 완료.`,
        data,
      };
    }
    case "list_page_images": {
      const data = await callContentTool<PageImage[]>(toolName, parsedArgs, callId);
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
      );
      return {
        ok: true,
        summary: `선택자 결과 ${data.length}개.`,
        data,
      };
    }
    case "find_clickables": {
      const data = await callContentTool<ClickableElement[]>(toolName, parsedArgs, callId);
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
      );
      if (data.clicked) {
        try {
          const tabId = await getActiveTabId();
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
  }
}
