// Anthropic(Claude) 직접 연결 어댑터(#97 4단계). Messages API(api.anthropic.com/v1/messages)에 사용자의 API 키로 보낸다.
// 내부 기준 형식(OpenAI 호환 기록·스트림 조각)과 서로 바꾼다:
// - 요청: system 메시지는 system 필드로, 도구 호출은 tool_use 블록, 도구 결과는 user 메시지의 tool_result 블록, PDF 파일
//   조각은 document 블록. 같은 역할이 이어지면 한 메시지로 합친다(user 쪽: tool_result가 먼저 오게 순서대로).
// - 생각: 에이전트 호출(agent·agent_low)이고 생각을 지원하는 모델이면 켠다. 받은 응답의 블록 배열(생각·서명·글자·도구 호출)을
//   순서 그대로 reasoning_details(type anthropic.content)로 기록에 남겨 다음 요청에 그대로 돌려준다(서명이 블록 순서와 앞
//   문맥까지 검사한다 — 다시 짜 맞추지 않는다).
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

// 모델 ID의 세대(주·부 번호). claude-sonnet-5-5 → 5.5, claude-3-7-sonnet-latest → 3.7, claude-sonnet-4-20250514 → 4.0
// (날짜는 부 번호가 아니다). 읽지 못하면 null.
export function anthropicVersion(model: string): { major: number; minor: number } | null {
  const m = /^claude-(?:[a-z]+-)?(\d+)(?:[-.](\d+))?/i.exec(model);
  if (!m) return null;
  const minor = m[2] && m[2].length <= 2 ? Number(m[2]) : 0;
  return { major: Number(m[1]), minor };
}

// 생각 방식(모델 ID 형태로만 — 요청 매개변수를 고르는 데 쓴다):
// - adaptive: Claude 4.6 이후·5 계열은 모델이 생각 양을 정하고 강도(effort)만 받는다(budget_tokens를 받지 않음).
// - budget: Claude 3.7·4~4.5는 budget_tokens.
// - none: 그 앞 모델은 생각을 켜지 않는다.
export function anthropicThinkingMode(model: string): "adaptive" | "budget" | "none" {
  const v = anthropicVersion(model);
  if (!v) return "none";
  if (v.major >= 5 || (v.major === 4 && v.minor >= 6)) return "adaptive";
  if (v.major === 4 || (v.major === 3 && v.minor >= 7)) return "budget";
  return "none";
}

export function anthropicThinkingModel(model: string): boolean {
  return anthropicThinkingMode(model) !== "none";
}

const THINKING_BUDGET = { agent: 4096, agent_low: 1024 } as const;
const THINKING_EFFORT = { agent: "medium", agent_low: "low" } as const;

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

// 받은 응답 블록 배열(anthropic.content). 없으면 null.
function originalBlocks(details: unknown[] | undefined): Block[] | null {
  for (const d of details ?? []) {
    if (d && typeof d === "object" && (d as { type?: unknown }).type === "anthropic.content") {
      const content = (d as { content?: unknown }).content;
      if (Array.isArray(content) && content.length) return content as Block[];
    }
  }
  return null;
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
      // 이 제공자에서 받은 응답이면 받은 블록 배열을 그대로 돌려준다.
      const original = originalBlocks(m.reasoning_details);
      if (original) {
        push("assistant", original);
        continue;
      }
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
  const modelMode = anthropicThinkingMode(req.model);
  const mode = req.reasoning === "off" ? "none" : modelMode;
  const intent = req.reasoning as "agent" | "agent_low";
  // 생각이 필요 없는 짧은 JSON 호출: adaptive 모델은 thinking을 빼도 스스로 생각할 수 있어 강도를 가장 낮게 둔다
  // (출력 한도를 생각에 쓰지 않게).
  const offEffort = req.reasoning === "off" && modelMode === "adaptive";
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
    // temperature 등 샘플링 값은 보내지 않는다(최신 모델은 기본값과 다른 값을 거부한다).
    ...(mode === "adaptive"
      ? { thinking: { type: "adaptive" }, output_config: { effort: THINKING_EFFORT[intent] } }
      : mode === "budget"
        ? { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET[intent] } }
        : offEffort
          ? { output_config: { effort: "low" } }
          : {}),
    ...(stream ? { stream: true } : {}),
  };
}

