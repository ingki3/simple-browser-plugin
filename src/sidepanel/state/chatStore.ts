import { create } from "zustand";
import type { DebugEvent, PageOfferData, ToolName } from "@/lib/messages";

const DEBUG_BUFFER_MAX = 500;

export type ChatMessage =
  | { id: string; type: "user"; text: string }
  | {
      id: string;
      type: "assistant_text";
      text: string;
      thoughtText: string;
      streaming: boolean;
    }
  | {
      id: string;
      type: "tool_pending";
      callId: string;
      toolName: ToolName;
      args: unknown;
      previewSummary: string;
      previewDetails?: unknown;
      linkGrantOffer?: boolean;
      chatGrantOffer?: boolean;
      personalUrlOffer?: boolean;
      // 자동 로그인 승인 제안(sign_in 카드): 고른 항목을 이 출처에 묶을지.
      loginSiteOffer?: string;
      choices?: Array<{ id: string; label: string; sub: string }>;
      choiceLimit?: number;
      choiceDefaults?: string[];
      handoff?: boolean;
      // 작업 맡기기 카드(#123).
      task?: { request: string; plan: string; risks: string[] };
      resolved: "approved" | "cancelled" | null;
    }
  | {
      id: string;
      type: "tool_result";
      callId: string;
      toolName: ToolName;
      ok: boolean;
      summary: string;
      cancelled?: boolean;
    }
  | {
      // 도구 호출 순환 한도에서 이어 가기 카드(#55). 승인 카드와 같은 callId 흐름으로 허락·거부를 돌려준다.
      id: string;
      type: "hop_limit";
      callId: string;
      used: number;
      extra: number;
      summary: { total: number; failed: number; cancelled: number; byTool: Array<{ tool: string; count: number }>; recent: string[] };
      resolved: "approved" | "cancelled" | null;
    }
  | {
      id: string;
      type: "page_offer";
      offer: PageOfferData;
    }
  // detail: 원래 오류 문구(자세히), action: 다음 행동 버튼(#130).
  | { id: string; type: "error"; message: string; detail?: string; action?: "settings" | "usage"; usageUrl?: string }
  | { id: string; type: "info"; title: string; message: string };

interface ChatState {
  conversationId: string;
  messages: ChatMessage[];
  streaming: boolean;
  statusText: string | null;
  // 이번 요청의 도구 순환 단계와 한도(예: 12/30). 응답 중에만 보인다(#55).
  hopProgress: { used: number; limit: number } | null;
  // 이 대화에서 "묻지 않기"로 허락한 도구와 범위(#53). 백그라운드가 보낸 목록을 그대로 보인다.
  chatGrants: Array<{ tool: ToolName; scope: string }>;
  // 이 대화에서 작업을 맡겼는지(#123). 백그라운드가 보낸 상태를 그대로 보인다.
  taskActive: boolean;
  // 반복 작업 목록이 바뀔 때마다 올린다(#138). 목록을 보이는 화면이 다시 읽는다.
  repeatVersion: number;
  bumpRepeat: () => void;
  debugEvents: DebugEvent[];
  appendUser: (text: string) => void;
  beginAssistant: () => void;
  appendAssistantChunk: (text: string) => void;
  appendThoughtChunk: (text: string) => void;
  finalizeAssistant: () => void;
  addToolPending: (m: Extract<ChatMessage, { type: "tool_pending" }>) => void;
  resolveToolPending: (callId: string, state: "approved" | "cancelled") => void;
  addHopLimit: (m: Extract<ChatMessage, { type: "hop_limit" }>) => void;
  setHopProgress: (p: { used: number; limit: number } | null) => void;
  setChatGrants: (grants: Array<{ tool: ToolName; scope: string }>) => void;
  setTaskActive: (active: boolean) => void;
  addToolResult: (m: Extract<ChatMessage, { type: "tool_result" }>) => void;
  addError: (message: string, extra?: { detail?: string; action?: "settings" | "usage"; usageUrl?: string }) => void;
  addInfo: (title: string, message: string) => void;
  addPageOffer: (offer: Extract<ChatMessage, { type: "page_offer" }>["offer"]) => void;
  setStatus: (text: string | null) => void;
  abortLocal: () => void;
  reset: () => void;
  pushDebugEvent: (ev: DebugEvent) => void;
  clearDebugEvents: () => void;
}

function closeStreamingBubbles(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((m) =>
    m.type === "assistant_text" && m.streaming ? { ...m, streaming: false } : m,
  );
}

let msgCounter = 0;
const mid = () => `m${++msgCounter}`;

