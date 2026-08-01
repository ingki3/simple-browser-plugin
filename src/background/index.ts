import { PORT_NAME, type PanelToBg } from "@/lib/messages";
import { ChatAgent } from "./openrouter";
import { invalidateSettingsCache } from "./storage";
import { translateBatch } from "./translator";
import { registerDebugSink, debugLog } from "./debug";
import {
  clearGoogleToken,
  connectGoogle,
  getGoogleConnectionState,
} from "./google/auth";

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
          agent = new ChatAgent(port);
          activeConversationId = msg.conversationId;
        }
        agent.sendUserTurn(msg.text).catch((err) => {
          console.error("[sendUserTurn]", err);
        });
        return;
      }
      case "approve_tool":
        agent?.approveTool(msg.callId);
        return;
      case "cancel_tool":
        agent?.cancelTool(msg.callId);
        return;
      case "abort_stream":
        agent?.abort();
        return;
      case "reset_conversation":
        agent = new ChatAgent(port);
        activeConversationId = msg.conversationId;
        return;
      case "heartbeat":
        // panel liveness ping — keep the service worker from idling out
        return;
    }
  });

  port.onDisconnect.addListener(() => {
    agent?.abort();
    agent = null;
    activeConversationId = null;
  });
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { kind?: string };

  if (m.kind === "settings_updated") {
    invalidateSettingsCache();
    sendResponse({ ok: true });
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
