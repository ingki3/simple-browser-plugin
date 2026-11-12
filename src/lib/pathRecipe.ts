// 경로 레시피(#297 2단계): 한 요청(턴)에서 턴 탭이 같은 출처 안을 이동해 답을 마쳤을 때 거쳐 간 주소 틀의 나열을 기억했다가,
// 다음에 describe_page 결과에 pathHints로 붙인다. 후보 제시까지만 — 승인 판정·자동 실행의 입력이 아니다.
// 저장하는 것은 주소 틀(urlPattern)뿐이다. 요청 문장·링크 글자·페이지 글자·입력 값은 저장하지 않는다.
// 여기에는 DOM·chrome API 없이 계산하는 부분만 둔다. 관찰·저장은 src/background/pathRecipes.ts.

import { ACTION_LOG_MAX_AGE_MS, urlPattern } from "./actionLog.ts";
import { destructiveRoute, sensitiveUrlReason } from "./autoApprove.ts";
import type { RecipeSite } from "./readRecipe.ts";

export interface PathRecipe {
  id: string;
  origin: string;
  // 2~6개. steps[0]은 출발 틀, 마지막은 도착 틀.
  steps: string[];
  // 이 경로로 답을 마친 횟수(목표 달성 횟수가 아니다).
  uses: number;
  // 후보로 내 도착 틀에 닿았는데 다른 틀에서 답을 마친 연속 횟수. PATH_MAX_MISSES에 이르면 버린다.
  misses: number;
  lastUsed: number;
}

export interface PathHintStep {
  pattern: string;
  // origin + pattern을 그대로 열 수 있는 주소인지(자리표시·쿼리·해시 경로가 없음).
  direct: boolean;
}

export interface PathHint {
  steps: PathHintStep[];
  uses: number;
}

// 이 턴에 후보로 낸 경로(턴 기록기가 들고 있는다). reached는 원본 확정 주소의 틀이 to와 같아진 적이 있는지.
export interface OfferedPath {
  id: string;
  to: string;
  // 후보로 낸 남은 구간(지금 틀 뒤). 관찰한 경로가 이 경로의 끝부분과 같은지 볼 때 쓴다.
  steps: string[];
  reached: boolean;
}

export const PATH_MIN_STEPS = 2;
export const PATH_MAX_STEPS = 6;
// 원본 걸음(확정 주소 수)이 이보다 많으면 헛돈 것으로 보고 저장하지 않는다.
export const PATH_MAX_RAW = 40;
export const PATH_MAX_PATTERN_LEN = 120;
export const PATH_MAX_SEGMENTS = 8;
export const PATH_MAX_PER_ORIGIN = 8;
export const PATH_MAX_TOTAL = 200;
export const PATH_MAX_MISSES = 3;
export const PATH_MAX_HINTS = 3;
export const PATH_MAX_AGE_MS = ACTION_LOG_MAX_AGE_MS;
export const PATH_KEY_PREFIX = "path:";

// 접기: 직전과 같은 틀은 더하지 않고, 이미 지나온 틀로 돌아가면 그 자리까지 되감는다(A→B→A→C는 A→C).
export function foldPath(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    const at = out.indexOf(p);
    if (at >= 0) out.length = at + 1;
    else out.push(p);
  }
  return out;
}

// 틀 하나의 경로 칸 수(쿼리 제외, 해시 경로 포함).
function segmentCount(pattern: string): number {
  const [path, hash = ""] = pattern.split("#");
  const p = path.split("?")[0];
  return [...p.split("/"), ...hash.split("/")].filter(Boolean).length;
}

// 접은 경로를 저장할 수 있는지: 2~6걸음, 끝 틀이 출발 틀과 다르고, 틀마다 120자·경로 칸 8개 이하.
export function pathSavable(steps: readonly string[]): boolean {
  if (steps.length < PATH_MIN_STEPS || steps.length > PATH_MAX_STEPS) return false;
  if (steps[steps.length - 1] === steps[0]) return false;
  return steps.every((s) => s.startsWith("/") && s.length <= PATH_MAX_PATTERN_LEN && segmentCount(s) <= PATH_MAX_SEGMENTS);
}

