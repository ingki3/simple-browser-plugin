import { create } from "zustand";
import type { DebugEvent, ToolName } from "@/lib/messages";

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
      resolved: "approved" | "cancelled" | null;
    }
  | {
      id: string;
      type: "tool_result";
      callId: string;
      toolName: ToolName;
      ok: boolean;
      summary: string;
    }
  | { id: string; type: "error"; message: string }
  | { id: string; type: "info"; title: string; message: string };

interface ChatState {
  conversationId: string;
  messages: ChatMessage[];
  streaming: boolean;
  statusText: string | null;
  debugEvents: DebugEvent[];
  appendUser: (text: string) => void;
  beginAssistant: () => void;
  appendAssistantChunk: (text: string) => void;
  appendThoughtChunk: (text: string) => void;
  finalizeAssistant: () => void;
  addToolPending: (m: Extract<ChatMessage, { type: "tool_pending" }>) => void;
  resolveToolPending: (callId: string, state: "approved" | "cancelled") => void;
  addToolResult: (m: Extract<ChatMessage, { type: "tool_result" }>) => void;
  addError: (message: string) => void;
  addInfo: (title: string, message: string) => void;
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
  debugEvents: [],

  appendUser: (text) =>
    set((s) => ({ messages: [...s.messages, { id: mid(), type: "user", text }], streaming: true })),

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
        m.type === "tool_pending" && m.callId === callId ? { ...m, resolved: state } : m,
      ),
    })),

  addToolResult: (m) =>
    set((s) => ({ messages: [...closeStreamingBubbles(s.messages), m] })),

  addError: (message) =>
    set((s) => {
      const msgs = closeStreamingBubbles(s.messages);
      msgs.push({ id: mid(), type: "error", message });
      return { ...s, messages: msgs, streaming: false, statusText: null };
    }),

  addInfo: (title, message) =>
    set((s) => ({
      ...s,
      messages: [...s.messages, { id: mid(), type: "info", title, message }],
    })),

  abortLocal: () =>
    set((s) => {
      const msgs = closeStreamingBubbles(s.messages);
      const hasPending = msgs.some((m) => m.type === "tool_pending" && m.resolved === null);
      const finalized = msgs.map((m) =>
        m.type === "tool_pending" && m.resolved === null
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
