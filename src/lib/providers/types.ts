// 모델 제공자 어댑터(#97). 에이전트 루프·번역·저장 링크 초안은 이 인터페이스만 쓴다. 대화 기록·스트림 조각의 내부 기준은
// OpenAI 호환 형식(OpenRouterMessage·OpenRouterStreamChunk)이고, 어댑터가 제공자 형식과 서로 바꾼다.
import type { OpenRouterMessage, OpenRouterStreamChunk } from "../openrouter.ts";

export type ProviderId = "openrouter" | "openai" | "gemini" | "anthropic";

export const PROVIDER_IDS: readonly ProviderId[] = ["openrouter", "openai", "gemini", "anthropic"];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

// 생각(추론) 강도의 의도. 어댑터가 모델·제공자에 맞는 설정으로 바꾼다.
// - agent: 에이전트 기본(생각 상한을 두어 답·도구 호출 자리를 남김)
// - agent_low: 생각만 하다 상한에 걸려 답이 비었을 때 다시 시도(강도를 낮춤)
// - off: 번역·초안처럼 생각이 필요 없는 짧은 JSON 호출(생각 끔·숨김)
export type ReasoningIntent = "agent" | "agent_low" | "off";

export interface ChatTool {
  type: "function";
  function: unknown;
}

export interface ChatRequest {
  model: string;
  messages: OpenRouterMessage[];
  tools?: ChatTool[];
  toolChoice?: "auto" | "none";
  // 한 번에 도구 하나만 부르게 한다.
  parallelToolCalls?: boolean;
  maxTokens: number;
  reasoning: ReasoningIntent;
  temperature?: number;
  // 응답 형식(json_object 또는 json_schema, OpenAI 형식).
  responseFormat?: Record<string, unknown>;
  // 형식을 엄격히 지켜야 하는 요청(번역 배치): 지원하는 제공자는 매개변수를 지키는 경로·깨진 JSON 보정을 쓴다.
  strictJson?: boolean;
}

export interface ChatStream {
  // 조각을 내부 기준 형식으로 넘긴다. inactivityMs 동안 조각이 없으면 오류.
  read(onChunk: (chunk: OpenRouterStreamChunk) => void, inactivityMs: number): Promise<void>;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  // 사용자 메시지의 파일 조각(type "file", PDF 첨부)을 받는지. 받지 않으면 PDF는 첨부하지 않고 read_document로 읽게 한다.
  supportsFileParts: boolean;
  // 스트림 요청을 연다(연결·HTTP 오류는 여기서). 읽기는 돌려준 ChatStream으로.
  openStream(apiKey: string, req: ChatRequest, signal?: AbortSignal): Promise<ChatStream>;
  // 스트림 없이 한 번 받는다. 응답 본문 글자(없으면 "").
  complete(apiKey: string, req: ChatRequest, signal?: AbortSignal): Promise<string>;
}