export const useChatStore = create<ChatState>((set) => ({
  conversationId: crypto.randomUUID(),
  messages: [],
  streaming: false,
  statusText: null,
  hopProgress: null,
  chatGrants: [],
  taskActive: false,
  repeatVersion: 0,
  bumpRepeat: () => set((s) => ({ repeatVersion: s.repeatVersion + 1 })),
  debugEvents: [],

  appendUser: (text) =>
    set((s) => ({
      messages: [...s.messages, { id: mid(), type: "user", text }],
      streaming: true,
      hopProgress: null,
    })),

  beginAssistant: () =>
    set((s) => {
      const last = s.messages[s.messages.length - 1];
      if (last?.type === "assistant_text" && last.streaming) return s;
      return {
        ...s,
        messages: [
          ...s.messages,
          {
            id: mid(),
            type: "assistant_text",
            text: "",
            thoughtText: "",
            streaming: true,
          },
        ],
      };
    }),

  appendAssistantChunk: (text) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type === "assistant_text" && last.streaming) {
        msgs[msgs.length - 1] = { ...last, text: last.text + text };
        return { ...s, messages: msgs };
      }
      msgs.push({
        id: mid(),
        type: "assistant_text",
        text,
        thoughtText: "",
        streaming: true,
      });
      return { ...s, messages: msgs };
    }),

  appendThoughtChunk: (text) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.type === "assistant_text" && last.streaming) {
        msgs[msgs.length - 1] = { ...last, thoughtText: last.thoughtText + text };
        return { ...s, messages: msgs };
      }
      msgs.push({
        id: mid(),
        type: "assistant_text",
        text: "",
        thoughtText: text,
        streaming: true,
      });
      return { ...s, messages: msgs };
    }),

  finalizeAssistant: () =>
    set((s) => ({
      ...s,
      messages: closeStreamingBubbles(s.messages),
      streaming: false,
      statusText: null,
    })),

  setStatus: (text) => set((s) => ({ ...s, statusText: text })),

  addToolPending: (m) =>
    set((s) => ({ messages: [...closeStreamingBubbles(s.messages), m] })),

  resolveToolPending: (callId, state) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        (m.type === "tool_pending" || m.type === "hop_limit") && m.callId === callId ? { ...m, resolved: state } : m,
      ),
    })),

  addHopLimit: (m) =>
    set((s) => ({ messages: [...closeStreamingBubbles(s.messages), m] })),

  setHopProgress: (p) => set((s) => ({ ...s, hopProgress: p })),

  setChatGrants: (grants) => set((s) => ({ ...s, chatGrants: grants })),

  setTaskActive: (active) => set((s) => ({ ...s, taskActive: active })),

  addToolResult: (m) =>
    set((s) => ({ messages: [...closeStreamingBubbles(s.messages), m] })),

  addError: (message, extra) =>
    set((s) => {
      const msgs = closeStreamingBubbles(s.messages);
      msgs.push({ id: mid(), type: "error", message, ...(extra?.detail ? { detail: extra.detail } : {}), ...(extra?.action ? { action: extra.action } : {}), ...(extra?.usageUrl ? { usageUrl: extra.usageUrl } : {}) });
      return { ...s, messages: msgs, streaming: false, statusText: null };
    }),

  addPageOffer: (offer) =>
    set((s) => ({ messages: [...s.messages, { id: mid(), type: "page_offer", offer }] })),

  addInfo: (title, message) =>
    set((s) => ({
      ...s,
      messages: [...s.messages, { id: mid(), type: "info", title, message }],
    })),

  abortLocal: () =>
    set((s) => {
      const msgs = closeStreamingBubbles(s.messages);
      const isOpenCard = (m: ChatMessage) =>
        (m.type === "tool_pending" || m.type === "hop_limit") && m.resolved === null;
      const hasPending = msgs.some(isOpenCard);
      const finalized = msgs.map((m) =>
        (m.type === "tool_pending" || m.type === "hop_limit") && m.resolved === null
          ? { ...m, resolved: "cancelled" as const }
          : m,
      );
      if (hasPending) {
        finalized.push({
          id: mid(),
          type: "error",
          message: "사용자가 중단했습니다.",
        });
      }
      return { ...s, messages: finalized, streaming: false, statusText: null };
    }),

  reset: () =>
    set((s) => ({
      conversationId: crypto.randomUUID(),
      messages: [],
      streaming: false,
      statusText: null,
      hopProgress: null,
      chatGrants: [],
      taskActive: false,
      debugEvents: s.debugEvents,
    })),

  pushDebugEvent: (ev) =>
    set((s) => {
      const next = s.debugEvents.concat(ev);
      if (next.length > DEBUG_BUFFER_MAX) next.splice(0, next.length - DEBUG_BUFFER_MAX);
      return { ...s, debugEvents: next };
    }),

  clearDebugEvents: () => set((s) => ({ ...s, debugEvents: [] })),
}));
