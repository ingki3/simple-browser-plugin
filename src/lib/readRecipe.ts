// 읽기 레시피(C단계): 같은 구조의 페이지(B단계 페이지 키)에서 실제로 쓸모 있었던 읽기 도구 호출을 기억했다가,
// 다음에 describe_page 결과에 후보로 붙인다. 자동 실행하지 않고 모델이 고른다.
// 여기에는 DOM·chrome API 없이 계산하는 부분만 둔다. 저장은 src/background/readRecipes.ts.

import { ACTION_LOG_MAX_AGE_MS, maskName, pageKeyId, plainWord, type PageKey } from "./actionLog.ts";
import { QUERY_DOM_ATTRS } from "./modelText.ts";

export type RecipeTool = "query_dom" | "list_file_links" | "find_clickables";

export interface ReadRecipe {
  // pageKeyId(페이지 키): 주소 틀 + 뼈대 해시.
  page: string;
  tool: RecipeTool;
  // 정규화한 인자(키 순서 고정). 같은 호출인지 비교할 때 JSON 문자열로 본다.
  args: Record<string, string | number | boolean>;
  successes: number;
  // 연속 실패 수. MAX_FAILURES에 이르면 후보로 내지 않는다.
  failures: number;
  lastUsed: number;
}

export interface ReadHint {
  tool: RecipeTool;
  args: Record<string, string | number | boolean>;
  successes: number;
}

// 한 턴에서 본 읽기 도구 호출 하나.
export interface ReadObservation {
  page: PageKey;
  tool: RecipeTool;
  args: Record<string, string | number | boolean>;
  useful: boolean;
}

export const RECIPE_MAX_FAILURES = 3;
export const RECIPE_MAX_PER_PAGE = 3;
export const RECIPE_MAX_TOTAL = 300;
export const RECIPE_MAX_AGE_MS = ACTION_LOG_MAX_AGE_MS;

// 문자열 인자가 레시피로 남겨도 되는 값인지: 주소·이메일·key=value·긴 숫자·비밀 값처럼 보이는 낱말이 없어야 한다.
function safeString(s: string, max: number): boolean {
  return s.length > 0 && s.length <= max && maskName(s) === s;
}

