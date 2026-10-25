// Anthropic(Claude) 직접 연결 어댑터(#97 4단계). Messages API(api.anthropic.com/v1/messages)에 사용자의 API 키로 보낸다.
// 내부 기준 형식(OpenAI 호환 기록·스트림 조각)과 서로 바꾼다:
// - 요청: system 메시지는 system 필드로, 도구 호출은 tool_use 블록, 도구 결과는 user 메시지의 tool_result 블록, PDF 파일
//   조각은 document 블록. 같은 역할이 이어지면 한 메시지로 합친다(user 쪽: tool_result가 먼저 오게 순서대로).
// - 생각: 에이전트 호출(agent·agent_low)이고 생각을 지원하는 모델이면 thinking(budget_tokens)을 켠다. 받은 생각 블록과
//   서명은 reasoning_details(type anthropic.thinking / anthropic.redacted_thinking)로 기록에 남겨 다음 요청에 돌려준다
//   (도구 호출이 이어질 때 필요).
// - JSON 응답: response_format이 없어 system에 "JSON 객체 하나만" 지침을 붙인다(받는 쪽이 글자에서 JSON을 찾는다).
// - 스트림: content_block_*·message_delta 이벤트를 내부 조각(content·reasoning·reasoning_details·tool_calls·finish_reason)으로.
import type { OpenRouterContentPart, OpenRouterMessage, OpenRouterStreamChunk } from "../openrouter.ts";
import { chatJson, chatRequest, readOpenRouterStream } from "../openrouter.ts";
import type { ChatRequest, ProviderAdapter } from "./types.ts";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const LABEL = "Anthropic";
const API_VERSION = "2023-06-01";

export const ANTHROPIC_MODEL_SUGGESTIONS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"] as const;
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";

// 생각(extended thinking)을 지원하는 모델인지(모델 ID 형태로만 — 요청 매개변수를 고르는 데 쓴다): Claude 3.7 이후.
export function anthropicThinkingModel(model: string): boolean {
  return /^claude-3-7/i.test(model) || /^claude-[a-z]+-([4-9]|\d{2,})/i.test(model);
}

const THINKING_BUDGET = { agent: 4096, agent_low: 1024 } as const;

type Block = Record<string, unknown>;

function textBlocks(content: string | OpenRouterContentPart[] | null): Block[] {
  if (content === null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: Block[] = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text) out.push({ type: "text", text: p.text });
    } else if (p.type === "file") {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(p.file.file_data);
      if (m && m[1] === "application/pdf") {
        out.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: m[2] } });
      } else {
        out.push({ type: "text", text: "[첨부 파일은 이 제공자로 보내지 않았습니다]" });
      }
    }
  }
  return out;
}

function thinkingBlocks(details: unknown[] | undefined): Block[] {
  const out: Block[] = [];
  for (const d of details ?? []) {
    if (!d || typeof d !== "object") continue;
    const item = d as { type?: unknown; thinking?: unknown; signature?: unknown; data?: unknown };
    if (item.type === "anthropic.thinking" && typeof item.thinking === "string" && typeof item.signature === "string") {
      out.push({ type: "thinking", thinking: item.thinking, signature: item.signature });
    } else if (item.type === "anthropic.redacted_thinking" && typeof item.data === "string") {
      out.push({ type: "redacted_thinking", data: item.data });
    }
  }
  return out;
}

function toolInput(args: string): unknown {
  try {
    const v = JSON.parse(args || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// 내부 기록 → Anthropic system·messages.
export function anthropicMessages(messages: OpenRouterMessage[]): { system: string; messages: Array<{ role: string; content: Block[] }> } {
  const system: string[] = [];
  const out: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      system.push(typeof m.content === "string" ? m.content : textBlocks(m.content).map((b) => String(b.text ?? "")).join("\n"));
    } else if (m.role === "user") {
      push("user", textBlocks(m.content));
    } else if (m.role === "assistant") {
      const blocks: Block[] = [
        ...thinkingBlocks(m.reasoning_details),
        ...textBlocks(m.content),
        ...(m.tool_calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.function.name, input: toolInput(c.function.arguments) })),
      ];
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    }
  }
  return { system: system.join("\n\n"), messages: out };
}

function jsonInstruction(format: Record<string, unknown>): string {
  const schema = (format as { json_schema?: { schema?: unknown } }).json_schema?.schema;
  return `응답은 JSON 객체 하나만 출력한다(설명·코드 블록 없이).${schema ? ` JSON 스키마: ${JSON.stringify(schema)}` : ""}`;
}

