import { useCallback, useEffect, useRef } from "react";
import { PORT_NAME, type BgToPanel, type PanelToBg, type ToolName } from "@/lib/messages";
import { useChatStore } from "../state/chatStore";

const HEARTBEAT_MS = 20_000;
const RECONNECT_DELAY_MS = 500;

export function useChatSession() {
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => {
    let alive = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const pushPanelDebug = (tag: string, detail?: string, level: "info" | "warn" = "info") => {
      useChatStore.getState().pushDebugEvent({
        ts: Date.now(),
        source: "panel",
        tag,
        level,
        detail,
      });
    };

    const onMessage = (raw: unknown) => {
      const msg = raw as BgToPanel;
      if (!msg || typeof msg !== "object") return;
      const s = useChatStore.getState();

      switch (msg.kind) {
        case "assistant_chunk":
          s.beginAssistant();
          s.appendAssistantChunk(msg.text);
          return;
        case "thought_chunk":
          s.beginAssistant();
          s.appendThoughtChunk(msg.text);
          return;
        case "assistant_done":
          s.finalizeAssistant();
          return;
        case "status":
          s.setStatus(msg.text);
          return;
        case "chat_grants":
          s.setChatGrants(msg.grants);
          return;
        case "hop_progress":
          s.setHopProgress({ used: msg.used, limit: msg.limit });
          return;
        case "hop_limit":
          s.addHopLimit({
            id: `h${msg.callId}`,
            type: "hop_limit",
            callId: msg.callId,
            used: msg.used,
            extra: msg.extra,
            summary: msg.summary,
            resolved: null,
          });
          return;
        case "tool_pending":
          s.addToolPending({
            id: `t${msg.callId}`,
            type: "tool_pending",
            callId: msg.callId,
            toolName: msg.toolName,
            args: msg.args,
            previewSummary: msg.previewSummary,
            previewDetails: msg.previewDetails,
            linkGrantOffer: msg.linkGrantOffer === true,
            chatGrantOffer: msg.chatGrantOffer === true,
            personalUrlOffer: msg.personalUrlOffer === true,
            ...(typeof msg.loginSiteOffer === "string" ? { loginSiteOffer: msg.loginSiteOffer } : {}),
            handoff: msg.handoff === true,
            ...(msg.choices ? { choices: msg.choices, choiceLimit: msg.choiceLimit, choiceDefaults: msg.choiceDefaults } : {}),
            resolved: null,
          });
          return;
        case "tool_result":
          // 손 넘기기 카드는 사용자가 페이지에서 대상을 누르면 백그라운드가 먼저 끝낸다. 결과가 오면 열린 카드를 닫는다.
          if (s.messages.some((m) => m.type === "tool_pending" && m.callId === msg.callId && m.resolved === null)) {
            s.resolveToolPending(msg.callId, msg.ok ? "approved" : "cancelled");
          }
          s.addToolResult({
            id: `r${msg.callId}`,
            type: "tool_result",
            callId: msg.callId,
            toolName: msg.toolName,
            ok: msg.ok,
            summary: msg.summary,
          });
          return;
        case "error":
          s.addError(msg.message);
          return;
        case "info":
          s.addInfo(msg.title, msg.message);
          return;
        case "page_save_offer":
          s.addPageOffer(msg.offer);
          return;
        case "settings_warning":
          s.addError(msg.message);
          return;
        case "debug":
          s.pushDebugEvent(msg.event);
          return;
      }
    };

    const clearHeartbeat = () => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const startHeartbeat = (port: chrome.runtime.Port) => {
      clearHeartbeat();
      heartbeat = setInterval(() => {
        try {
          port.postMessage({ kind: "heartbeat" } satisfies PanelToBg);
        } catch {
          /* port gone; disconnect handler will reconnect */
        }
      }, HEARTBEAT_MS);
    };

    const connect = () => {
      if (!alive) return;
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: PORT_NAME });
      } catch (err) {
        pushPanelDebug(
          "port:connect_failed",
          err instanceof Error ? err.message : String(err),
          "warn",
        );
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }

      portRef.current = port;
      pushPanelDebug("port:connect");

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        clearHeartbeat();
        // 연결이 끊기면 백그라운드가 대화 객체를 버리므로 그 대화의 허락도 사라진다(#53).
        useChatStore.getState().setChatGrants([]);
        const lastErr = chrome.runtime.lastError?.message;
        pushPanelDebug("port:disconnect", lastErr, "warn");
        if (!alive) return;
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });

      startHeartbeat(port);
    };

    connect();

    return () => {
      alive = false;
      clearHeartbeat();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      try {
        portRef.current?.disconnect();
      } catch {
        /* ignore */
      }
      portRef.current = null;
    };
  }, []);

  const localDebug = useCallback((tag: string, detail?: string) => {
    useChatStore.getState().pushDebugEvent({
      ts: Date.now(),
      source: "panel",
      tag,
      level: "info",
      detail,
    });
  }, []);

  const send = useCallback(
    (m: PanelToBg) => {
      let port = portRef.current;
      if (!port) {
        // Port is being reconnected; wake BG by opening a new temp connection
        // so the message goes through on the next tick.
        try {
          port = chrome.runtime.connect({ name: PORT_NAME });
          portRef.current = port;
          localDebug("port:ondemand_reconnect");
        } catch (err) {
          localDebug(
            "port:send_failed",
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
      }
      try {
        port.postMessage(m);
      } catch (err) {
        localDebug(
          "port:post_failed",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [localDebug],
  );

  const sendUser = (text: string) => {
    const { conversationId, appendUser } = useChatStore.getState();
    appendUser(text);
    localDebug("user_msg", `${text.length}자`);
    send({ kind: "user_msg", text, conversationId });
  };

  const approveTool = (
    callId: string,
    allowLinksThisTurn = false,
    choiceIds?: string[],
    allowToolThisChat = false,
    allowUrlsThisChat = false,
    rememberLoginSite = false,
  ) => {
    useChatStore.getState().resolveToolPending(callId, "approved");
    localDebug("approve_tool", `${callId}${allowLinksThisTurn ? " +links" : ""}${allowToolThisChat ? " +chat" : ""}${allowUrlsThisChat ? " +urls" : ""}`);
    send({
      kind: "approve_tool",
      callId,
      ...(allowLinksThisTurn ? { allowLinksThisTurn: true } : {}),
      ...(choiceIds ? { choiceIds } : {}),
      ...(allowToolThisChat ? { allowToolThisChat: true } : {}),
      ...(allowUrlsThisChat ? { allowUrlsThisChat: true } : {}),
      ...(rememberLoginSite ? { rememberLoginSite: true } : {}),
    });
  };

  // 이 대화의 허락을 취소한다. 표시는 바로 지우고, 백그라운드가 바뀐 목록을 다시 보낸다.
  const revokeChatGrant = (tool: ToolName) => {
    const s = useChatStore.getState();
    s.setChatGrants(s.chatGrants.filter((g) => g.tool !== tool));
    localDebug("revoke_chat_grant", tool);
    send({ kind: "revoke_chat_grant", tool });
  };

  const cancelTool = (callId: string) => {
    useChatStore.getState().resolveToolPending(callId, "cancelled");
    localDebug("cancel_tool", callId);
    send({ kind: "cancel_tool", callId });
  };

  const abortStream = () => {
    localDebug("abort_stream");
    send({ kind: "abort_stream" });
    useChatStore.getState().abortLocal();
  };

  const resetConversation = () => {
    useChatStore.getState().reset();
    const { conversationId } = useChatStore.getState();
    send({ kind: "reset_conversation", conversationId });
  };

  return { sendUser, approveTool, cancelTool, abortStream, resetConversation, revokeChatGrant };
}
