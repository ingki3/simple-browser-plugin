// 동작 기록(B단계): 어느 페이지에서 무엇을 누르거나 채웠고 결과가 어땠는지를 이 브라우저에만 남긴다.
// 나중에 레시피(같은 구조의 페이지에서 동작 재생)의 재료가 된다. 입력 값은 남기지 않는다.
// 여기에는 DOM·chrome API 없이 계산하는 부분만 둔다. 저장은 src/background/actionLog.ts.

import type { PageRegion } from "./messages";
import type { ClickEffect, NavKind, TargetInfo } from "./actionTarget";

// ---------------------------------------------------------------------------
// 페이지 구분 키
// ---------------------------------------------------------------------------

// 같은 구조의 페이지를 하나로 묶는 키. 글 번호·검색어처럼 내용만 다른 페이지는 같은 키가 된다.
export interface PageKey {
  origin: string;
  // 경로의 숫자·긴 식별자를 자리표시로 바꾸고, 쿼리는 이름만 남긴 주소 틀. 예: /board/{n}/view?id&page
  pattern: string;
  // 페이지 뼈대(랜드마크·목록·표·폼의 중첩)의 해시. 같은 주소 틀에서도 화면 구성이 다르면 갈린다.
  skeleton: string;
}

const NUMERIC = /^\d+$/;
// 그대로 남겨도 되는 경로 낱말: 영문·숫자·- _ . ~ 만, 32자 이하.
const PLAIN = /^[A-Za-z0-9._~-]{1,32}$/;

// 경로 한 칸을 정규화한다. 기록이 개인정보 저장소가 되지 않도록, 흔한 정적 경로 낱말처럼 보이는 것만 남기고
// 나머지(이메일·한글 이름·토큰·해시·UUID 등)는 자리표시로 바꾼다.
export function normalizeSegment(seg: string): string {
  let s: string;
  try {
    s = decodeURIComponent(seg);
  } catch {
    s = seg;
  }
  if (NUMERIC.test(s)) return "{n}";
  if (!PLAIN.test(s)) return "{id}";
  const letters = s.replace(/[^A-Za-z]/g, "");
  const digits = s.replace(/\D/g, "").length;
  const hasSeparator = /[._~-]/.test(s);
  // 구분자 없는 긴 낱말(토큰), 숫자가 많이 섞인 낱말(해시), 대소문자가 뒤섞인 낱말(base64)은 식별자로 본다.
  if (!hasSeparator && s.length >= 16) return "{id}";
  if (digits >= 4 && letters.length >= 4 && !/^[A-Za-z_-]+[._-]?\d+(\.[A-Za-z0-9]+)?$/.test(s)) return "{id}";
  const mixedCase = /[a-z]/.test(s) && /[A-Z]/.test(s);
  if (!hasSeparator && mixedCase && (s.length >= 12 || (digits > 0 && s.length >= 6))) return "{id}";
  // 숫자 꼬리가 붙은 파일·글 이름(post-123, item_45.html)은 숫자만 자리표시로 바꾼다.
  return s.replace(/\d{2,}/g, "{n}");
}

// 쿼리 이름도 같은 기준으로(이름 자리에 값을 넣는 사이트가 있다).
function normalizeQueryKey(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,31}$/.test(k) ? k : "{k}";
}

function normalizePath(path: string): string {
  const segs = path.split("/").map((s) => (s ? normalizeSegment(s) : s));
  return segs.join("/") || "/";
}

// 주소 틀. http(s)가 아니면 null(기록하지 않는다).
export function urlPattern(url: string): { origin: string; pattern: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  let pattern = normalizePath(u.pathname);
  const keys = Array.from(new Set(Array.from(u.searchParams.keys()))).sort();
  const shownKeys = Array.from(new Set(keys.map(normalizeQueryKey)));
  if (shownKeys.length) pattern += "?" + shownKeys.join("&");
  // 해시 라우터(#/path, #!/path)는 경로로 본다. 그 밖의 #는 페이지 안 위치라 버린다.
  const hashRoute = /^#!?(\/[^?]*)/.exec(u.hash);
  if (hashRoute) pattern += "#" + normalizePath(hashRoute[1]);
  return { origin: u.origin, pattern: pattern.slice(0, 300) };
}

// FNV-1a 32비트. 뼈대 서명을 짧은 키로 줄이는 데만 쓴다(보안 용도 아님).
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// 같은 서명의 형제가 이어지면 하나로 접는다. 항목이 하나뿐인 목록과 여럿인 목록도 같은 뼈대가 되도록
// 반복 표시는 남기지 않는다.
export function collapseRepeats(children: string[]): string[] {
  const out: string[] = [];
  for (const c of children) {
    if (out[out.length - 1] !== c) out.push(c);
  }
  return out;
}

export function pageKeyId(k: PageKey): string {
  return `${k.origin}${k.pattern}@${k.skeleton}`;
}

// ---------------------------------------------------------------------------
// 기록 항목
// ---------------------------------------------------------------------------

// 대상 요약. 행 글자(context)와 입력 값은 남기지 않는다. 링크 주소는 주소 틀만 남긴다.
export interface LoggedTarget {
  tag: string;
  role: string;
  name: string;
  region: PageRegion;
  inFrame: boolean;
  fieldType: string;
  sensitive: "password" | "payment" | null;
  hrefPattern: string;
  list: { index: number; count: number } | null;
  // 입력 칸에 넣으려던 값이 비어 있지 않았는지(값 자체는 남기지 않음). 클릭 대상은 없음.
  hasValue?: boolean;
}

