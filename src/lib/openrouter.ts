export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type OpenRouterContentPart =
  | { type: "text"; text: string }
  | {
      type: "file";
      file: { filename: string; file_data: string };
    };

export type OpenRouterMessage =
  | { role: "system" | "user"; content: string | OpenRouterContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
      reasoning?: string;
      reasoning_details?: unknown[];
      annotations?: unknown[];
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface OpenRouterStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown[];
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { code?: number | string; message?: string; metadata?: unknown };
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return `OpenRouter 요청 실패 (HTTP ${status})`;
}

export async function openRouterRequest(
  apiKey: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Simple Browser Plugin",
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(errorMessage(body, response.status));
  }
  return response;
}

export async function openRouterJson<T>(
  apiKey: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await openRouterRequest(apiKey, payload, signal);
  const body = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "OpenRouter 응답 오류");
  return body;
}

export async function readOpenRouterStream(
  response: Response,
  onChunk: (chunk: OpenRouterStreamChunk) => void,
  inactivityMs: number,
): Promise<void> {
  if (!response.body) throw new Error("OpenRouter 스트림 본문이 없습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processEvent = (event: string): boolean => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return false;
    if (data === "[DONE]") return true;
    let parsed: OpenRouterStreamChunk;
    try {
      parsed = JSON.parse(data) as OpenRouterStreamChunk;
    } catch {
      throw new Error("OpenRouter 스트림 JSON 파싱에 실패했습니다.");
    }
    if (parsed.error) {
      throw new Error(parsed.error.message ?? "OpenRouter 스트리밍 오류");
    }
    onChunk(parsed);
    return false;
  };

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`OpenRouter 응답이 ${Math.round(inactivityMs / 1000)}초 동안 없습니다.`)),
        inactivityMs,
      );
    });
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      if (processEvent(event)) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) processEvent(buffer);
}