export function anthropicPayload(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = anthropicMessages(req.messages);
  const thinking = req.reasoning !== "off" && anthropicThinkingModel(req.model);
  const sys = [system, req.responseFormat ? jsonInstruction(req.responseFormat) : ""].filter(Boolean).join("\n\n");
  return {
    model: req.model,
    ...(sys ? { system: sys } : {}),
    messages,
    max_tokens: req.maxTokens,
    ...(req.tools
      ? {
          tools: req.tools.map((t) => {
            const fn = t.function as { name: string; description?: string; parameters?: unknown };
            return { name: fn.name, ...(fn.description ? { description: fn.description } : {}), input_schema: fn.parameters ?? { type: "object", properties: {} } };
          }),
          tool_choice:
            req.toolChoice === "none"
              ? { type: "none" }
              : { type: "auto", ...(req.parallelToolCalls === false ? { disable_parallel_tool_use: true } : {}) },
        }
      : {}),
    ...(thinking
      ? { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET[req.reasoning as "agent" | "agent_low"] } }
      : req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    ...(stream ? { stream: true } : {}),
  };
}

// Anthropic 스트림 이벤트 → 내부 조각(0개 이상). 블록별 상태(생각 글자·서명, 도구 호출 번호)를 지닌다.
export function anthropicStreamConverter(): (event: Record<string, unknown>) => OpenRouterStreamChunk[] {
  const blocks = new Map<number, { type: string; thinking: string; signature: string; data: string; tool: number; args: boolean }>();
  let nextTool = 0;
  const chunk = (delta: Record<string, unknown>, finish?: string): OpenRouterStreamChunk =>
    ({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] }) as OpenRouterStreamChunk;
  return (ev) => {
    const index = typeof ev.index === "number" ? ev.index : -1;
    if (ev.type === "content_block_start") {
      const cb = (ev.content_block ?? {}) as { type?: string; id?: string; name?: string; data?: string };
      const state = { type: cb.type ?? "", thinking: "", signature: "", data: cb.data ?? "", tool: -1, args: false };
      blocks.set(index, state);
      if (cb.type === "tool_use") {
        state.tool = nextTool++;
        return [chunk({ tool_calls: [{ index: state.tool, id: cb.id ?? "", type: "function", function: { name: cb.name ?? "", arguments: "" } }] })];
      }
      return [];
    }
    if (ev.type === "content_block_delta") {
      const d = (ev.delta ?? {}) as { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
      const state = blocks.get(index);
      if (d.type === "text_delta" && d.text) return [chunk({ content: d.text })];
      if (d.type === "thinking_delta" && d.thinking) {
        if (state) state.thinking += d.thinking;
        return [chunk({ reasoning: d.thinking })];
      }
      if (d.type === "signature_delta" && d.signature && state) state.signature += d.signature;
      if (d.type === "input_json_delta" && d.partial_json && state && state.tool >= 0) {
        state.args = true;
        return [chunk({ tool_calls: [{ index: state.tool, function: { arguments: d.partial_json } }] })];
      }
      return [];
    }
    if (ev.type === "content_block_stop") {
      const state = blocks.get(index);
      if (!state) return [];
      // 생각 블록은 끝날 때 서명과 함께 기록용으로 넘긴다(text·summary가 없어 화면에 두 번 보이지 않는다).
      if (state.type === "thinking") {
        return [chunk({ reasoning_details: [{ type: "anthropic.thinking", thinking: state.thinking, signature: state.signature }] })];
      }
      if (state.type === "redacted_thinking") {
        return [chunk({ reasoning_details: [{ type: "anthropic.redacted_thinking", data: state.data }] })];
      }
      // 인자 없는 도구 호출은 빈 객체로.
      if (state.type === "tool_use" && !state.args) return [chunk({ tool_calls: [{ index: state.tool, function: { arguments: "{}" } }] })];
      return [];
    }
    if (ev.type === "message_delta") {
      const reason = ((ev.delta ?? {}) as { stop_reason?: string }).stop_reason;
      if (!reason) return [];
      const finish = reason === "tool_use" ? "tool_calls" : reason === "max_tokens" ? "length" : "stop";
      return [chunk({}, finish)];
    }
    return [];
  };
}

function headers(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    // 확장(브라우저)에서 직접 부르는 요청임을 밝힌다(키는 사용자 자신의 것이고 이 브라우저에만 있다).
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  label: LABEL,
  supportsFileParts: true,
  async openStream(apiKey, req, signal) {
    const response = await chatRequest(ANTHROPIC_MESSAGES_URL, headers(apiKey), anthropicPayload(req, true), signal, LABEL);
    const convert = anthropicStreamConverter();
    return {
      read: (onChunk, inactivityMs) =>
        readOpenRouterStream(
          response,
          (raw) => {
            for (const c of convert(raw as unknown as Record<string, unknown>)) onChunk(c);
          },
          inactivityMs,
          LABEL,
        ),
    };
  },
  async complete(apiKey, req, signal) {
    const response = await chatRequest(ANTHROPIC_MESSAGES_URL, headers(apiKey), anthropicPayload(req, false), signal, LABEL);
    const res = await chatJson<{ content?: Array<{ type?: string; text?: string }> }>(response, LABEL);
    return (res.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  },
};
