// 주소 기반 동작 제안(#173)의 규칙과 주소 비교. 규칙은 사용자가 명시적으로 만들고(출처·경로 패턴·제안 문구·보낼 요청),
// 비교는 주소의 구조(출처 일치·경로 세그먼트 패턴)로만 한다. 페이지 글자나 낱말로 뜻을 추론하지 않는다.

export interface SuggestionRule {
  id: string;
  // http(s) 출처(예: https://medium.com). 정확히 일치해야 한다.
  origin: string;
  // 경로 패턴: "/"로 나눈 세그먼트마다 글자 그대로 또는 "*"(세그먼트 하나), 끝의 "**"(나머지 전부, 없어도 됨).
  path: string;
  // 칩에 보일 제안 문구(예: 번역해 드릴까요?).
  label: string;
  // 실행을 누르면 보낼 요청.
  request: string;
  enabled: boolean;
  // 고칠 때마다 올린다(칩이 들고 있던 규칙과 지금 규칙이 같은지 확인).
  version: number;
  createdAt: number;
}

export const MAX_RULES = 30;
export const MAX_LABEL = 40;
export const MAX_REQUEST = 500;
export const MAX_PATH = 200;

// 출처를 정규화한다(http(s)만, 계정 정보 없음). 아니면 null.
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  return u.origin;
}

function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

// 글자 세그먼트를 주소(pathname)와 같은 꼴로 인코딩한다(한글 등 — "/뉴스" → "/%EB%89%B4%EC%8A%A4"). 이미 인코딩된 값은 그대로.
function encodeSegment(seg: string): string | null {
  try {
    const out = segments(new URL(`https://x.invalid/${seg}`).pathname);
    return out.length === 1 ? out[0] : null;
  } catch {
    return null;
  }
}

// 경로 패턴을 정규화한다: "/"로 시작, 빈 세그먼트 제거, "**"는 맨 끝에만, 글자 세그먼트는 주소와 같은 인코딩. 형식이 틀리면 null.
export function normalizePathPattern(raw: string): string | null {
  const p = raw.trim();
  if (!p.startsWith("/") || /[?#\s]/.test(p)) return null;
  const segs = segments(p);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === "**" && i !== segs.length - 1) return null;
    if (s === "*" || s === "**") {
      out.push(s);
      continue;
    }
    if (s.includes("*")) return null;
    const enc = encodeSegment(s);
    if (!enc) return null;
    out.push(enc);
  }
  const norm = "/" + out.join("/");
  return norm.length > MAX_PATH ? null : norm;
}

// 목록에 보일 때는 사람이 읽을 글자로. 풀 수 없으면 그대로.
export function displayPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

// 폼에 넣을 때: 풀어 쓴 글자를 다시 정규화해 같은 패턴이 될 때만 풀어 쓴다(공백·%2A처럼 풀면 뜻이 바뀌는 값은 그대로).
export function editablePath(path: string): string {
  const d = displayPath(path);
  return normalizePathPattern(d) === path ? d : path;
}

// 퍼센트 인코딩의 대소문자를 맞춘다(%eb → %EB).
function canonPercent(s: string): string {
  return s.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

// 경로(pathname)가 패턴과 맞는지. 세그먼트 비교는 퍼센트 인코딩된 그대로(대소문자만 맞춰) 한다.
export function matchPath(pattern: string, pathname: string): boolean {
  const pat = segments(canonPercent(pattern));
  const path = segments(canonPercent(pathname));
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === "**") return true;
    if (i >= path.length) return false;
    if (pat[i] !== "*" && pat[i] !== path[i]) return false;
  }
  return pat.length === path.length;
}

// 주소가 규칙과 맞는지(출처 일치 + 경로 패턴). 쿼리·해시는 보지 않는다.
export function matchesRule(rule: Pick<SuggestionRule, "origin" | "path">, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  return u.origin === rule.origin && matchPath(rule.path, u.pathname);
}

// 지금 주소로 만든 기본 패턴: 마지막 세그먼트를 "*"로(예: /@user/my-article → /@user/*). 경로가 없으면 "/".
export function defaultPattern(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "/";
  }
  const segs = segments(u.pathname);
  if (!segs.length) return "/";
  segs[segs.length - 1] = "*";
  const pattern = "/" + segs.join("/");
  const norm = normalizePathPattern(pattern);
  return norm ? editablePath(norm) : pattern;
}

function clean(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// 사용자가 보낸 규칙 입력을 검증한다. 틀리면 오류 문구를 던진다.
export function normalizeRuleInput(input: { origin?: unknown; path?: unknown; label?: unknown; request?: unknown }): {
  origin: string;
  path: string;
  label: string;
  request: string;
} {
  const origin = typeof input.origin === "string" ? normalizeOrigin(input.origin) : null;
  if (!origin) throw new Error("사이트 주소(http·https 출처)가 올바르지 않습니다.");
  const path = typeof input.path === "string" ? normalizePathPattern(input.path) : null;
  if (!path) throw new Error("경로 패턴이 올바르지 않습니다('/'로 시작, '*'는 세그먼트 전체, '**'는 맨 끝에만).");
  const request = typeof input.request === "string" ? input.request.trim() : "";
  if (!request) throw new Error("보낼 요청을 적어 주세요.");
  // 자르지 않는다(뒤쪽 조건이 빠진 요청이 저장·실행되지 않게).
  if (request.length > MAX_REQUEST) throw new Error(`보낼 요청은 ${MAX_REQUEST}자까지입니다. 줄여 주세요.`);
  const label = clean(input.label, MAX_LABEL) || clean(request, MAX_LABEL);
  return { origin, path, label, request };
}

// 저장소에서 읽은 값을 규칙 목록으로(틀린 항목은 버린다).
export function parseRules(raw: unknown): SuggestionRule[] {
  if (!Array.isArray(raw)) return [];
  const out: SuggestionRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    try {
      const n = normalizeRuleInput(o);
      if (typeof o.id !== "string" || !o.id) continue;
      out.push({
        id: o.id,
        ...n,
        enabled: o.enabled !== false,
        version: typeof o.version === "number" && Number.isInteger(o.version) ? o.version : 1,
        createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
      });
    } catch {
      /* skip */
    }
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

// 주소에 맞는 첫 켜진 규칙.
export function ruleFor(rules: readonly SuggestionRule[], url: string): SuggestionRule | null {
  return rules.find((r) => r.enabled && matchesRule(r, url)) ?? null;
}
