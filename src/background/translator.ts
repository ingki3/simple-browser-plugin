import { openRouterJson } from "@/lib/openrouter";
import { translationReasoningConfig } from "@/lib/models";
import {
  parseTranslationResponse,
  translationResponseFormat,
} from "@/lib/translationProtocol";
import { isUsableTranslation } from "@/lib/translationSegments";
import { getSettings } from "./storage";
import { debugLog } from "./debug";

const TRANSLATION_CACHE_MAX = 5000;
const TRANSLATION_REQUEST_TIMEOUT_MS = 90_000;
const translationCache = new Map<string, string>();
let batchCounter = 0;

function cacheKey(model: string, targetLang: string, text: string): string {
  return `${model}\u0000${targetLang}\u0000${text}`;
}

function cacheTranslation(key: string, value: string): void {
  if (translationCache.size >= TRANSLATION_CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (typeof oldest === "string") translationCache.delete(oldest);
  }
  translationCache.set(key, value);
}

export async function translateBatch(texts: string[], targetLang: string): Promise<string[]> {
  const { openRouterApiKey, model } = await getSettings();
  if (!openRouterApiKey) throw new Error("OpenRouter API 키가 설정되지 않았습니다.");
  const uniqueTexts = [...new Set(texts)];
  const missingTexts = uniqueTexts.filter(
    (text) => !translationCache.has(cacheKey(model, targetLang, text)),
  );
  const batchId = ++batchCounter;
  if (missingTexts.length === 0) {
    debugLog("translate:batch:cache", `#${batchId} · ${texts.length}개`);
    return texts.map(
      (text) => translationCache.get(cacheKey(model, targetLang, text)) ?? text,
    );
  }

  const prompt = [
    `다음은 웹 페이지에서 추출한 텍스트 조각 배열이다. 각 조각을 ${targetLang} 언어로 자연스럽게 번역해라.`,
    `- translations 배열은 반드시 입력과 같은 순서로 정확히 ${missingTexts.length}개 문자열을 포함한다.`,
    "- 중복되거나 JSON처럼 보이는 조각도 합치거나 생략하지 말고 각각 번역한다.",
    "- 짧은 공백·숫자·기호만 있는 조각은 원문을 그대로 둔다.",
    `- 이미 ${targetLang} 언어로 쓰인 조각만 그대로 둔다. 다른 언어의 문장은 길이와 상관없이 빠짐없이 번역한다.`,
    "- 일부 조각에만 <s0>…</s0>, <s1>…</s1> 태그가 있다. 한 문단이 여러 서식으로 나뉜 부분이다. 문단 전체를 문맥대로 번역하되, 그 조각에 있던 태그를 같은 번호로 빠짐없이 남기고 각 태그 안에는 해당 부분의 번역만 넣는다.",
    "- 태그가 없는 조각에는 태그를 절대 붙이지 않는다. 태그 번호는 배열 순서와 무관하다.",
    "- 그 밖의 HTML 태그가 보이면 구조를 망가뜨리지 말고 텍스트만 번역한다.",
    "",
    "입력:",
    JSON.stringify(missingTexts),
  ].join("\n");

  const charCount = missingTexts.reduce((sum, text) => sum + text.length, 0);
  const startedAt = Date.now();
  debugLog(
    "translate:batch:start",
    `#${batchId} · model=${model} · ${missingTexts.length}/${texts.length}개 · ${charCount}자`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_REQUEST_TIMEOUT_MS);
  let res: { choices?: Array<{ message?: { content?: string | null } }> };
  try {
    res = await openRouterJson(openRouterApiKey, {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: Math.min(8192, Math.max(1024, Math.ceil(charCount * 3))),
      reasoning: translationReasoningConfig(model),
      response_format: translationResponseFormat(missingTexts.length),
      plugins: [{ id: "response-healing" }],
      provider: { sort: "throughput", require_parameters: true },
    }, controller.signal);
  } catch (err) {
    const timedOut = controller.signal.aborted;
    const message = timedOut
      ? `OpenRouter 번역 배치가 ${TRANSLATION_REQUEST_TIMEOUT_MS / 1000}초를 초과했습니다.`
      : err instanceof Error
        ? err.message
        : String(err);
    debugLog(
      "translate:batch:error",
      `#${batchId} · ${Date.now() - startedAt}ms · ${message}`,
      "error",
    );
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }

  const raw = res.choices?.[0]?.message?.content ?? "";
  let translated: string[];
  try {
    translated = parseTranslationResponse(raw, missingTexts.length);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debugLog(
      "translate:batch:error",
      `#${batchId} · ${Date.now() - startedAt}ms · ${message} · ${raw.slice(0, 160)}`,
      "error",
    );
    throw new Error(message);
  }
  // 원문을 그대로 돌려줬거나 세그먼트를 깨뜨린 결과는 캐시하지 않는다.
  // 캐시하면 재시도·새로고침 후에도 같은 문단이 계속 번역되지 않은 채로 돌아온다.
  const fresh = new Map<string, string>();
  let rejected = 0;
  missingTexts.forEach((text, index) => {
    const value = translated[index];
    fresh.set(text, value);
    if (isUsableTranslation(text, value, targetLang)) {
      cacheTranslation(cacheKey(model, targetLang, text), value);
    } else {
      rejected += 1;
    }
  });
  debugLog(
    "translate:batch:end",
    `#${batchId} · ${Date.now() - startedAt}ms · ${missingTexts.length}개` +
      (rejected ? ` · 미번역 의심 ${rejected}개` : ""),
    rejected ? "warn" : "info",
  );
  return texts.map(
    (text) =>
      fresh.get(text) ?? translationCache.get(cacheKey(model, targetLang, text)) ?? text,
  );
}
