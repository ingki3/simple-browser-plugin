import type { BgToContent, ContentResponse, ToolName } from "@/lib/messages";
import { extractMainContent } from "./extract";
import { translatePage } from "./translate";
import { findFormFields, fillFormFields } from "./forms";
import { listPageImages } from "./images";
import { queryDom } from "./dom";
import { findClickables, clickElement } from "./clickables";
import { describePage } from "./describe";

async function execTool(toolName: ToolName, args: unknown): Promise<unknown> {
  switch (toolName) {
    case "describe_page":
      return describePage();
    case "get_page_content":
      return extractMainContent();
    case "translate_page":
      return translatePage(args as { targetLang: string; scope?: "visible" | "article" });
    case "find_form_fields":
      return findFormFields((args ?? {}) as { onlyVisible?: boolean });
    case "fill_form_fields":
      return fillFormFields(args as { fills: Array<{ id: string; value: string }> });
    case "list_page_images":
      return listPageImages((args ?? {}) as { minWidth?: number });
    case "query_dom":
      return queryDom(args as { selector: string; attr?: string; limit?: number });
    case "find_clickables":
      return findClickables((args ?? {}) as { query?: string; limit?: number });
    case "click_element":
      return clickElement(args as { id: string });
    case "download_images":
      throw new Error("download_images는 백그라운드에서 실행해야 합니다.");
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as BgToContent;
  if (!msg || typeof msg !== "object") return false;
  if (msg.kind !== "tool_exec") return false;

  execTool(msg.toolName, msg.args)
    .then((data) => {
      const response: ContentResponse = { ok: true, data };
      sendResponse(response);
    })
    .catch((err: unknown) => {
      const response: ContentResponse = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      sendResponse(response);
    });

  return true;
});