// CSS 선택자는 [href*="download"]처럼 =를 쓰므로 따로 본다: 이메일·주소·긴 숫자가 없고,
// 따옴표 안 속성 값은 safeString을, 따옴표 밖의 이름·값 낱말(#id, .class, [attr=값])은 모두 plainWord를 통과해야 한다.
// 해시로 만든 class(css-1x2y3z)도 걸러지지만, 그런 선택자는 어차피 오래 가지 않는다.
function safeSelector(s: string, max: number): boolean {
  if (!s.trim() || s.length > max) return false;
  // 이메일·주소·긴 숫자, 그리고 -·공백으로 끊은 전화번호 같은 숫자 묶음(010-1234-5678)은 거부.
  if (/@|:\/\/|\d{5,}|\d[\d\s-]{5,}\d/.test(s)) return false;
  const quoted = Array.from(s.matchAll(/(["'])(.*?)\1/g), (m) => m[2]);
  if (!quoted.every((q) => q === "" || safeString(q, 40))) return false;
  const bare = s.replace(/(["'])(.*?)\1/g, " ");
  return (bare.match(/[A-Za-z0-9_-]+/g) ?? []).every((w) => plainWord(w));
}

// 레시피로 남길 인자만 골라 정규화한다. 남길 수 없으면 null.
// - query_dom: selector(필수)·attr·limit
// - list_file_links: query(있을 때만 — 검색어 없는 호출은 기억할 것이 없다)·limit
// - find_clickables: query(있을 때만)·region·onlyViewport·limit
export function recipeArgs(tool: string, raw: unknown): { tool: RecipeTool; args: ReadRecipe["args"] } | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const str = (k: string, max: number): string | null | undefined => {
    const v = a[k];
    if (v === undefined) return undefined;
    return typeof v === "string" && safeString(v, max) ? v : null;
  };
  if (tool === "query_dom") {
    const selector = typeof a.selector === "string" && safeSelector(a.selector, 200) ? a.selector : null;
    const attr = str("attr", 60);
    if (!selector || attr === null) return null;
    // query_dom이 받는 속성만 남긴다(예전 레시피의 다른 속성은 다시 쓸 수 없다, #43).
    if (attr && !(QUERY_DOM_ATTRS as readonly string[]).includes(attr)) return null;
    const args: ReadRecipe["args"] = { selector };
    if (attr) args.attr = attr;
    if (typeof a.limit === "number") args.limit = a.limit;
    return { tool, args };
  }
  if (tool === "list_file_links" || tool === "find_clickables") {
    const query = str("query", 60);
    if (!query) return null;
    // 결과를 바꾸는 옵션은 함께 남긴다(그대로 다시 불러야 같은 결과가 나온다).
    const args: ReadRecipe["args"] = { query };
    if (typeof a.limit === "number") args.limit = a.limit;
    if (tool === "find_clickables") {
      if (typeof a.region === "string") args.region = a.region;
      if (typeof a.onlyViewport === "boolean") args.onlyViewport = a.onlyViewport;
    }
    return { tool, args };
  }
  return null;
}

// 도구 결과가 쓸모 있었는지: 비어 있지 않아야 한다.
export function usefulResult(tool: RecipeTool, data: unknown): boolean {
  if (tool === "query_dom") {
    return (
      Array.isArray(data) &&
      data.some((r) => {
        const row = r as { text?: string; attrs?: Record<string, string> };
        return (row.text ?? "").trim().length > 0 || Object.values(row.attrs ?? {}).some((v) => v);
      })
    );
  }
  if (tool === "list_file_links") {
    return !!data && Array.isArray((data as { links?: unknown[] }).links) && (data as { links: unknown[] }).links.length > 0;
  }
  return Array.isArray(data) && data.length > 0;
}

const argsKey = (tool: string, args: ReadRecipe["args"]) => `${tool} ${JSON.stringify(args)}`;

// 한 턴의 관찰을 레시피에 반영한다. 관찰 순서대로 처리해 연속 실패 수가 시간 순서를 따르게 한다.
// - 같은 페이지·같은 도구에서 마지막으로 쓸모 있었던 호출만 성공으로 센다(앞선 시도는 모델이 고쳐 부른 것이라 세지 않음).
// - 이미 있는 레시피와 같은 호출이 빈 결과를 내면 실패로 센다.
export function applyObservations(recipes: ReadRecipe[], obs: ReadObservation[], now: number): ReadRecipe[] {
  const out = recipes.map((r) => ({ ...r }));
  const find = (page: string, tool: string, args: ReadRecipe["args"]) =>
    out.find((r) => r.page === page && argsKey(r.tool, r.args) === argsKey(tool, args));

  const lastUseful = new Map<string, number>();
  obs.forEach((o, i) => {
    if (o.useful) lastUseful.set(`${pageKeyId(o.page)} ${o.tool}`, i);
  });
  obs.forEach((o, i) => {
    const page = pageKeyId(o.page);
    const r = find(page, o.tool, o.args);
    if (!o.useful) {
      if (r) {
        r.failures++;
        r.lastUsed = now;
      }
      return;
    }
    if (lastUseful.get(`${page} ${o.tool}`) !== i) return;
    if (r) {
      r.successes++;
      r.failures = 0;
      r.lastUsed = now;
    } else {
      out.push({ page, tool: o.tool, args: o.args, successes: 1, failures: 0, lastUsed: now });
    }
  });
  return pruneRecipes(out, now);
}

// 오래된 것·꺼진 것을 지우고, 페이지마다 RECIPE_MAX_PER_PAGE개, 전체 RECIPE_MAX_TOTAL개까지 남긴다.
export function pruneRecipes(raw: unknown, now: number): ReadRecipe[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter(
    (r): r is ReadRecipe =>
      !!r &&
      typeof r === "object" &&
      typeof (r as ReadRecipe).page === "string" &&
      typeof (r as ReadRecipe).lastUsed === "number" &&
      now - (r as ReadRecipe).lastUsed <= RECIPE_MAX_AGE_MS &&
      (r as ReadRecipe).failures < RECIPE_MAX_FAILURES &&
      // query_dom이 더는 받지 않는 속성을 쓴 예전 레시피는 버린다(#43).
      !(
        (r as ReadRecipe).tool === "query_dom" &&
        typeof (r as ReadRecipe).args?.attr === "string" &&
        !(QUERY_DOM_ATTRS as readonly string[]).includes((r as ReadRecipe).args.attr as string)
      ),
  );
  // 최근에 쓴 것부터 남긴다.
  valid.sort((a, b) => b.lastUsed - a.lastUsed);
  const perPage = new Map<string, number>();
  const kept: ReadRecipe[] = [];
  for (const r of valid) {
    const n = perPage.get(r.page) ?? 0;
    if (n >= RECIPE_MAX_PER_PAGE) continue;
    perPage.set(r.page, n + 1);
    kept.push(r);
    if (kept.length >= RECIPE_MAX_TOTAL) break;
  }
  return kept;
}

// 이 페이지에 낼 후보. 뼈대 해시까지 같은 페이지 키만 본다. 성공이 많은 것부터.
export function hintsFor(recipes: ReadRecipe[], page: PageKey, now: number): ReadHint[] {
  if (!page.skeleton) return [];
  const id = pageKeyId(page);
  return pruneRecipes(recipes, now)
    .filter((r) => r.page === id)
    .sort((a, b) => b.successes - a.successes || b.lastUsed - a.lastUsed)
    .map((r) => ({ tool: r.tool, args: r.args, successes: r.successes }));
}