// Anthropic 스트림 이벤트 → 내부 조각(0개 이상). 블록별 상태(글자·생각·서명·도구 인자)를 모아, 응답이 끝날 때(message_delta)
// 받은 블록 배열을 순서 그대로 reasoning_details(anthropic.content)로 넘긴다(text·summary가 없어 화면에 두 번 보이지 않는다).
export function anthropicStreamConverter(): (event: Record<string, unknown>) => OpenRouterStreamChunk[] {
  const blocks = new Map<
    number,
    { type: string; text: string; thinking: string; signature: string; data: string; id: string; name: string; json: string; tool: number; args: boolean }
  >();
  let nextTool = 0;
  const chunk = (delta: Record<string, unknown>, finish?: string): OpenRouterStreamChunk =>
    ({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] }) as OpenRouterStreamChunk;
  const ordered = (): Block[] => {
    const out: Block[] = [];
    for (const [, b] of [...blocks].sort((x, y) => x[0] - y[0])) {
      if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
      else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
      else if (b.type === "text") {
        if (b.text) out.push({ type: "text", text: b.text });
      } else if (b.type === "tool_use") out.push({ type: "tool_use", id: b.id, name: b.name, input: toolInput(b.json) });
    }
    return out;
  };
  return (ev) => {
    const index = typeof ev.index === "number" ? ev.index : -1;
    if (ev.type === "content_block_start") {
      const cb = (ev.content_block ?? {}) as { type?: string; id?: string; name?: string; data?: string };
      const state = { type: cb.type ?? "", text: "", thinking: "", signature: "", data: cb.data ?? "", id: cb.id ?? "", name: cb.name ?? "", json: "", tool: -1, args: false };
      blocks.set(index, state);
      if (cb.type === "tool_use") {
        state.tool = nextTool++;
        return [chunk({ tool_calls: [{ index: state.tool, id: state.id, type: "function", function: { name: state.name, arguments: "" } }] })];
      }
      return [];
    }
    if (ev.type === "content_block_delta") {
      const d = (ev.delta ?? {}) as { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string };
      const state = blocks.get(index);
      if (d.type === "text_delta" && d.text) {
        if (state) state.text += d.text;
        return [chunk({ content: d.text })];
      }
      if (d.type === "thinking_delta" && d.thinking) {
        if (state) state.thinking += d.thinking;
        return [chunk({ reasoning: d.thinking })];
      }
      if (d.type === "signature_delta" && d.signature && state) state.signature += d.signature;
      if (d.type === "input_json_delta" && d.partial_json && state && state.tool >= 0) {
        state.args = true;
        state.json += d.partial_json;
        return [chunk({ tool_calls: [{ index: state.tool, function: { arguments: d.partial_json } }] })];
      }
      return [];
    }
    if (ev.type === "content_block_stop") {
      const state = blocks.get(index);
      // 인자 없는 도구 호출은 빈 객체로.
      if (state && state.type === "tool_use" && !state.args) return [chunk({ tool_calls: [{ index: state.tool, function: { arguments: "{}" } }] })];
      return [];
    }
    if (ev.type === "message_delta") {
      const reason = ((ev.delta ?? {}) as { stop_reason?: string }).stop_reason;
      const out: OpenRouterStreamChunk[] = [];
      const content = ordered();
      if (content.length) out.push(chunk({ reasoning_details: [{ type: "anthropic.content", content }] }));
      if (reason) {
        // 출력 한도·문맥 한도로 끊긴 응답은 잘림(length)으로 알린다(정상 완료로 보지 않게).
        const finish =
          reason === "tool_use"
            ? "tool_calls"
            : reason === "max_tokens" || reason === "model_context_window_exceeded"
              ? "length"
              : "stop";
        out.push(chunk({}, finish));
      }
      return out;
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
  signsContext: true,
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
