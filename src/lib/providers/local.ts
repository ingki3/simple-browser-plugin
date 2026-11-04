// 로컬·호환 서버 어댑터(#193). 사용자가 설정에 적은 OpenAI 호환 서버(Ollama·LM Studio·llama.cpp server·vLLM 등)의
// `POST {기본 주소}/chat/completions`로 보낸다. 고른 제공자로만 보낸다는 약속은 그대로 — 대화·페이지 글자는 이 주소로만 간다.
// - 기본 주소는 설정에서 사용자가 적은 값만 쓰고(localEndpoint로 검사), 3xx를 따르지 않는다(redirect: "error").
// - 서버마다 모를 수 있는 선택 필드(stream_options·response_format)는 거부(400·422)되면 빼고 한 번만 다시 보내고, 그 재시도가 성공했을 때만
//   (주소, 모델)별로 기억한다. parallel_tool_calls·reasoning_effort는 보내지 않는다. 판정은 상태 코드로만 한다(오류 문구를 보지 않음).
// - 생각 글자: reasoning_content(llama.cpp·vLLM·LM Studio)·reasoning(Ollama) 필드, 또는 답의 맨 앞 <think>…</think>.
// - 오류 문구는 키·서버 주소를 가린다(서버가 되돌려줘도 로그·화면·content script로 가지 않게).
// npm test(Node 타입 제거 실행)로 시험하므로 확장자를 붙여 불러온다.
import { chatJson, chatRequest, ProviderHttpError, readOpenRouterStream, type OpenRouterStreamChunk } from "../openrouter.ts";
import { openAiMessages } from "./openai.ts";
import { withoutFileParts } from "./gemini.ts";
import type { ChatRequest, ProviderAdapter, ProviderAuth } from "./types.ts";

export const LOCAL_LABEL = "로컬 서버";
export const LOCAL_ERROR_MAX = 300;
const OPTIONAL_FIELDS = ["stream_options", "response_format"] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];

// 백그라운드가 디버그 로그로 바꾼다(lib은 background를 불러오지 않는다).
let note: (tag: string, detail: string) => void = () => {};
export function setLocalNote(fn: (tag: string, detail: string) => void): void {
  note = fn;
}

// ---- 기본 주소 ----

function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function privateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1") return true;
  // 고유 로컬 주소 fc00::/7: 첫 16비트의 위 7비트가 1111110. 앞자리 0을 생략한 표기(fc::1 = 00fc::1)는 대역 밖이다.
  const first = h.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  return (parseInt(first, 16) & 0xfe00) === 0xfc00;
}

// 이 컴퓨터·내부망 주소인지(구조로만): localhost(와 *.localhost), IPv4 루프백·사설, IPv6 ::1·fc00::/7.
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || privateIpv4(h) || privateIpv6(h);
}

// 사용자가 적은 기본 주소를 검사하고 정규화한다(끝의 / 제거). http는 이 컴퓨터·내부망만, 그 밖은 https만 — 평문으로 대화를 보내는 범위를 줄인다.
export function localEndpoint(raw: string): { ok: true; base: string } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "로컬 서버 주소를 넣어 주세요(예: http://localhost:11434/v1)." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "서버 주소 형식이 맞지 않습니다(예: http://localhost:11434/v1)." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "서버 주소는 http:// 또는 https://로 시작해야 합니다." };
  if (url.username || url.password) return { ok: false, error: "서버 주소에 아이디·비밀번호를 넣지 마세요(키는 API 키 칸에)." };
  if (url.search || url.hash) return { ok: false, error: "서버 주소에는 ?나 #를 넣지 마세요." };
  if (url.protocol === "http:" && !privateHost(url.hostname)) {
    return { ok: false, error: "http 주소는 이 컴퓨터나 내부망(localhost·127.x·10.x·172.16~31.x·192.168.x)만 쓸 수 있습니다. 다른 곳은 https로 적어 주세요." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, base: `${url.protocol}//${url.host}${path}` };
}

// ---- 오류 가림 ----

