import type { BgToContent, ContentResponse, ToolName } from "@/lib/messages";
import { waitForNavigationSettle } from "../navigation";
import { debugLog, timeSpan } from "../debug";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS: Partial<Record<ToolName, number>> = {
  translate_page: 180_000,
  download_images: 60_000,
};

export async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("활성 탭을 찾을 수 없습니다.");
  if (tab.url && /^(chrome|edge|about):/i.test(tab.url)) {
    throw new Error("브라우저 내부 페이지에서는 이 도구를 사용할 수 없습니다.");
  }
  return tab.id;
}

function getContentScriptFiles(): string[] {
  const manifest = chrome.runtime.getManifest();
  const entries = manifest.content_scripts ?? [];
  const files: string[] = [];
  for (const entry of entries) {
    for (const js of entry.js ?? []) files.push(js);
  }
  return files;
}

async function injectContentScript(tabId: number): Promise<void> {
  const files = getContentScriptFiles();
  if (!files.length) throw new Error("manifest에 content script가 선언되지 않았습니다.");
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files,
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} 응답이 ${Math.round(ms / 1000)}초 안에 오지 않았습니다. 페이지가 이동했거나 스크립트가 응답하지 않을 수 있습니다.`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function callContentTool<T = unknown>(
  toolName: ToolName,
  args: unknown,
  callId: string,
): Promise<T> {
  const endCall = timeSpan(`tool:${toolName}`);
  const tabId = await getActiveTabId();
  // If a navigation is in flight (e.g. just after click_element), wait for it
  // to settle so the content script in the new page has registered its listener.
  const navStart = Date.now();
  await waitForNavigationSettle(tabId, 10_000);
  const navWait = Date.now() - navStart;
  if (navWait > 50) debugLog("navigation:settled", `${navWait}ms`);
  const msg: BgToContent = { kind: "tool_exec", toolName, args, callId };
  const timeoutMs = TOOL_TIMEOUT_MS[toolName] ?? DEFAULT_TOOL_TIMEOUT_MS;

  const send = async (): Promise<ContentResponse<T>> => {
    return (await withTimeout(
      chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<ContentResponse<T>>,
      timeoutMs,
      `컨텐트 스크립트(${toolName})`,
    )) as ContentResponse<T>;
  };

  let res: ContentResponse<T>;
  try {
    res = await send();
  } catch (err) {
    const looksLikeMissing =
      err instanceof Error &&
      /Could not establish connection|Receiving end does not exist/i.test(err.message);
    if (!looksLikeMissing) {
      endCall("fail");
      throw err;
    }
    debugLog("tool:inject_retry", toolName, "warn");
    try {
      await injectContentScript(tabId);
    } catch (injectErr) {
      endCall("inject_fail");
      const baseMsg = injectErr instanceof Error ? injectErr.message : String(injectErr);
      throw new Error(`이 탭에 확장을 주입할 수 없습니다: ${baseMsg}`);
    }
    try {
      res = await send();
    } catch (retryErr) {
      endCall("retry_fail");
      const baseMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(`컨텐트 스크립트 호출 실패: ${baseMsg}`);
    }
  }

  if (!res?.ok) {
    endCall(`error: ${res?.error ?? "?"}`);
    throw new Error(res?.error ?? "컨텐트 스크립트 호출 실패");
  }
  endCall("ok");
  return res.data as T;
}
