import { containsSecret, maskStringForModel } from "./loginSecrets";
import { providerAdapter, providerTimeout } from "@/lib/providers";
import { activeModel, normalizeSettings, targetKey, type ActiveModel } from "@/lib/settings";
import type { Settings } from "@/lib/messages";
import {
  buildTranslationPrompt,
  DEFAULT_TRANSLATION_STYLE,
  GLOSSARY_FOLLOWER_ITEMS,
  GLOSSARY_GENERATOR_ITEMS,
  GLOSSARY_MAX,
  isTranslationStyle,
  mergeGlossary,
  parseTranslationResponse,
  sanitizeGlossaryEntries,
  translationCacheKey,
  translationMaxTokens,
  translationResponseFormat,
  type GlossaryEntry,
  type TranslationStyle,
} from "@/lib/translationProtocol";
import { isUsableTranslation } from "@/lib/translationSegments";
import { debugLog } from "./debug";
import { beginTargetGuard, TargetChangedError } from "./modelTarget";

const TRANSLATION_CACHE_MAX = 5000;
const TRANSLATION_REQUEST_TIMEOUT_MS = 90_000;
// 기준표 생성 요청을 몇 번까지 시도하는지(#302). 넘으면 빈 기준표로 이어 간다.
const GLOSSARY_MAX_ATTEMPTS = 2;
let batchCounter = 0;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---- 번역 세션(#193, #302) ----
// translate_page 한 번(첫 화면·나머지 배치·동적 재번역 모두)은 시작할 때 대화에 고정한 대상으로만 보낸다. content script는 불투명한 세션 id만
// 갖고(키·주소는 이 메모리에만), 대상이 바뀌거나 번역을 멈추면 세션을 끝내 그 뒤의 배치는 어느 쪽으로도 보내지 않는다.
// #302: 대상 언어·문체도 세션에 고정하고, 번역 캐시와 번역 기준표(용어 → 번역)를 세션마다 따로 둔다(세션 사이에 넘기지 않는다).
interface TranslationSession {
  active: ActiveModel;
  key: string;
  targetLang: string;
  style: TranslationStyle;
  // 진행 중인 배치 요청(대상이 바뀌면 멈춘다).
  controllers: Set<AbortController>;
  // 이 세션의 번역 캐시(키: 프롬프트 판본·문체·대상·언어·원문).
  cache: Map<string, string>;
  // 번역 기준표. 페이지 글과 모델 응답에서 나온 신뢰하지 않는 자료 — 프롬프트의 자료 구역에만 넣고 승인·동작 판정에 쓰지 않는다.
  glossary: GlossaryEntry[];
  // none: 아직 만들지 않음(다음 실제 요청이 생성 요청) · pending: 생성 요청이 진행 중(다른 요청은 gate를 기다림) · ready: 만든 뒤.
  glossaryState: "none" | "pending" | "ready";
  glossaryGate: Deferred | null;
  // 실제로 보낸 생성 요청 수.
  glossaryAttempts: number;
}
const sessions = new Map<string, TranslationSession>();
const MAX_SESSIONS = 50;

export function beginTranslationSession(
  active: ActiveModel,
  opts: { targetLang: string; style?: unknown },
): string {
  const id = crypto.randomUUID();
  sessions.set(id, {
    active,
    key: targetKey(active),
    targetLang: opts.targetLang,
    style: isTranslationStyle(opts.style) ? opts.style : DEFAULT_TRANSLATION_STYLE,
    controllers: new Set(),
    cache: new Map(),
    glossary: [],
    glossaryState: "none",
    glossaryGate: null,
    glossaryAttempts: 0,
  });
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    endTranslationSession(oldest);
  }
  return id;
}

export function endTranslationSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  for (const c of s.controllers) c.abort();
  // 기준표를 기다리던 요청을 깨운다(깨어난 요청은 세션이 없어 종료 오류로 끝난다).
  s.glossaryGate?.resolve();
  s.glossaryGate = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("settings" in changes)) return;
  const key = targetKey(activeModel(normalizeSettings(changes.settings.newValue as Partial<Settings> | undefined)));
  for (const [id, s] of sessions) if (s.key !== key) endTranslationSession(id);
});

