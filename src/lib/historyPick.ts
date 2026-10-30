// 방문 기록에서 기억할 페이지 고르기(#175)의 순수 함수: 후보 줄이기(구조 신호만)·보낼 스냅샷·모델 응답 읽기.
// 어떤 페이지가 다시 쓸 만한지(뜻)는 모델이 정하고, 코드는 방문 통계와 주소 형태로만 후보를 줄인다.
import { normalizeName, normalizePurpose, parseLinkDraft, splitUrl, type LinkDraft, type LinkTemplate } from "./savedPages.ts";

export interface HistoryEntry {
  url: string;
  title: string;
  // 크롬이 준 누적 통계(조회 기간 안의 횟수가 아님).
  visitCount: number;
  typedCount: number;
  lastVisitTime: number;
}

export interface HistoryGroup {
  // 묶음 대표: 가장 최근에 방문한 주소(저장 카드를 만들 원본 — 백그라운드에만 둔다).
  url: string;
  title: string;
  visits: number;
  typed: number;
  last: number;
  // 같은 형태에서 쿼리 값이 서로 다른 주소 수(값을 바꿔 가며 다시 쓴 흔적).
  distinct: number;
  score: number;
}

// 모델로 보내는 후보 하나. 쿼리 값과 방문 통계는 보내지 않는다.
export interface SnapshotItem {
  i: number;
  title: string;
  base: string;
  // p: 원본 주소의 쿼리 값 위치(앞 MAX_SNAPSHOT_PARAMS개). key는 표시·전송용으로 자른 이름이라 식별에 쓰지 않는다.
  params: Array<{ p: number; key: string }>;
}

export interface HistoryPick {
  i: number;
  name: string;
  purpose: string;
  reason: string;
  // 원본 주소의 쿼리 값 수에 맞춘 초안(스냅샷에 없던 위치는 고정).
  draft: LinkDraft;
}

export const HISTORY_DAYS = 30;
export const HISTORY_MAX_RESULTS = 3000;
export const MAX_CANDIDATES = 30;
export const MAX_PICKS = 8;
export const MAX_SNAPSHOT_TITLE = 80;
export const MAX_SNAPSHOT_BASE = 200;
export const MAX_SNAPSHOT_PARAMS = 10;
export const MAX_SNAPSHOT_KEY = 30;
export const MAX_REASON = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// 주소 형태: 출처 + 경로 + 쿼리 이름 모음(주소에 적힌 원본 이름, 중복 개수 포함, 정렬). 값·해시는 보지 않는다.
export function shapeOf(url: string): string | null {
  const parts = splitUrl(url);
  if (!parts) return null;
  const keys = parts.params.map((p) => (p.bare ? `${p.rawKey}!` : p.rawKey)).sort();
  return `${parts.base}?${keys.join("&")}`;
}

function queryOf(url: string): string {
  const parts = splitUrl(url);
  return parts ? parts.params.map((p) => `${p.rawKey}=${p.rawValue}`).join("&") : "";
}

// 같은 형태끼리 묶어 점수 순으로 MAX_CANDIDATES개. exclude가 true인 주소는 버린다(민감 단서·자동 로그인 값·저장한 링크 등).
// 점수: 방문(누적)·직접 입력(누적)·최근성·값을 바꿔 다시 쓴 흔적. 모두 방문 기록의 구조 신호다.
export function groupHistory(entries: readonly HistoryEntry[], now: number, exclude: (e: HistoryEntry) => boolean, limit = MAX_CANDIDATES): HistoryGroup[] {
  const groups = new Map<string, { best: HistoryEntry; visits: number; typed: number; last: number; queries: Set<string> }>();
  for (const e of entries) {
    const shape = shapeOf(e.url);
    if (!shape || exclude(e)) continue;
    const g = groups.get(shape);
    if (!g) {
      groups.set(shape, { best: e, visits: e.visitCount, typed: e.typedCount, last: e.lastVisitTime, queries: new Set([queryOf(e.url)]) });
      continue;
    }
    g.visits += e.visitCount;
    g.typed += e.typedCount;
    g.queries.add(queryOf(e.url));
    if (e.lastVisitTime > g.last) {
      g.last = e.lastVisitTime;
      g.best = e;
    }
  }
  const out: HistoryGroup[] = [];
  for (const g of groups.values()) {
    const age = Math.max(0, now - g.last);
    const recency = Math.max(0, 1 - age / (HISTORY_DAYS * DAY_MS));
    const distinct = g.queries.size;
    const score = Math.log1p(g.visits) + 2 * Math.log1p(g.typed) + recency + (distinct >= 2 ? 1 : 0);
    out.push({ url: g.best.url, title: g.best.title, visits: g.visits, typed: g.typed, last: g.last, distinct, score });
  }
  out.sort((a, b) => b.score - a.score || b.last - a.last);
  return out.slice(0, limit);
}

