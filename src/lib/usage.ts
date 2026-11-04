// 모델 호출의 토큰 사용량(#126). 제공자 스트림의 usage(내부 기준은 OpenAI 형식 — Anthropic은 어댑터가 바꿈)를 읽어 디버그 타임라인에
// 한 줄로 보인다. 제공자가 주지 않으면 "사용량 없음"이고, 글자 수로 추정해 섞지 않는다. npm test로 시험하므로 다른 모듈을 불러오지 않는다.

export interface ModelUsage {
  input: number;
  output: number;
  // 입력 중 캐시에서 읽은 토큰·캐시에 쓴 토큰, 출력 중 생각 토큰(제공자가 줄 때만).
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
}

// 여러 호출의 합계(턴·대화).
export interface UsageTotal {
  calls: number;
  // 사용량을 주지 않은 호출 수.
  missing: number;
  input: number;
  output: number;
  cachedInput: number;
  cacheWrite: number;
  reasoning: number;
}

export function emptyUsageTotal(): UsageTotal {
  return { calls: 0, missing: 0, input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0 };
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

// 스트림 조각의 usage(OpenAI 형식)를 읽는다. 입력·출력 토큰이 둘 다 없으면 null.
export function usageFromChunk(raw: unknown): ModelUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown } | null;
    completion_tokens_details?: { reasoning_tokens?: unknown } | null;
  };
  const input = count(u.prompt_tokens);
  const output = count(u.completion_tokens);
  if (input === undefined && output === undefined) return null;
  const cachedInput = count(u.prompt_tokens_details?.cached_tokens);
  const cacheWrite = count(u.prompt_tokens_details?.cache_write_tokens);
  const reasoning = count(u.completion_tokens_details?.reasoning_tokens);
  return {
    input: input ?? 0,
    output: output ?? 0,
    ...(cachedInput ? { cachedInput } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

export function addUsage(total: UsageTotal, u: ModelUsage | null): void {
  total.calls += 1;
  if (!u) {
    total.missing += 1;
    return;
  }
  total.input += u.input;
  total.output += u.output;
  total.cachedInput += u.cachedInput ?? 0;
  total.cacheWrite += u.cacheWrite ?? 0;
  total.reasoning += u.reasoning ?? 0;
}

const n = (v: number) => v.toLocaleString("en-US");
const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

function inputText(input: number, cachedInput: number, cacheWrite: number): string {
  const cache = [cachedInput ? `캐시 읽기 ${n(cachedInput)}` : "", cacheWrite ? `쓰기 ${n(cacheWrite)}` : ""].filter(Boolean).join("·");
  return `입력 ${n(input)}${cache ? `(${cache})` : ""}`;
}

function outputText(output: number, reasoning: number): string {
  return `출력 ${n(output)}${reasoning ? `(생각 ${n(reasoning)})` : ""}`;
}

// 호출 한 번: "입력 12,345(캐시 읽기 8,000) · 출력 456(생각 120) · 3.2s". 사용량이 없으면 "사용량 없음 · 3.2s".
export function formatUsage(u: ModelUsage | null, ms: number): string {
  if (!u) return `사용량 없음 · ${secs(ms)}`;
  return `${inputText(u.input, u.cachedInput ?? 0, u.cacheWrite ?? 0)} · ${outputText(u.output, u.reasoning ?? 0)} · ${secs(ms)}`;
}

// 턴 합계와 대화 누계: "호출 3 · 입력 30,000 · 출력 900 · 12.4s · 대화 누계 입력 60,000 · 출력 1,800".
export function formatTurnUsage(turn: UsageTotal, ms: number, conversation: UsageTotal): string {
  const missing = turn.missing ? `(사용량 없음 ${turn.missing})` : "";
  return [
    `호출 ${turn.calls}${missing}`,
    inputText(turn.input, turn.cachedInput, turn.cacheWrite),
    outputText(turn.output, turn.reasoning),
    secs(ms),
    `대화 누계 입력 ${n(conversation.input)} · 출력 ${n(conversation.output)}`,
  ].join(" · ");
}
