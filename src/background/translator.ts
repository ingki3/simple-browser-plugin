import { openRouterJson } from "@/lib/openrouter";
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
    '- 입력 배열과 동일한 길이의 문자열 배열을 {"translations": [...]} JSON 객체로만 출력한다.',
    "- 짧은 공백·숫자·기호만 있는 조각은 원문을 그대로 둔다.",
    "- 이미 해당 언어이면 그대로 둔다.",
    "- HTML 태그가 보이면 구조를 망가뜨리지 말고 텍스트만 번역한다.",
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
      max_tokens: Math.min(8192, Math.max(512, Math.ceil(charCount * 2))),
      reasoning: { enabled: false, exclude: true },
      response_format: { type: "json_object" },
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
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    debugLog(
      "translate:batch:error",
      `#${batchId} · ${Date.now() - startedAt}ms · JSON 파싱 실패 · ${raw.slice(0, 160)}`,
      "error",
    );
    throw new Error("번역 응답 JSON 파싱 실패");
  }
  const values =
    parsed && typeof parsed === "object"
      ? (parsed as { translations?: unknown }).translations
      : parsed;
  if (!Array.isArray(values) || values.length !== missingTexts.length) {
    debugLog(
      "translate:batch:error",
      `#${batchId} · ${Date.now() - startedAt}ms · 길이 기대=${missingTexts.length} 실제=${Array.isArray(values) ? values.length : "?"}`,
      "error",
    );
    throw new Error(
      `번역 응답 길이 불일치: 기대 ${missingTexts.length}, 실제 ${Array.isArray(values) ? values.length : "?"}`,
    );
  }
  const translated = values.map((v) => (typeof v === "string" ? v : String(v)));
  missingTexts.forEach((text, index) => {
    cacheTranslation(cacheKey(model, targetLang, text), translated[index]);
  });
  debugLog(
    "translate:batch:end",
    `#${batchId} · ${Date.now() - startedAt}ms · ${missingTexts.length}개`,
  );
  return texts.map(
    (text) => translationCache.get(cacheKey(model, targetLang, text)) ?? text,
  );
}