// 저장한 링크와 같은 형태인지(보수적으로 — 애매하면 false로 후보에 남긴다): 출처+경로·해시가 같고, 쿼리 이름 모음(중복 개수,
// "="이 없는 이름 구별 포함)이 템플릿과 같고, 템플릿의 고정 값이 그 주소에 같은 이름·값으로 있다.
export function matchesSavedTemplate(url: string, template: LinkTemplate): boolean {
  const parts = splitUrl(url);
  if (!parts || parts.base !== template.base || parts.hash !== template.hash) return false;
  const urlKeys = parts.params.map((p) => (p.bare ? `${p.rawKey}!` : p.rawKey)).sort();
  const tplKeys = template.params.map((p) => (p.bare ? `${p.key}!` : p.key)).sort();
  if (urlKeys.length !== tplKeys.length || urlKeys.some((k, i) => k !== tplKeys[i])) return false;
  const remaining = parts.params.map((p) => ({ ...p, used: false }));
  for (const tp of template.params) {
    if (tp.slot !== undefined) continue;
    const hit = remaining.find((p) => !p.used && p.rawKey === tp.key && p.bare === !!tp.bare && (tp.bare || p.rawValue === (tp.value ?? "")));
    if (!hit) return false;
    hit.used = true;
  }
  return true;
}

// 보낼 스냅샷(사용자가 확인 화면에서 그대로 본다).
export function makeSnapshot(groups: readonly HistoryGroup[]): SnapshotItem[] {
  return groups.map((g, i) => {
    const parts = splitUrl(g.url);
    return {
      i,
      title: g.title.replace(/\s+/g, " ").trim().slice(0, MAX_SNAPSHOT_TITLE),
      base: (parts?.base ?? "").slice(0, MAX_SNAPSHOT_BASE),
      params: (parts?.params ?? []).slice(0, MAX_SNAPSHOT_PARAMS).map((p, idx) => ({ p: idx, key: p.key.slice(0, MAX_SNAPSHOT_KEY) })),
    };
  });
}

// 모델 응답({"picks":[...]})을 읽는다. index는 실제로 보낸 항목(sent)에 있는 정수만, 중복 없이 MAX_PICKS개까지.
// params는 그 항목 스냅샷에 있던 위치(p)만 쓰고, 원본 주소의 쿼리 값 수(paramCount)에 맞춘 초안으로 만든다.
export function parsePicks(
  text: string,
  sent: ReadonlySet<number>,
  snapshot: readonly SnapshotItem[],
  paramCountOf: (i: number) => number,
): HistoryPick[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = raw && typeof raw === "object" && Array.isArray((raw as { picks?: unknown }).picks) ? ((raw as { picks: unknown[] }).picks) : null;
  if (!list) return null;
  const out: HistoryPick[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (out.length >= MAX_PICKS) break;
    if (!item || typeof item !== "object") continue;
    const r = item as { index?: unknown; name?: unknown; purpose?: unknown; reason?: unknown; params?: unknown };
    const i = r.index;
    if (typeof i !== "number" || !Number.isInteger(i) || !sent.has(i) || seen.has(i)) continue;
    const snap = snapshot[i];
    if (!snap) continue;
    seen.add(i);
    const allowed = new Set(snap.params.map((p) => p.p));
    const params = Array.isArray(r.params)
      ? r.params
          .filter((p): p is { p: number } => !!p && typeof p === "object" && typeof (p as { p?: unknown }).p === "number" && allowed.has((p as { p: number }).p))
          .map((p) => ({ ...(p as object), index: p.p }))
      : [];
    const draft =
      parseLinkDraft(
        JSON.stringify({ name: typeof r.name === "string" ? r.name : "", purpose: typeof r.purpose === "string" ? r.purpose : "", params }),
        paramCountOf(i),
        snap.title || snap.base,
        snap.params.map((p) => p.key),
      ) ?? null;
    if (!draft) continue;
    out.push({
      i,
      name: typeof r.name === "string" ? normalizeName(r.name) || draft.name : draft.name,
      purpose: typeof r.purpose === "string" ? normalizePurpose(r.purpose) : "",
      reason: typeof r.reason === "string" ? r.reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON) : "",
      draft,
    });
  }
  return out;
}