// 오류 글에서 요청에 쓴 키(길이와 관계없이)와 서버 주소(정규화 값·원문)를 가리고 300자로 자른다.
export function scrubLocal(text: string, auth: ProviderAuth, base?: string): string {
  let out = text;
  const swap = (secret: string | undefined, label: string) => {
    if (secret) out = out.split(secret).join(label);
  };
  swap(auth.apiKey, "[키]");
  // 긴 것부터(정규화한 주소가 원문의 일부일 수 있다).
  for (const s of [auth.baseUrl?.trim(), base].filter((x): x is string => !!x).sort((a, b) => b.length - a.length)) swap(s, "[서버 주소]");
  return out.length > LOCAL_ERROR_MAX ? `${out.slice(0, LOCAL_ERROR_MAX)}…` : out;
}

export const LOCAL_CONNECT_ERROR =
  "로컬 서버에 연결하지 못했습니다. 서버가 켜져 있는지, 주소가 맞는지 확인해 주세요(다른 주소로 넘기는 응답은 따르지 않습니다).";

function extensionId(): string {
  const c = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
  return c?.runtime?.id ?? "<이 확장 ID>";
}

// 어댑터가 던지는 오류를 사용자 안내와 가린 원문으로 바꾼다. 중단(AbortError)은 그대로 둔다(부르는 쪽이 시간 초과·중단을 가린다).
export function localError(err: unknown, auth: ProviderAuth, base: string | undefined, toolsSent: boolean): unknown {
  if (err instanceof DOMException && err.name === "AbortError") return err;
  if (err instanceof ProviderHttpError) {
    const raw = scrubLocal(err.message, auth, base);
    if (err.status === 403 && base && privateHost(new URL(base).hostname)) {
      return new ProviderHttpError(
        `로컬 서버가 이 확장의 요청을 거부했습니다(HTTP 403). Ollama라면 OLLAMA_ORIGINS에 chrome-extension://${extensionId()}를 넣고 다시 시작하세요. 서버 원문: ${raw}`,
        403,
      );
    }
    if ((err.status === 400 || err.status === 422) && toolsSent) {
      return new ProviderHttpError(
        `로컬 서버가 요청을 거부했습니다(HTTP ${err.status}). 도구 호출(tools)을 지원하지 않는 모델이면 이 오류가 납니다. 서버 원문: ${raw}`,
        err.status,
      );
    }
    return new ProviderHttpError(raw, err.status);
  }
  // fetch가 서버에 닿지 못함(연결 거부·주소 없음) 또는 3xx를 거절함 — 둘을 구분할 수 없어 중립 문구.
  if (err instanceof TypeError) return new Error(`${LOCAL_CONNECT_ERROR} (${scrubLocal(err.message, auth, base)})`);
  if (err instanceof Error) return new Error(scrubLocal(err.message, auth, base));
  return new Error(scrubLocal(String(err), auth, base));
}

// ---- 요청 본문 ----

export function localPayload(req: ChatRequest, stream: boolean, drop: ReadonlySet<OptionalField> = new Set()): Record<string, unknown> {
  return {
    model: req.model,
    // 호환 서버는 파일 조각(PDF)을 받지 않을 수 있다 — Gemini와 같게 안내 글자로 바꾼다(PDF는 read_document로).
    messages: withoutFileParts(openAiMessages(req.messages)),
    // 도구 없이 답만 받는 마무리 요청(toolChoice "none")은 도구 목록을 보내지 않는다 — tool_choice를 모르는 서버(Ollama)에서도
    // 모델이 도구를 고를 수 없게(#193 리뷰). 기록의 도구 호출·결과는 그대로 보낸다.
    ...(req.tools && req.toolChoice !== "none" ? { tools: req.tools } : {}),
    ...(req.toolChoice && req.toolChoice !== "none" ? { tool_choice: req.toolChoice } : {}),
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.responseFormat && !drop.has("response_format") ? { response_format: req.responseFormat } : {}),
    ...(stream ? { stream: true, ...(drop.has("stream_options") ? {} : { stream_options: { include_usage: true } }) } : {}),
  };
}

function optionalFieldsOf(req: ChatRequest, stream: boolean): OptionalField[] {
  return OPTIONAL_FIELDS.filter((f) => (f === "stream_options" ? stream : !!req.responseFormat));
}

// (기본 주소, 모델) → 빼고 보내야 하는 선택 필드(뺀 재시도가 성공했을 때만 기억, 서비스 워커가 살아 있는 동안).
const dropped = new Map<string, Set<OptionalField>>();
export function resetLocalMemory(): void {
  dropped.clear();
}