// 틀이 그대로 열 수 있는 주소인지: 자리표시({n}·{id}·{k})·쿼리·해시 경로가 없다.
export function directPattern(pattern: string): boolean {
  return pattern.startsWith("/") && !/[{}?#]/.test(pattern);
}

export type PathRiskCode = "not_http" | "credentials" | "cross_origin" | "sensitive" | "destructive" | "bad_url";

// 원본 주소(확정 주소·리다이렉트 중간 주소) 하나의 제외 사유. 접기 전에 원본으로 본다. 낱말 신호는 덜 저장하는 쪽으로만 쓴다.
export function rawUrlRisk(url: string, startOrigin: string): PathRiskCode | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "bad_url";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "not_http";
  if (u.username || u.password) return "credentials";
  if (u.origin !== startOrigin) return "cross_origin";
  if (sensitiveUrlReason(url)) return "sensitive";
  if (destructiveRoute(url)) return "destructive";
  return null;
}

// 원본 확정 주소들을 틀로 바꿔 접는다. 틀을 만들 수 없는 주소가 있으면 null.
export function patternsOf(urls: readonly string[], origin: string): string[] | null {
  const out: string[] = [];
  for (const url of urls) {
    const p = urlPattern(url);
    if (!p || p.origin !== origin) return null;
    out.push(p.pattern);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 요청 ↔ 문서 확정의 일대일 대응(#297 v5·v6)
// ---------------------------------------------------------------------------

export interface CommitRecord {
  // webNavigation의 documentId(없을 수 있음).
  documentId?: string;
  // 해시를 뺀 확정 주소.
  url: string;
}

export interface ClosedRequest {
  requestId: string;
  // 해시를 뺀 최종 주소(리다이렉트 뒤).
  url: string;
}

export type MatchState = "ok" | "pending";

// 해시를 뺀 주소. 풀 수 없으면 그대로.
export function withoutHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

// 문서 확정마다 닫힌 요청 하나를 소비할 수 있는지(한 요청은 한 확정에만 쓴다). 요청 없이 통과하는 것은 이 턴에서 이미 요청
// 대응이 확인된 확정과 documentId가 같은 확정(뒤로·앞으로 캐시에서 같은 문서가 복원된 것)뿐이다. documentId가 없으면 면제하지 않는다.
// 열린 요청이 있거나, 대응이 안 되는 확정이 있거나, 소비되지 않고 남은 닫힌 요청이 있으면 "pending"(기다려 보고 제때 채워지지
// 않으면 저장하지 않는다).
export function matchRequests(commits: readonly CommitRecord[], closed: readonly ClosedRequest[], openCount: number): MatchState {
  if (openCount > 0) return "pending";
  const used = new Set<number>();
  const confirmedDocs = new Set<string>();
  for (const c of commits) {
    if (c.documentId && confirmedDocs.has(c.documentId)) continue;
    const i = closed.findIndex((r, k) => !used.has(k) && r.url === c.url);
    if (i < 0) return "pending";
    used.add(i);
    if (c.documentId) confirmedDocs.add(c.documentId);
  }
  return used.size === closed.length ? "ok" : "pending";
}

// ---------------------------------------------------------------------------
// 저장·쓴 횟수
// ---------------------------------------------------------------------------

function validPath(r: unknown): r is PathRecipe {
  if (!r || typeof r !== "object") return false;
  const p = r as PathRecipe;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    typeof p.origin === "string" &&
    Array.isArray(p.steps) &&
    p.steps.every((s) => typeof s === "string") &&
    pathSavable(p.steps) &&
    typeof p.uses === "number" &&
    typeof p.misses === "number" &&
    typeof p.lastUsed === "number"
  );
}

// 오래된 것·빗나감이 쌓인 것·깨진 것을 지우고, 출처마다 PATH_MAX_PER_ORIGIN개, 전체 PATH_MAX_TOTAL개까지 남긴다(최근에 쓴 것부터).
export function prunePaths(raw: unknown, now: number): PathRecipe[] {
  if (!Array.isArray(raw)) return [];
  const valid = raw.filter((r): r is PathRecipe => validPath(r) && now - r.lastUsed <= PATH_MAX_AGE_MS && r.misses < PATH_MAX_MISSES);
  valid.sort((a, b) => b.lastUsed - a.lastUsed);
  const perOrigin = new Map<string, number>();
  const kept: PathRecipe[] = [];
  for (const r of valid) {
    const n = perOrigin.get(r.origin) ?? 0;
    if (n >= PATH_MAX_PER_ORIGIN) continue;
    perOrigin.set(r.origin, n + 1);
    kept.push(r);
    if (kept.length >= PATH_MAX_TOTAL) break;
  }
  return kept;
}

const sameSteps = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s, i) => s === b[i]);
const endsWith = (whole: readonly string[], tail: readonly string[]) =>
  tail.length > 0 && tail.length <= whole.length && sameSteps(whole.slice(whole.length - tail.length), tail);

