import { PORT_NAME, type PanelToBg } from "@/lib/messages";
import { ChatAgent } from "./gemini";
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
    connectGoogle()
      .then(() => sendResponse({ ok: true }))
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return true;
  }

  if (m.kind === "google_disconnect") {
    clearGoogleToken()
      .then(() => sendResponse({ ok: true }))
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
