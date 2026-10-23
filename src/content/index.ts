import type { BgToContent, ContentResponse, ToolName } from "@/lib/messages";
import { extractMainContent } from "./extract";
import { lookupLinks } from "./links";
import { stopTranslation, translatePage } from "./translate";
import { findFormFields, fillFormFields } from "./forms";
import { listPageImages } from "./images";
import { queryDom } from "./dom";
import { findClickables, clickElement } from "./clickables";
import { describePage } from "./describe";
import { getYoutubeTranscript } from "./youtube";
import { listFileLinks, pageDownloadLinks } from "./fileLinks";
import { inspectTargets, readEffect, TargetDriftError } from "./targets";
import { pageSkeleton } from "./skeleton";
import { captureBegin, captureEnd, captureHideFixed, captureMeasure, captureScroll } from "./capture";

async function execTool(toolName: ToolName, args: unknown, callId: string): Promise<unknown> {
  switch (toolName) {
    case "describe_page":
      return describePage();
    case "get_page_content":
      return extractMainContent();
    case "get_youtube_transcript":
      return getYoutubeTranscript(
        (args ?? {}) as { includeTimestamps?: boolean; maxChars?: number },
      );
    case "translate_page":
      return translatePage(args as { targetLang: string; scope?: "visible" | "article" });
    case "find_form_fields":
      return findFormFields((args ?? {}) as { onlyVisible?: boolean });
    case "fill_form_fields":
      return fillFormFields(args as { fills: Array<{ id: string; value: string }> }, callId);
    case "list_page_images":
      return listPageImages((args ?? {}) as { minWidth?: number });
    case "list_file_links":
      return listFileLinks((args ?? {}) as { query?: string; limit?: number });
    case "query_dom":
      return queryDom(args as { selector: string; attr?: string; limit?: number });
    case "find_clickables":
      return findClickables((args ?? {}) as { query?: string; limit?: number });
    case "click_element":
      return clickElement(args as { id: string }, callId);
    case "capture_page":
      // 캡처 자체는 백그라운드가 하고, 여기서는 문서를 재고 전체 캡처의 세션을 연다(#49).
      {
        const a = (args ?? {}) as { fullPage?: boolean; token?: unknown };
        if (typeof a.token !== "string" || !a.token) throw new Error("캡처 세션 값이 없습니다.");
        return captureBegin(!!a.fullPage, a.token);
      }
    case "download_images":
    case "download_files":
      throw new Error(`${toolName}는 백그라운드에서 실행해야 합니다.`);
    case "navigate_to_url":
      throw new Error("navigate_to_url은 백그라운드에서 실행해야 합니다.");
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as BgToContent;
  if (!msg || typeof msg !== "object") return false;
  if (msg.kind === "translate_stop") {
    stopTranslation();
    sendResponse({ ok: true } satisfies ContentResponse);
    return false;
  }
  if (msg.kind === "target_inspect") {
    try {
      const data = inspectTargets(msg.ids, msg.callId, msg.prefix, msg.values);
      sendResponse({ ok: true, data } satisfies ContentResponse);
    } catch (err) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof TargetDriftError ? { diag: err.diag } : {}),
      } satisfies ContentResponse);
    }
    return false;
  }
  if (msg.kind === "action_effect") {
    sendResponse({ ok: true, data: readEffect(msg.token) } satisfies ContentResponse);
    return false;
  }
  if (msg.kind === "page_skeleton") {
    try {
      sendResponse({ ok: true, data: pageSkeleton() } satisfies ContentResponse);
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse);
    }
    return false;
  }
  if (msg.kind === "read_page_text") {
    // 다른 탭 참조: 백그라운드가 고정한 그 문서·주소일 때만 본문을 돌려준다.
    try {
      if (location.href !== msg.expectUrl) throw new Error("탭의 주소가 바뀌었습니다.");
      const content = extractMainContent();
      sendResponse({ ok: true, data: { url: location.href, title: content.title, mainText: content.mainText } } satisfies ContentResponse);
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse);
    }
    return false;
  }
  if (msg.kind === "link_lookup") {
    try {
      sendResponse({ ok: true, data: lookupLinks(msg.urls) } satisfies ContentResponse);
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse);
    }
    return false;
  }
  if (msg.kind === "download_links") {
    try {
      sendResponse({ ok: true, data: pageDownloadLinks(msg.urls) } satisfies ContentResponse);
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse);
    }
    return false;
  }
  if (msg.kind === "capture_step") {
    const run =
      msg.step === "scroll"
        ? captureScroll(msg.token, msg.y)
        : msg.step === "hide_fixed"
          ? captureHideFixed(msg.token)
          : msg.step === "measure"
            ? Promise.resolve().then(() => captureMeasure(msg.token))
            : Promise.resolve(captureEnd(msg.token));
    run.then(
      (data) => sendResponse({ ok: true, data } satisfies ContentResponse),
      (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies ContentResponse),
    );
    return true;
  }
  if (msg.kind !== "tool_exec") return false;

  execTool(msg.toolName, msg.args, msg.callId)
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
