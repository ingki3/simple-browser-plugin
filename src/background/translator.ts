import { maskStringForModel } from "./loginSecrets";
import { providerAdapter, providerTimeout } from "@/lib/providers";
import { activeModel, normalizeSettings, targetKey, type ActiveModel } from "@/lib/settings";
import type { Settings } from "@/lib/messages";
import {
  parseTranslationResponse,
  translationResponseFormat,
} from "@/lib/translationProtocol";
import { isUsableTranslation } from "@/lib/translationSegments";
import { debugLog } from "./debug";
import { getSettings } from "./storage";
import { beginTargetGuard, TargetChangedError } from "./modelTarget";

const TRANSLATION_CACHE_MAX = 5000;
const TRANSLATION_REQUEST_TIMEOUT_MS = 90_000;
const translationCache = new Map<string, string>();
let batchCounter = 0;

// 같은 모델 이름이라도 제공자·로컬 서버가 다르면 다른 번역이다(#193). 키는 넣지 않는다.
function cacheKey(active: Pick<ActiveModel, "provider" | "model" | "baseUrl">, targetLang: string, text: string): string {
  return `${active.provider}\u0000${active.provider === "local" ? (active.baseUrl ?? "") : ""}\u0000${active.model}\u0000${targetLang}\u0000${text}`;
}

// ---- 번역 세션(#193) ----
// translate_page 한 번(첫 화면·나머지 배치·동적 재번역 모두)은 시작할 때 대화에 고정한 대상으로만 보낸다. content script는 불투명한 세션 id만
// 갖고(키·주소는 이 메모리에만), 대상이 바뀌거나 번역을 멈추면 세션을 끝내 그 뒤의 배치는 어느 쪽으로도 보내지 않는다.
interface TranslationSession {
  active: ActiveModel;
  key: string;
  // 진행 중인 배치 요청(대상이 바뀌면 멈춘다).
  controllers: Set<AbortController>;
}
const sessions = new Map<string, TranslationSession>();
const MAX_SESSIONS = 50;

// 서비스 워커가 다시 떠도 동적 재번역이 이어지게 세션 id → 대상의 해시를 chrome.storage.session(메모리, 확장만 읽음)에 둔다.
// 키·주소는 저장하지 않고 해시만 — 되살릴 때 지금 설정의 대상 해시와 같아야 그 대상으로 이어 간다(바뀌었으면 끝냄).
const PERSIST_KEY = "translationSessions";

async function targetHash(active: Pick<ActiveModel, "provider" | "apiKey" | "model" | "baseUrl">): Promise<string> {
  const bytes = new TextEncoder().encode(targetKey(active));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 끝낸 세션 id(늦게 끝난 해시 저장·복구가 되살리지 못하게, 최근 것만).
const ended = new Set<string>();
const ENDED_MAX = 200;

let persistQueue: Promise<unknown> = Promise.resolve();
function persist(fn: (m: Record<string, string>) => Record<string, string>): Promise<void> {
  const run = persistQueue.then(async () => {
    const cur = ((await chrome.storage.session.get(PERSIST_KEY))[PERSIST_KEY] ?? {}) as Record<string, string>;
    await chrome.storage.session.set({ [PERSIST_KEY]: fn({ ...cur }) });
  });
  persistQueue = run.catch(() => {});
  return run;
}

export function beginTranslationSession(active: ActiveModel): string {
  const id = crypto.randomUUID();
  sessions.set(id, { active, key: targetKey(active), controllers: new Set() });
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    endTranslationSession(oldest);
  }
  void targetHash(active)
    .then((h) =>
      persist((m) => {
        // 해시를 구하는 사이 끝낸 세션은 저장하지 않는다.
        if (ended.has(id) || !sessions.has(id)) return m;
        m[id] = h;
        const ids = Object.keys(m);
        for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete m[old];
        return m;
      }),
    )
    .catch(() => {});
  return id;
}

export function endTranslationSession(id: string): void {
  const s = sessions.get(id);
  sessions.delete(id);
  ended.add(id);
  while (ended.size > ENDED_MAX) {
    const oldest = ended.values().next().value;
    if (oldest === undefined) break;
    ended.delete(oldest);
  }
  if (s) for (const c of s.controllers) c.abort();
  void persist((m) => {
    delete m[id];
    return m;
  }).catch(() => {});
}