export type ActionOutcome =
  // 실행했고 결과를 확인함
  | "done"
  // 입력 칸 일부만 반영됨
  | "partial"
  // 실행 직전 확인에서 대상이 바뀌어 멈춤
  | "aborted"
  // 실행 중 오류 또는 반영 안 됨
  | "failed"
  // 사용자가 승인 카드에서 취소함
  | "cancelled";

export interface ActionLogEntry {
  id: string;
  at: number;
  tool: "click_element" | "fill_form_fields";
  page: PageKey | null;
  targets: LoggedTarget[];
  outcome: ActionOutcome;
  // 클릭 결과 요약.
  effect?: {
    navigation: NavKind;
    sameDocument: boolean | null;
    newTab: boolean;
    dialogOpened: boolean;
    domChanged: boolean;
    frameNavigated: boolean;
    // 이동했으면 도착한 주소 틀.
    toPattern?: string;
  };
  // 입력 결과 요약.
  fill?: { applied: number; total: number };
  // 실패·중단 이유. 오류 문구에는 페이지 글자(입력 처리기가 바꾼 칸 이름 등)가 섞일 수 있어 분류만 남긴다.
  reason?: ReasonCode;
}

export const ACTION_LOG_MAX_ENTRIES = 500;
export const ACTION_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function clipText(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

// 대상 이름에 섞인 주소·이메일·key=value·긴 숫자를 가린다(링크 글자가 주소 그대로인 경우 등).
export function maskName(s: string): string {
  return s
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "{url}")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "{email}")
    .replace(/\S+=\S+/g, "{kv}")
    .replace(/\d[\d\s-]{5,}\d/g, "{n}");
}

export function logTarget(info: TargetInfo, value?: string): LoggedTarget {
  const href = info.href ? urlPattern(info.href) : null;
  const t: LoggedTarget = {
    tag: info.tag,
    role: info.role,
    name: clipText(maskName(info.name), 80),
    region: info.region,
    inFrame: info.inFrame,
    fieldType: info.fieldType,
    sensitive: info.sensitive,
    hrefPattern: href ? href.origin + href.pattern : "",
    list: info.list ? { index: info.list.index, count: info.list.count } : null,
  };
  if (value !== undefined) t.hasValue = value.length > 0;
  return t;
}

export function summarizeClickEffect(e: ClickEffect): NonNullable<ActionLogEntry["effect"]> {
  const out: NonNullable<ActionLogEntry["effect"]> = {
    navigation: e.navigation,
    sameDocument: e.sameDocument,
    newTab: e.newTab,
    dialogOpened: !!e.dom?.dialogOpened,
    domChanged: (e.dom?.mutations ?? 0) > 0,
    frameNavigated: !!e.dom?.frameNavigated,
  };
  if (e.navigation === "same_origin" || e.navigation === "cross_origin") {
    const p = urlPattern(e.url);
    if (p) out.toPattern = p.origin + p.pattern;
  }
  return out;
}

export type ReasonCode =
  // 승인한 대상이 바뀌거나 사라져 실행하지 않음
  | "target_changed"
  // 대상이 화면에 보이지 않아 실행하지 않음
  | "not_visible"
  // 이 호출에서 승인하지 않은 대상
  | "not_approved"
  // 입력 뒤 칸이 다시 그려지거나 바뀌어 반영 여부를 확인하지 못함
  | "unverified"
  // 페이지가 값을 받아들이지 않음(서식·선택지 없음)
  | "value_rejected"
  // 탭이 닫히거나 페이지가 바뀌어 대상에 닿지 못함
  | "page_gone"
  | "error";

// 오류·메모 문구를 값 없는 분류로 바꾼다. 문구는 src/content/targets.ts·forms.ts·dispatcher가 만든다.
export function reasonCode(message: string): ReasonCode {
  if (/확인하지 못했/.test(message)) return "unverified";
  if (/보이지 않/.test(message)) return "not_visible";
  if (/승인되지 않았/.test(message)) return "not_approved";
  if (/받아들이지 않았|선택지가 없/.test(message)) return "value_rejected";
  if (/다시 그려지거나 사라졌|바뀌어 (실행|클릭)하지 않았|다시 찾으세요/.test(message)) return "target_changed";
  if (/탭이 닫혀|페이지가 바뀌었|주입할 수 없|응답이 .*오지 않았/.test(message)) return "page_gone";
  return "error";
}

// 실행하기 전에 멈춘 이유인지(페이지를 건드리지 않음).
export function isPreActionStop(code: ReasonCode): boolean {
  return code === "target_changed" || code === "not_visible";
}

// 30일 지난 항목을 지우고 최근 500개만 남긴다. 저장된 값이 깨져 있으면 버린다.
export function pruneLog(entries: unknown, now: number): ActionLogEntry[] {
  if (!Array.isArray(entries)) return [];
  const fresh = entries.filter(
    (e): e is ActionLogEntry =>
      !!e && typeof e === "object" && typeof (e as ActionLogEntry).at === "number" &&
      now - (e as ActionLogEntry).at <= ACTION_LOG_MAX_AGE_MS,
  );
  return fresh.slice(-ACTION_LOG_MAX_ENTRIES);
}