async function send(auth: ProviderAuth, req: ChatRequest, stream: boolean, signal: AbortSignal | undefined): Promise<{ response: Response; base: string }> {
  const ep = localEndpoint(auth.baseUrl ?? "");
  if (!ep.ok) throw new Error(ep.error);
  const url = `${ep.base}/chat/completions`;
  const memo = `${ep.base}\u0000${req.model}`;
  const drop = new Set(dropped.get(memo) ?? []);
  const headers: Record<string, string> = auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {};
  const attempt = (d: ReadonlySet<OptionalField>) => chatRequest(url, headers, localPayload(req, stream, d), signal, LOCAL_LABEL, { redirect: "error" });
  const toolsSent = !!req.tools && req.toolChoice !== "none";
  try {
    try {
      return { response: await attempt(drop), base: ep.base };
    } catch (err) {
      const optional = optionalFieldsOf(req, stream).filter((f) => !drop.has(f));
      const rejected = err instanceof ProviderHttpError && (err.status === 400 || err.status === 422);
      // 그 사이 멈췄으면(중단·설정 변경) 다시 보내지 않는다.
      if (!rejected || !optional.length || signal?.aborted) throw err;
      const next = new Set<OptionalField>([...drop, ...optional]);
      const response = await attempt(next);
      dropped.set(memo, next);
      note("local:dropped_fields", optional.join(","));
      return { response, base: ep.base };
    }
  } catch (err) {
    throw localError(err, auth, ep.base, toolsSent);
  }
}

// ---- 스트림 ----

const OPEN = "<think>";
const CLOSE = "</think>";

// 인덱스 없는 도구 호출 조각에 번호를 매긴다. id가 있는 조각은 지금 호출에 이미 id가 있을 때만 새 호출이다 — id·이름·인자가 따로 와도
// 한 호출로 묶는다(이름만 온 조각은 지금 호출의 것).
export function localToolIndexer(): (calls: NonNullable<NonNullable<NonNullable<OpenRouterStreamChunk["choices"]>[number]["delta"]>["tool_calls"]>) => typeof calls {
  let next = 0;
  let cur = -1;
  let curHasId = false;
  return (calls) =>
    calls.map((c) => {
      if (typeof c.index === "number") {
        if (c.index !== cur) curHasId = false;
        cur = c.index;
        next = Math.max(next, c.index + 1);
        if (c.id) curHasId = true;
        return c;
      }
      const fresh = cur < 0 || (!!c.id && curHasId);
      if (fresh) {
        cur = next++;
        curHasId = false;
      }
      if (c.id) curHasId = true;
      return { ...c, index: cur };
    });
}

type Delta = NonNullable<NonNullable<OpenRouterStreamChunk["choices"]>[number]["delta"]>;

