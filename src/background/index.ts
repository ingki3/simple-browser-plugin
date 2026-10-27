import { keepassxcAssociate, keepassxcForget, keepassxcStatus } from "./keepassxc";
import { PORT_NAME, SETTINGS_KEY, type PanelToBg, type Settings } from "@/lib/messages";
import { normalizeSettings } from "@/lib/settings";
import { ChatAgent } from "./openrouter";
import { applySettingsPatch, invalidateSettingsCache } from "./storage";
import { deletePages, draftLink, listPages, savePage, updateLink } from "./savedPagesStore";
import type { ParamChoice } from "@/lib/savedPages";
import { clearActionLog, pruneActionLog, storedCounts } from "./actionLog";
import { translateBatch } from "./translator";
import { registerDebugSink, debugLog } from "./debug";
import {
  clearGoogleToken,
  connectGoogle,
  getGoogleConnectionState,
} from "./google/auth";

pruneActionLog();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[sidePanel.setPanelBehavior]", err));
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => {
      console.warn("[sidePanel.open]", err);
    });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  let agent: ChatAgent | null = null;
  let activeConversationId: string | null = null;
  registerDebugSink(port);
  debugLog("port:connect");

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as PanelToBg;
    if (!msg || typeof msg !== "object") return;

    switch (msg.kind) {
      case "user_msg": {
        if (!agent || activeConversationId !== msg.conversationId) {
          agent?.abort();
          agent = new ChatAgent(port);
          activeConversationId = msg.conversationId;
        }
        agent.sendUserTurn(msg.text).catch((err) => {
          console.error("[sendUserTurn]", err);
        });
        return;
      }
      case "approve_tool":
        agent?.approveTool(
          msg.callId,
          msg.allowLinksThisTurn === true,
          Array.isArray(msg.choiceIds) ? msg.choiceIds.filter((x): x is string => typeof x === "string") : undefined,
          msg.allowToolThisChat === true,
          msg.allowUrlsThisChat === true,
          msg.rememberLoginSite === true,
        );
        return;
      case "revoke_chat_grant":
        agent?.revokeChatGrant(String(msg.tool));
        return;
      case "revoke_task":
        agent?.revokeTask();
        return;
      case "cancel_tool":
        agent?.cancelTool(msg.callId);
        return;
      case "abort_stream":
        agent?.abort();
        return;
      case "reset_conversation":
        agent?.abort();
        agent = new ChatAgent(port);
        activeConversationId = msg.conversationId;
        return;
      case "heartbeat":
        // panel liveness ping — keep the service worker from idling out
        return;
    }
  });

  // 설정이 바뀌면 지금 대화에 알린다(제공자·키·모델이 바뀌면 진행 중인 번역을 멈춘다).
  const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes[SETTINGS_KEY]) agent?.onSettingsChanged(normalizeSettings(changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined));
  };
  chrome.storage.onChanged.addListener(onStorage);

  port.onDisconnect.addListener(() => {
    chrome.storage.onChanged.removeListener(onStorage);
    agent?.abort();
    agent = null;
    activeConversationId = null;
  });
});

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { kind?: string };

  // 저장한 페이지: 이 확장의 화면(패널·설정, 탭으로 연 경우 포함)에서만 받는다. content script가 보낸 메시지는
  // 발신 주소가 웹 페이지라 거절된다.
  if (
    m.kind === "save_page" ||
    m.kind === "saved_pages_list" ||
    m.kind === "saved_pages_delete" ||
    m.kind === "saved_link_draft" ||
    m.kind === "saved_link_update"
  ) {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as {
      offerId?: unknown;
      name?: unknown;
      purpose?: unknown;
      choices?: unknown;
      hints?: unknown;
      confirmedWarning?: unknown;
      id?: unknown;
    };
    const job: Promise<unknown> =
      m.kind === "save_page"
        ? savePage({
            offerId: String(p.offerId ?? ""),
            name: String(p.name ?? ""),
            purpose: String(p.purpose ?? ""),
            choices: parseChoices(p.choices),
            hints: parseHints(p.hints),
            confirmedWarning: p.confirmedWarning === true,
          })
        : m.kind === "saved_link_draft"
          ? draftLink(String(p.offerId ?? ""))
          : m.kind === "saved_link_update"
            ? updateLink(String(p.id ?? ""), { name: p.name, purpose: p.purpose, hints: p.hints }).then(() => listPages())
            : m.kind === "saved_pages_delete"
              ? deletePages(typeof p.id === "string" ? p.id : null).then(() => listPages())
              : listPages();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (m.kind === "settings_patch") {
    // 이 확장의 화면(패널)에서만 받는다.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const patch = (msg as { patch?: unknown }).patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      sendResponse({ ok: false, error: "잘못된 설정" });
      return false;
    }
    applySettingsPatch(patch as Partial<Settings>)
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  // 자동 로그인의 KeePassXC 연결(설정 화면). 이 확장의 화면에서만 받는다.
  if (m.kind === "keepassxc_status" || m.kind === "keepassxc_associate" || m.kind === "keepassxc_forget") {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const job =
      m.kind === "keepassxc_associate"
        ? keepassxcAssociate()
        : m.kind === "keepassxc_forget"
          ? keepassxcForget().then(() => keepassxcStatus())
          : keepassxcStatus();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (m.kind === "settings_updated") {
    invalidateSettingsCache();
    sendResponse({ ok: true });
    return true;
  }

  if (m.kind === "action_log_count" || m.kind === "action_log_clear") {
    (m.kind === "action_log_clear" ? clearActionLog().then(() => ({ log: 0, recipes: 0 })) : storedCounts())
      .then((count) => sendResponse({ ok: true, data: count }))
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true;
  }

  if (m.kind === "google_connect") {
    debugLog("google:connect:received");
    if (typeof chrome.identity === "undefined") {
      const msg =
        "chrome.identity API를 사용할 수 없습니다. 확장에 'identity' 권한이 적용되지 않았다는 뜻입니다. chrome://extensions 에서 이 확장을 '삭제' 후 다시 '압축해제된 확장 프로그램 로드'로 재설치해 주세요.";
      debugLog("google:connect:no_identity", msg, "error");
      sendResponse({ ok: false, error: msg });
      return true;
    }
    connectGoogle()
      .then(() => {
        debugLog("google:connect:ok");
        sendResponse({ ok: true });
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err.message : String(err);
        debugLog("google:connect:error", e, "error");
        sendResponse({ ok: false, error: e });
      });
    return true;
  }

  if (m.kind === "google_disconnect") {
    clearGoogleToken()
      .then(() => {
        debugLog("google:disconnect:ok");
        sendResponse({ ok: true });
      })
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "google_status") {
    getGoogleConnectionState()
      .then((state) => sendResponse({ ok: true, data: state }))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "google_diag") {
    (async () => {
      const mf = chrome.runtime.getManifest();
      const state = await getGoogleConnectionState();
      const hasIdentity = typeof chrome.identity !== "undefined";
      let redirectUrl = "";
      let identityCallError = "";
      if (hasIdentity) {
        try {
          redirectUrl = chrome.identity.getRedirectURL();
        } catch (err) {
          identityCallError = err instanceof Error ? err.message : String(err);
        }
      }
      const masked =
        state.clientId.length > 18
          ? state.clientId.slice(0, 8) + "…" + state.clientId.slice(-10)
          : state.clientId;
      const oauth2 = (mf as typeof mf & {
        oauth2?: { client_id?: string; scopes?: string[] };
      }).oauth2;
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: mf.version,
        manifestPermissions: mf.permissions ?? [],
        hostPermissions: mf.host_permissions ?? [],
        manifestOauth2Present: !!oauth2,
        manifestOauth2Scopes: oauth2?.scopes ?? [],
        identityApiPresent: hasIdentity,
        identityApiError: identityCallError,
        redirectUrlFromIdentity: redirectUrl,
        googleClientIdConfigured: state.configured,
        googleClientIdPreview: masked || "(비어 있음)",
        googleTokenCached: state.connected,
        timestamp: new Date().toISOString(),
      };
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "translate_text_batch") {
    const payload = msg as { kind: "translate_text_batch"; texts: string[]; targetLang: string };
    if (!Array.isArray(payload.texts) || typeof payload.targetLang !== "string") {
      sendResponse({ ok: false, error: "invalid payload" });
      return true;
    }
    translateBatch(payload.texts, payload.targetLang)
      .then((translations) => sendResponse({ ok: true, data: translations }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: message });
      });
    return true; // keep channel open for async response
  }

  return false;
});

// 저장 카드의 쿼리 값 선택(패널에서 온 값이라 형태를 다시 본다).
function parseChoices(raw: unknown): ParamChoice[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((c): ParamChoice => {
    const x = c as { mode?: unknown; slot?: unknown };
    if (x?.mode === "drop") return { mode: "drop" };
    if (x?.mode === "slot") return { mode: "slot", slot: typeof x.slot === "string" ? x.slot : "" };
    return { mode: "keep" };
  });
}

function parseHints(raw: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  return out;
}