export const TRANSLATION_SESSION_ENDED = "번역을 멈췄습니다(설정에서 모델 제공자·키·모델·서버 주소가 바뀌었거나 번역이 끝났습니다). 다시 번역을 요청해 주세요.";

function cacheKey(session: TranslationSession, text: string): string {
  const { provider, model, baseUrl } = session.active;
  return translationCacheKey({ style: session.style, provider, baseUrl, model, targetLang: session.targetLang, text });
}

function cacheTranslation(session: TranslationSession, key: string, value: string): void {
  if (session.cache.size >= TRANSLATION_CACHE_MAX) {
    const oldest = session.cache.keys().next().value;
    if (typeof oldest === "string") session.cache.delete(oldest);
  }
  session.cache.set(key, value);
}

// 응답의 기준표를 쓸 수 있는 항목으로 줄인다: 모양·길이·출처(보낸 원문 안) 정리 뒤 항목마다 자동 로그인 가림 목록과 대조해 걸리면 버린다.
// 가림 목록을 읽지 못하면 그 응답의 항목을 모두 버린다(검사하지 못한 항목은 쓰지 않는다).
async function usableGlossary(raw: GlossaryEntry[] | null, sourceTexts: string[]): Promise<GlossaryEntry[] | null> {
  if (!raw) return null;
  const cleaned = sanitizeGlossaryEntries(raw, sourceTexts);
  const kept: GlossaryEntry[] = [];
  try {
    for (const e of cleaned) if (!(await containsSecret([e.source, e.target]))) kept.push(e);
  } catch {
    return null;
  }
  return kept;
}

function alive(sessionId: string, session: TranslationSession): boolean {
  return sessions.get(sessionId) === session;
}

export async function translateBatch(texts: string[], targetLang: string, sessionId: string): Promise<string[]> {
  const session = sessions.get(sessionId);
  // 세션의 대상 언어와 다른 요청은 보내지 않는다(한 세션의 기준표에는 한 언어 항목만).
  if (!session || session.targetLang !== targetLang) throw new Error(TRANSLATION_SESSION_ENDED);
  const fromCache = () => texts.map((text) => session.cache.get(cacheKey(session, text)) ?? text);
  const uniqueTexts = [...new Set(texts)];
  const missing = () => uniqueTexts.filter((text) => !session.cache.has(cacheKey(session, text)));
  const batchId = ++batchCounter;
  let missingTexts = missing();
  if (missingTexts.length === 0) {
    debugLog("translate:batch:cache", `#${batchId} · ${texts.length}개`);
    return fromCache();
  }
  // 기준표를 만드는 중이면 끝날 때까지 기다린다(그 사이 캐시가 찼으면 보내지 않는다).
  while (session.glossaryState === "pending") {
    await session.glossaryGate?.promise;
    if (!alive(sessionId, session)) throw new Error(TRANSLATION_SESSION_ENDED);
    missingTexts = missing();
    if (missingTexts.length === 0) {
      debugLog("translate:batch:cache", `#${batchId} · ${texts.length}개`);
      return fromCache();
    }
  }
  const generator = session.glossaryState === "none";
  let gate: Deferred | null = null;
  if (generator) {
    session.glossaryState = "pending";
    gate = deferred();
    session.glossaryGate = gate;
    session.glossaryAttempts += 1;
  }
  try {
    const result = await requestBatch(session, sessionId, texts, missingTexts, batchId, generator);
    if (generator && session.glossaryState === "pending") session.glossaryState = "ready";
    return result;
  } catch (err) {
    // 생성 요청이 실패하면(응답 모양 오류·시간 초과·네트워크 모두) 한 번 더 다른 요청이 생성 요청이 되고, 두 번째도 실패하면 빈 기준표로 이어 간다.
    // 오류는 지금처럼 호출자에게 던진다(새 재시도 경로를 만들지 않는다).
    if (generator && session.glossaryState === "pending") {
      if (session.glossaryAttempts < GLOSSARY_MAX_ATTEMPTS) {
        session.glossaryState = "none";
      } else {
        session.glossary = [];
        session.glossaryState = "ready";
      }
    }
    throw err;
  } finally {
    if (gate) {
      if (session.glossaryGate === gate) session.glossaryGate = null;
      gate.resolve();
    }
  }
}

