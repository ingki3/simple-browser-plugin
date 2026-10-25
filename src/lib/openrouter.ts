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

function errorMessage(body: unknown, status: number, label: string): string {
  if (body && typeof body === "object") {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string") return error.message;
  }
  return `${label} 요청 실패 (HTTP ${status})`;
}

// OpenAI 호환 Chat Completions 엔드포인트에 JSON 요청을 보낸다(제공자 어댑터 공용, #97). label은 오류 문구의 제공자 이름.
export async function chatRequest(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(errorMessage(body, response.status, label));
  }
  return response;
}

export async function chatJson<T>(response: Response, label: string): Promise<T> {
  const body = (await response.json()) as T & {
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? `${label} 응답 오류`);
  return body;
}

export async function openRouterRequest(
  apiKey: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return chatRequest(
    OPENROUTER_CHAT_URL,
    { Authorization: `Bearer ${apiKey}`, "X-Title": "Simple Browser Plugin" },
    payload,
    signal,
    "OpenRouter",
  );
}

export async function openRouterJson<T>(
  apiKey: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return chatJson<T>(await openRouterRequest(apiKey, payload, signal), "OpenRouter");
}

// SSE(data: …) 스트림을 조각마다 넘긴다. OpenAI 호환 스트림이면 제공자와 관계없이 쓴다(label은 오류 문구용).
export async function readOpenRouterStream(
  response: Response,
  onChunk: (chunk: OpenRouterStreamChunk) => void,
  inactivityMs: number,
  label = "OpenRouter",
): Promise<void> {
  if (!response.body) throw new Error(`${label} 스트림 본문이 없습니다.`);
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
      throw new Error(`${label} 스트림 JSON 파싱에 실패했습니다.`);
    }
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `${label} 스트리밍 오류`);
    }
    onChunk(parsed);
    return false;
  };

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} 응답이 ${Math.round(inactivityMs / 1000)}초 동안 없습니다.`)),
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