export interface PathOutcome {
  next: PathRecipe[];
  // 바뀌거나 새로 생긴 경로(저장 직전 비밀 값 검사 대상).
  touched: PathRecipe[];
  // 로그용 수.
  used: number;
  missed: number;
  created: boolean;
}

// 한 턴의 결과를 반영한다(턴이 제외되지 않았을 때만 부른다).
// - 후보로 냈고 도착 틀에 닿은 경로: 답을 마친 틀이 도착 틀이면 uses+1·misses=0, 아니면 misses+1(3번 연속이면 버림).
// - 관찰한 접힌 경로가 후보로 낸 닿은 경로의 끝부분과 같으면(중간 페이지에서 남은 구간을 따라감) 새로 만들지 않는다.
//   그 밖에는 origin+steps가 같은 경로가 있으면 uses+1·misses=0, 없으면 새로 만든다.
export function applyPath(
  recipes: readonly PathRecipe[],
  observed: { origin: string; steps: string[] } | null,
  offered: readonly OfferedPath[],
  finalPattern: string,
  now: number,
  newId: () => string,
): PathOutcome {
  const out = recipes.map((r) => ({ ...r, steps: [...r.steps] }));
  const touched = new Set<PathRecipe>();
  let used = 0;
  let missed = 0;
  let created = false;
  const counted = new Set<string>();
  for (const o of offered) {
    if (!o.reached || counted.has(o.id)) continue;
    counted.add(o.id);
    const r = out.find((x) => x.id === o.id);
    if (!r) continue;
    if (finalPattern === o.to) {
      r.uses++;
      r.misses = 0;
      r.lastUsed = now;
      used++;
    } else {
      r.misses++;
      missed++;
    }
    touched.add(r);
  }
  if (observed && pathSavable(observed.steps)) {
    const followed = offered.some((o) => {
      if (!o.reached) return false;
      const r = recipes.find((x) => x.id === o.id);
      return !!r && r.origin === observed.origin && endsWith(r.steps, observed.steps);
    });
    if (!followed) {
      const same = out.find((r) => r.origin === observed.origin && sameSteps(r.steps, observed.steps));
      if (same) {
        // 후보로 세어 둔 경로면 한 턴에 두 번 세지 않는다.
        if (!counted.has(same.id)) {
          same.uses++;
          same.misses = 0;
          same.lastUsed = now;
          used++;
        }
        touched.add(same);
      } else {
        const r: PathRecipe = { id: newId(), origin: observed.origin, steps: [...observed.steps], uses: 1, misses: 0, lastUsed: now };
        out.push(r);
        touched.add(r);
        created = true;
      }
    }
  }
  const next = prunePaths(out, now);
  return { next, touched: [...touched], used, missed, created };
}

