import { useCallback, useEffect, useRef } from "react";
import { PROVIDER_LINKS } from "@/lib/providerLinks";
import { PORT_NAME, type BgToPanel, type PanelToBg, type ToolName } from "@/lib/messages";
import { useChatStore } from "../state/chatStore";
import { acceptResume, disconnectDetail, heartbeatLate, LostNotice } from "@/lib/panelLink";

const HEARTBEAT_MS = 20_000;

// 패널 쪽 디버그 줄을 콘솔에도 남긴다(백그라운드 debugLog와 같은 꼴 — 하네스가 패널 페이지 콘솔로 읽는다). 대화 글자는 넣지 않는다.
function panelConsole(tag: string, detail?: string): void {
  console.debug(`[SBP panel ${tag}]`, detail ?? "");
}
const RECONNECT_DELAY_MS = 500;

const LOST_TITLE = "앞 대화를 이어 가지 못했습니다";
const LOST_BODY =
  "연결이 다시 시작되면서 도우미가 앞 대화 내용을 기억하지 못합니다. 다음 요청은 새 대화로 시작하니, 앞 내용이 필요하면 다시 적어 주세요.";

export function useChatSession() {
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // 연결을 여는 유일한 경로(#243): 포트가 있으면 그대로, 없으면 예약 재연결을 지우고 리스너·heartbeat·resume을 설치한 포트를 연다.
  const ensureRef = useRef<(reason: "즉석") => chrome.runtime.Port | null>(() => null);
  // 대화 유실 안내 중복 방지(새 요청을 보내면 다시 띄울 수 있다).
  const lostNotice = useRef(new LostNotice());
  // 마지막으로 누른 페이지 제안 실행(#173). 늦게 온 시작·실패 알림이 다른 실행에 붙지 않게.
  const lastRunId = useRef("");

  useEffect(() => {
    let alive = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // 연결 세대(#243): 연결마다 올리고, 옛 포트의 늦은 메시지·끊김은 무시한다.
    let gen = 0;
    let connectedOnce = false;
    let connectedAt = 0;
    let lastBeatAt: number | null = null;
    let lastWorker: string | null = null;
    // 바로 앞 끊김에서 진행 중이던 요청을 멈췄는지(다음 안내 문구에 붙인다).
    let droppedBusy = false;
    // 이 연결에서 보낸 resume 요청(답을 받으면 비운다).
    let resumeAsked: { gen: number; conversationId: string } | null = null;
    let visibility = document.visibilityState;
    let visibilitySince = Date.now();
    const onVisibility = () => {
      visibility = document.visibilityState;
      visibilitySince = Date.now();
      pushPanelDebug("panel:visibility", visibility);
    };
    document.addEventListener("visibilitychange", onVisibility);

    const pushPanelDebug = (tag: string, detail?: string, level: "info" | "warn" = "info") => {
      panelConsole(tag, detail);
      useChatStore.getState().pushDebugEvent({
        ts: Date.now(),
        source: "panel",
        tag,
        level,
        detail,
      });
    };

    const showLost = (busy: boolean) => {
      const s = useChatStore.getState();
      if (!lostNotice.current.shouldShow(s.conversationId)) return;
      s.addInfo(LOST_TITLE, `${busy ? "진행 중이던 요청을 멈췄습니다. " : ""}${LOST_BODY}`);
    };

    const onMessage = (raw: unknown) => {
      const msg = raw as BgToPanel;
      if (!msg || typeof msg !== "object") return;
      const s = useChatStore.getState();

      switch (msg.kind) {
        case "port_hello":
          // 워커가 다시 떴는지(진단만 — 안내는 resume 답으로 정한다).
          if (lastWorker === null || lastWorker === msg.workerRun) pushPanelDebug("worker:same", msg.workerRun);
          else pushPanelDebug("worker:restarted", `${lastWorker} → ${msg.workerRun} · 새 워커 가동 ${Math.round(msg.uptimeMs / 1000)}초`, "warn");
          lastWorker = msg.workerRun;
          return;
        case "conversation_resume": {
          if (!resumeAsked || !acceptResume(msg, { gen, conversationId: s.conversationId })) return;
          resumeAsked = null;
          const busy = droppedBusy;
          droppedBusy = false;
          if (msg.resumed) pushPanelDebug("conversation:resumed", `세대 ${msg.gen}`);
          else {
            pushPanelDebug("conversation:lost", msg.reason ?? "", "warn");
            showLost(busy);
          }
          return;
        }
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
        case "assistant_retract":
          s.retractStreaming();
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
            ...(typeof msg.previewFullDetails === "string" ? { previewFullDetails: msg.previewFullDetails } : {}),
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
      lastBeatAt = null;
      heartbeat = setInterval(() => {
        const now = Date.now();
        // 숨은 문서의 타이머 제한으로 늦었으면 남긴다(#243 진단, 늦을 때만).
        if (heartbeatLate(lastBeatAt ?? connectedAt, now, HEARTBEAT_MS)) {
          pushPanelDebug("heartbeat:late", `간격 ${Math.round((now - (lastBeatAt ?? connectedAt)) / 1000)}초 · visibility ${visibility}`, "warn");
        }
        lastBeatAt = now;
        try {
          port.postMessage({ kind: "heartbeat" } satisfies PanelToBg);
        } catch {
          /* port gone; disconnect handler will reconnect */
        }
      }, HEARTBEAT_MS);
    };

    const scheduleReconnect = () => {
      if (!alive || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect("예약");
      }, RECONNECT_DELAY_MS);
    };

    // 연결을 여는 유일한 경로(#243). 포트가 있으면 그대로 돌려주고, 없으면 예약 재연결을 지운 뒤 연다. 리스너·heartbeat를 설치하고,
    // 같은 패널 문서의 재연결이면 그 포트의 첫 메시지로 resume을 보낸다(같은 포트의 메시지는 순서대로 처리되어 user_msg보다 먼저 닿는다).
    const connect = (reason: "처음" | "예약" | "즉석"): chrome.runtime.Port | null => {
      if (!alive) return null;
      if (portRef.current) return portRef.current;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: PORT_NAME });
      } catch (err) {
        pushPanelDebug(
          "port:connect_failed",
          err instanceof Error ? err.message : String(err),
          "warn",
        );
        scheduleReconnect();
        return null;
      }
      const myGen = ++gen;
      portRef.current = port;
      connectedAt = Date.now();
      pushPanelDebug("port:connect", `${reason} · 세대 ${myGen}`);

      port.onMessage.addListener((raw: unknown) => {
        if (myGen === gen) onMessage(raw);
      });
      // 연결(다시 연결)할 때 반복 작업 목록을 다시 읽게 한다.
      useChatStore.getState().bumpRepeat();
      port.onDisconnect.addListener(() => {
        if (myGen !== gen || portRef.current !== port) return;
        portRef.current = null;
        clearHeartbeat();
        const s = useChatStore.getState();
        // 연결이 끊기면 백그라운드가 대화 허락(#53)·맡긴 작업(#123)을 지운다(대화 기록은 같은 워커에서 다시 붙으면 이을 수 있다, #243).
        s.setChatGrants([]);
        s.setTaskActive(false);
        // 진행 중이던 턴은 백그라운드가 멈추고 버린다 — 응답 중 표시와 미결 카드를 닫아 다음 요청을 보낼 수 있게 한다.
        const busy = s.streaming || s.messages.some((m) => (m.type === "tool_pending" || m.type === "hop_limit") && m.resolved === null);
        if (busy) {
          s.dropLocal();
          droppedBusy = true;
        }
        resumeAsked = null;
        const lastErr = chrome.runtime.lastError?.message;
        pushPanelDebug(
          "port:disconnect",
          disconnectDetail({
            lastError: lastErr,
            connectedMs: Date.now() - connectedAt,
            beatAgoMs: lastBeatAt === null ? null : Date.now() - lastBeatAt,
            visibility,
            visibilityForMs: Date.now() - visibilitySince,
            busy,
          }),
          "warn",
        );
        scheduleReconnect();
      });

      startHeartbeat(port);
      const s = useChatStore.getState();
      if (connectedOnce && s.messages.some((m) => m.type === "user")) {
        resumeAsked = { gen: myGen, conversationId: s.conversationId };
        try {
          port.postMessage({ kind: "resume_conversation", conversationId: s.conversationId, gen: myGen } satisfies PanelToBg);
        } catch {
          /* port gone */
        }
      } else droppedBusy = false;
      connectedOnce = true;
      return port;
    };
    ensureRef.current = (reason) => connect(reason);

    connect("처음");

    return () => {
      alive = false;
      gen += 1;
      ensureRef.current = () => null;
      document.removeEventListener("visibilitychange", onVisibility);
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
    panelConsole(tag, detail);
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
      // 끊긴 직후(예약 재연결 전)면 같은 경로로 바로 연다(리스너·heartbeat·resume 포함, 예약 재연결은 취소, #243).
      const port = portRef.current ?? ensureRef.current("즉석");
      if (!port) {
        localDebug("port:send_failed", "연결을 열지 못함");
        return;
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
    // 새 요청을 보냈으니 다음에 대화를 잃으면 다시 안내한다(#243).
    lostNotice.current.onUserMessage();
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