// 메모리에 없는 세션(서비스 워커가 다시 뜸)을 되살린다: 저장한 해시가 지금 설정의 대상과 같을 때만.
async function restoreSession(id: string): Promise<TranslationSession | null> {
  if (!id || ended.has(id)) return null;
  const got = (await chrome.storage.session.get(PERSIST_KEY).catch(() => ({}))) as Record<string, unknown>;
  const saved = (got[PERSIST_KEY] ?? {}) as Record<string, string>;
  const hash = saved[id];
  if (!hash) return null;
  const active = activeModel(await getSettings());
  if (!active.ready || (await targetHash(active)) !== hash) {
    endTranslationSession(id);
    return null;
  }
  // 기다리는 사이 다른 배치가 먼저 되살렸으면 그것을 쓰고, 그 사이 끝냈으면 되살리지 않는다.
  const again = sessions.get(id);
  if (again) return again;
  if (ended.has(id)) return null;
  const session = { active, key: targetKey(active), controllers: new Set<AbortController>() };
  sessions.set(id, session);
  debugLog("translate:session_restored", id.slice(0, 8));
  return session;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("settings" in changes)) return;
  const key = targetKey(activeModel(normalizeSettings(changes.settings.newValue as Partial<Settings> | undefined)));
  for (const [id, s] of sessions) if (s.key !== key) endTranslationSession(id);
});

export const TRANSLATION_SESSION_ENDED = "번역을 멈췄습니다(설정에서 모델 제공자·키·모델·서버 주소가 바뀌었거나 번역이 끝났습니다). 다시 번역을 요청해 주세요.";

function cacheTranslation(key: string, value: string): void {
  if (translationCache.size >= TRANSLATION_CACHE_MAX) {
    const oldest = translationCache.keys().next().value;
    if (typeof oldest === "string") translationCache.delete(oldest);
  }
  translationCache.set(key, value);
}

export async function translateBatch(texts: string[], targetLang: string, sessionId: string): Promise<string[]> {
  const session = sessions.get(sessionId) ?? (await restoreSession(sessionId));
  if (!session) throw new Error(TRANSLATION_SESSION_ENDED);
  const active = session.active;
  const { provider, model } = active;
  const adapter = providerAdapter(provider);
  const uniqueTexts = [...new Set(texts)];
  const missingTexts = uniqueTexts.filter(
    (text) => !translationCache.has(cacheKey(active, targetLang, text)),
  );
  const batchId = ++batchCounter;
  if (missingTexts.length === 0) {
    debugLog("translate:batch:cache", `#${batchId} · ${texts.length}개`);
    return texts.map(
      (text) => translationCache.get(cacheKey(active, targetLang, text)) ?? text,
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
  const limit = providerTimeout(provider, TRANSLATION_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limit);
  session.controllers.add(controller);
  const guard = beginTargetGuard(active, controller.signal);
  let raw: string;
  try {
    // 자동 로그인으로 넣은 값이 페이지 글자로 옮겨졌어도 모델로 보내지 않는다(loginSecrets).
    const content = (await maskStringForModel(prompt)).text;
    // 가림을 기다리는 사이 대상이 바뀌었거나 세션이 끝났으면 어느 쪽으로도 보내지 않는다. 확인 다음 줄에서 바로 보낸다.
    await guard.verify();
    if (!sessions.has(sessionId)) throw new Error(TRANSLATION_SESSION_ENDED);
    raw = await adapter.complete(
      active,
      {
        model,
        messages: [{ role: "user", content }],
        temperature: 0,
        maxTokens: Math.min(8192, Math.max(1024, Math.ceil(charCount * 3))),
        reasoning: "off",
        responseFormat: translationResponseFormat(missingTexts.length),
        strictJson: true,
      },
      guard.signal,
    );
    // 받은 직후에도 대상·세션을 다시 본다(바뀌었으면 결과를 버림).
    guard.assert();
    if (!sessions.has(sessionId)) throw new Error(TRANSLATION_SESSION_ENDED);
  } catch (err) {
    const ended = err instanceof TargetChangedError || guard.changed() || !sessions.has(sessionId);
    const timedOut = !ended && controller.signal.aborted;
    const message = ended
      ? TRANSLATION_SESSION_ENDED
      : timedOut
        ? `${adapter.label} 번역 배치가 ${limit / 1000}초를 초과했습니다.`
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
    session.controllers.delete(controller);
    guard.end();
  }

  let translated: string[];
  try {
    translated = parseTranslationResponse(raw, missingTexts.length);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 응답 원문은 남기지 않는다(키·서버 주소가 되돌아왔을 수 있다, #193) — 길이만.
    debugLog(
      "translate:batch:error",
      `#${batchId} · ${Date.now() - startedAt}ms · ${message} · 응답 ${raw.length}자`,
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
      cacheTranslation(cacheKey(active, targetLang, text), value);
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
      fresh.get(text) ?? translationCache.get(cacheKey(active, targetLang, text)) ?? text,
  );
}