// 이 페이지에 낼 후보: 같은 출처, 지금 틀이 steps 안에 있고 도착 틀이 아닌 경로. 지금 틀 뒤의 구간만, 많이 쓴 순 최대 3개.
// 같은 남은 구간은 한 번만 낸다.
export function pathHintsFor(
  recipes: readonly PathRecipe[],
  origin: string,
  pattern: string,
  now: number,
): Array<{ hint: PathHint; offered: OfferedPath }> {
  const seen = new Set<string>();
  const out: Array<{ hint: PathHint; offered: OfferedPath }> = [];
  const list = prunePaths([...recipes], now)
    .filter((r) => r.origin === origin)
    .sort((a, b) => b.uses - a.uses || b.lastUsed - a.lastUsed);
  for (const r of list) {
    const at = r.steps.indexOf(pattern);
    if (at < 0 || at >= r.steps.length - 1) continue;
    const rest = r.steps.slice(at + 1);
    const key = rest.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      hint: { steps: rest.map((p) => ({ pattern: p, direct: directPattern(p) })), uses: r.uses },
      offered: { id: r.id, to: r.steps[r.steps.length - 1], steps: rest, reached: false },
    });
    if (out.length >= PATH_MAX_HINTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 설정 화면(1단계 목록에 "이동 경로" 묶음)
// ---------------------------------------------------------------------------

export interface PathRow {
  key: string;
  steps: string[];
  uses: number;
  misses: number;
  lastUsed: number;
}

// 경로 하나를 가리키는 key. 출처를 담아 두어 지울 때 큐에 넣기 전에(저장소를 읽지 않고) 그 출처의 진행 중 턴을 제외할 수 있게 한다.
export function pathKey(r: Pick<PathRecipe, "origin" | "id">): string {
  return `${PATH_KEY_PREFIX}${r.origin} ${r.id}`;
}

// key에서 출처를 꺼낸다. 경로 key가 아니거나 출처가 http(s) 출처 그대로가 아니면 null.
export function pathKeyOrigin(key: string): string | null {
  if (!key.startsWith(PATH_KEY_PREFIX)) return null;
  const body = key.slice(PATH_KEY_PREFIX.length);
  const sp = body.lastIndexOf(" ");
  if (sp <= 0) return null;
  const origin = body.slice(0, sp);
  try {
    const u = new URL(origin);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== origin) return null;
  } catch {
    return null;
  }
  return origin;
}

export function removePathKeys(recipes: readonly PathRecipe[], keys: ReadonlySet<string>): PathRecipe[] {
  return recipes.filter((r) => !keys.has(pathKey(r)));
}

// 읽기 레시피 묶음에 경로를 더한다. 경로만 있는 출처도 묶음이 된다. 묶음 순서는 가장 최근에 쓴 항목 순(알 수 없는 사이트는 맨 뒤).
export function mergePathSites(sites: readonly RecipeSite[], paths: readonly PathRecipe[]): RecipeSite[] {
  const map = new Map<string, RecipeSite>();
  for (const s of sites) map.set(s.origin, { ...s, paths: [] });
  for (const r of [...paths].sort((a, b) => b.lastUsed - a.lastUsed)) {
    const site = map.get(r.origin) ?? { origin: r.origin, reads: [], paths: [] };
    site.paths = [...(site.paths ?? []), { key: pathKey(r), steps: [...r.steps], uses: r.uses, misses: r.misses, lastUsed: r.lastUsed }];
    map.set(r.origin, site);
  }
  const newest = (s: RecipeSite) => Math.max(s.reads[0]?.lastUsed ?? 0, s.paths?.[0]?.lastUsed ?? 0);
  return [...map.values()].sort((a, b) =>
    (a.origin === "") !== (b.origin === "") ? (a.origin === "" ? 1 : -1) : newest(b) - newest(a),
  );
}