async function requestBatch(
  session: TranslationSession,
  sessionId: string,
  texts: string[],
  missingTexts: string[],
  batchId: number,
  generator: boolean,
): Promise<string[]> {
  const active = session.active;
  const { provider, model } = active;
  const targetLang = session.targetLang;
  const adapter = providerAdapter(provider);
  const prompt = buildTranslationPrompt({
    targetLang,
    style: session.style,
    texts: missingTexts,
    glossary: session.glossary.slice(),
    generator,
  });

  const charCount = missingTexts.reduce((sum, text) => sum + text.length, 0);
  const startedAt = Date.now();
  debugLog(
    "translate:batch:start",
    `#${batchId} · model=${model} · ${missingTexts.length}/${texts.length}개 · ${charCount}자` +
      ` · 용어표 ${session.glossary.length}개${generator ? " · 용어표 생성" : ""}`,
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
    if (!alive(sessionId, session)) throw new Error(TRANSLATION_SESSION_ENDED);
    raw = await adapter.complete(
      active,
      {
        model,
        messages: [{ role: "user", content }],
        temperature: 0,
        maxTokens: translationMaxTokens(charCount, generator),
        reasoning: "off",
        responseFormat: translationResponseFormat(
          missingTexts.length,
          generator ? GLOSSARY_GENERATOR_ITEMS : GLOSSARY_FOLLOWER_ITEMS,
        ),
        strictJson: true,
      },
      guard.signal,
    );
    // 받은 직후에도 대상·세션을 다시 본다(바뀌었으면 결과를 버림).
    guard.assert();
    if (!alive(sessionId, session)) throw new Error(TRANSLATION_SESSION_ENDED);
  } catch (err) {
    const ended = err instanceof TargetChangedError || guard.changed() || !alive(sessionId, session);
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

  let parsed: ReturnType<typeof parseTranslationResponse>;
  try {
    parsed = parseTranslationResponse(raw, missingTexts.length);
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
  const translated = parsed.translations;
  // 기준표가 없거나 틀려도 번역은 쓴다(생성 요청이면 빈 기준표로 ready — 다시 만들지 않는다).
  const entries = await usableGlossary(parsed.glossary, missingTexts);
  // 검사를 기다리는 사이 세션이 끝났으면 기준표·캐시에 반영하지 않는다.
  if (!alive(sessionId, session)) throw new Error(TRANSLATION_SESSION_ENDED);
  const before = session.glossary.length;
  if (entries?.length) session.glossary = mergeGlossary(session.glossary, entries, GLOSSARY_MAX);
  // 원문을 그대로 돌려줬거나 세그먼트를 깨뜨린 결과는 캐시하지 않는다.
  // 캐시하면 재시도·새로고침 후에도 같은 문단이 계속 번역되지 않은 채로 돌아온다.
  const fresh = new Map<string, string>();
  let rejected = 0;
  missingTexts.forEach((text, index) => {
    const value = translated[index];
    fresh.set(text, value);
    if (isUsableTranslation(text, value, targetLang)) {
      cacheTranslation(session, cacheKey(session, text), value);
    } else {
      rejected += 1;
    }
  });
  // 기준표 글자는 로그에 남기지 않는다(개수만).
  debugLog(
    "translate:batch:end",
    `#${batchId} · ${Date.now() - startedAt}ms · ${missingTexts.length}개` +
      (rejected ? ` · 미번역 의심 ${rejected}개` : "") +
      ` · 용어표 +${session.glossary.length - before}${entries ? "" : "(응답 기준표 없음·무효)"}`,
    rejected ? "warn" : "info",
  );
  return texts.map((text) => fresh.get(text) ?? session.cache.get(cacheKey(session, text)) ?? text);
}
