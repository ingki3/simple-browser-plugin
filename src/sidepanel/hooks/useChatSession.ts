import { useCallback, useEffect, useRef } from "react";
import { PROVIDER_LINKS } from "@/lib/providerLinks";
import { PORT_NAME, type BgToPanel, type PanelToBg, type ToolName } from "@/lib/messages";
import { useChatStore } from "../state/chatStore";

const HEARTBEAT_MS = 20_000;
const RECONNECT_DELAY_MS = 500;

export function useChatSession() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // 마지막으로 누른 페이지 제안 실행(#173). 늦게 온 시작·실패 알림이 다른 실행에 붙지 않게.
  const lastRunId = useRef("");

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
        case "task_state":
          s.setTaskActive(msg.active);
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
            ...(msg.task ? { task: msg.task } : {}),
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
            ...(msg.cancelled ? { cancelled: true } : {}),
          });
          return;
        case "error":
          s.addError(msg.message, {
            detail: msg.detail,
            action: msg.action,
            // 오류가 난 제공자의 사용량 주소를 그때 정해 둔다(뒤에 제공자를 바꿔도 그대로).
            usageUrl: msg.provider ? PROVIDER_LINKS[msg.provider].usageUrl : undefined,
          });
          return;
        case "info":
          s.addInfo(msg.title, msg.message);
          return;
        case "page_save_offer":
          s.addPageOffer(msg.offer, { open: msg.open === true, autoDraft: msg.autoDraft !== false });
          return;
        case "settings_warning":
          s.addError(msg.message);
          return;
        case "debug":
          s.pushDebugEvent(msg.event);
          return;
        case "repeat_update":
          s.bumpRepeat();
          return;
        case "suggestion_started":
          // 페이지 제안 실행(#173): 백그라운드가 확인한 뒤 보낸 요청 글. 마지막으로 누른 실행일 때만 보인다.
          if (msg.runId === lastRunId.current) s.appendUser(msg.text);
          return;
        case "suggestion_failed":
          if (msg.runId === lastRunId.current) s.addInfo("제안을 실행하지 않았습니다", msg.message);
          return;
        case "repeat_started":
          // 이어서 진행(#138): 백그라운드가 저장된 작업으로 만든 첫 요청 글.
          s.appendUser(msg.text);
          s.bumpRepeat();
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
      // 연결(다시 연결)할 때 반복 작업 목록을 다시 읽게 한다.
      useChatStore.getState().bumpRepeat();
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        clearHeartbeat();
        // 연결이 끊기면 백그라운드가 대화 객체를 버리므로 그 대화의 허락도 사라진다(#53).
        useChatStore.getState().setChatGrants([]);
        // 맡긴 작업(#123)도 대화 객체와 함께 사라진다.
        useChatStore.getState().setTaskActive(false);
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

  // 페이지 제안 칩의 실행(#173): 요청 글은 백그라운드가 규칙에서 정한다(확인한 뒤 suggestion_started로 알려 준다).
  const runSuggestion = (rule: { id: string; version: number }, tab: { windowId: number; tabId: number; url: string }) => {
    const { conversationId } = useChatStore.getState();
    const runId = crypto.randomUUID();
    lastRunId.current = runId;
    localDebug("suggestion_run", rule.id);
    send({ kind: "suggestion_run", conversationId, runId, windowId: tab.windowId, ruleId: rule.id, ruleVersion: rule.version, tabId: tab.tabId, url: tab.url });
  };

  const sendUser = (text: string) => {
    // 직접 보낸 요청이 앞선 제안 실행을 대신한다(늦게 온 시작 알림을 붙이지 않는다).
    lastRunId.current = "";
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

  // 맡긴 작업을 거둔다(#123). 표시는 바로 지우고, 백그라운드가 상태를 다시 보낸다.
  const revokeTask = () => {
    useChatStore.getState().setTaskActive(false);
    localDebug("revoke_task");
    send({ kind: "revoke_task" });
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

  // 반복 작업의 "이어서 진행"(#138): 새 대화를 열고 백그라운드에 그 대화로 시작하게 한다. 요청 글은 백그라운드가 정한다.
  const continueRepeat = (taskId: string) => {
    lastRunId.current = "";
    useChatStore.getState().reset();
    const { conversationId } = useChatStore.getState();
    localDebug("repeat_continue", taskId);
    send({ kind: "repeat_continue", taskId, conversationId });
  };

  const resetConversation = () => {
    // 새 대화에는 이전 대화의 제안 실행 알림을 붙이지 않는다.
    lastRunId.current = "";
    useChatStore.getState().reset();
    const { conversationId } = useChatStore.getState();
    send({ kind: "reset_conversation", conversationId });
  };

  return { sendUser, approveTool, cancelTool, abortStream, resetConversation, revokeChatGrant, revokeTask, continueRepeat, runSuggestion };
}