// 로컬 서버의 스트림 조각 → 내부 기준 조각. reasoning_content를 reasoning으로, 답 맨 앞의 <think>…</think>를 생각으로 옮긴다.
// 태그가 조각 사이에 갈라져 와도 되게 앞부분·끝 태그 길이만큼을 잠시 붙잡는다. 스트림이 정상으로 끝나면 flush로 남은 것을 낸다
// (오류·중단이면 부르지 않는다 — 버림).
export function localStreamMapper(): { map(chunk: OpenRouterStreamChunk): OpenRouterStreamChunk[]; flush(): OpenRouterStreamChunk[] } {
  let mode: "detect" | "think" | "text" = "detect";
  let held = "";
  const index = localToolIndexer();
  const out = (delta: Partial<Delta>, finish?: string | null): OpenRouterStreamChunk => ({
    choices: [{ delta: delta as Delta, ...(finish ? { finish_reason: finish } : {}) }],
  });
  // 본문 조각을 받아 (본문, 생각)으로 나눈다.
  const split = (text: string): { content: string; reasoning: string } => {
    let content = "";
    let reasoning = "";
    let rest = text;
    while (rest) {
      if (mode === "text") {
        content += rest;
        rest = "";
      } else if (mode === "detect") {
        held += rest;
        rest = "";
        const lead = held.trimStart();
        if (!lead || (lead.length < OPEN.length && OPEN.startsWith(lead))) break;
        if (lead.startsWith(OPEN)) {
          mode = "think";
          rest = lead.slice(OPEN.length);
          held = "";
        } else {
          mode = "text";
          content += held;
          held = "";
        }
      } else {
        held += rest;
        rest = "";
        const end = held.indexOf(CLOSE);
        if (end >= 0) {
          reasoning += held.slice(0, end);
          mode = "text";
          // 생각 뒤의 줄바꿈은 답에 넣지 않는다.
          rest = held.slice(end + CLOSE.length).replace(/^\s+/, "");
          held = "";
        } else if (held.length > CLOSE.length - 1) {
          reasoning += held.slice(0, held.length - (CLOSE.length - 1));
          held = held.slice(held.length - (CLOSE.length - 1));
        }
      }
    }
    return { content, reasoning };
  };
  return {
    map(chunk) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta as (Delta & { reasoning_content?: unknown }) | undefined;
      if (!choice || !delta) return [chunk];
      const { reasoning_content, content, reasoning, tool_calls, ...others } = delta;
      const parts = typeof content === "string" && content ? split(content) : { content: "", reasoning: "" };
      const thought = [typeof reasoning === "string" ? reasoning : "", typeof reasoning_content === "string" ? reasoning_content : "", parts.reasoning].join("");
      const next: Partial<Delta> = {
        ...others,
        ...(parts.content ? { content: parts.content } : {}),
        ...(thought ? { reasoning: thought } : {}),
        ...(tool_calls?.length ? { tool_calls: index(tool_calls) } : {}),
      };
      return [{ ...(chunk.usage ? { usage: chunk.usage } : {}), ...out(next, choice.finish_reason) }];
    },
    flush() {
      if (!held) return [];
      const text = held;
      held = "";
      // 판정 전에 끝난 짧은 답·미완성 시작 태그는 답으로, 닫히지 않은 생각은 생각으로.
      return mode === "think" ? [out({ reasoning: text })] : [out({ content: text })];
    },
  };
}

// 비스트림 답에서 맨 앞 <think>…</think>를 뗀다(닫는 태그가 없으면 답이 없다).
export function stripThink(text: string): string {
  const lead = text.trimStart();
  if (!lead.startsWith(OPEN)) return text;
  const end = lead.indexOf(CLOSE);
  return end < 0 ? "" : lead.slice(end + CLOSE.length).trim();
}

// ---- 모델 목록 ----

export const LOCAL_MODELS_MAX = 200;

// GET {기본 주소}/models의 data[].id. 목록을 주지 않는 서버는 오류(설정 화면은 직접 입력하게 안내).
export async function listLocalModels(auth: ProviderAuth, signal?: AbortSignal): Promise<string[]> {
  const ep = localEndpoint(auth.baseUrl ?? "");
  if (!ep.ok) throw new Error(ep.error);
  try {
    const res = await fetch(`${ep.base}/models`, {
      headers: auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {},
      redirect: "error",
      signal,
    });
    if (!res.ok) throw new ProviderHttpError(`${LOCAL_LABEL} 모델 목록 요청 실패 (HTTP ${res.status})`, res.status);
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const ids = (body?.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === "string" && !!id.trim());
    return [...new Set(ids)].slice(0, LOCAL_MODELS_MAX);
  } catch (err) {
    throw localError(err, auth, ep.base, false);
  }
}

export const localAdapter: ProviderAdapter = {
  id: "local",
  label: LOCAL_LABEL,
  supportsFileParts: false,
  signsContext: false,
  timeoutScale: 2,
  async openStream(auth, req, signal) {
    const { response, base } = await send(auth, req, true, signal);
    return {
      read: async (onChunk, inactivityMs) => {
        const mapper = localStreamMapper();
        try {
          await readOpenRouterStream(response, (c) => {
            for (const x of mapper.map(c)) onChunk(x);
          }, inactivityMs, LOCAL_LABEL);
        } catch (err) {
          throw localError(err, auth, base, !!req.tools);
        }
        for (const x of mapper.flush()) onChunk(x);
      },
    };
  },
  async complete(auth, req, signal) {
    const { response, base } = await send(auth, req, false, signal);
    try {
      const res = await chatJson<{ choices?: Array<{ message?: { content?: string | null } }> }>(response, LOCAL_LABEL);
      return stripThink(res.choices?.[0]?.message?.content ?? "");
    } catch (err) {
      throw localError(err, auth, base, !!req.tools);
    }
  },
};
