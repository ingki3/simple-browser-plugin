// read_linked_pages의 리다이렉트 판단(백그라운드 전용, 순수 함수). siteTrust.ts가 공개 접미사 목록(tldts)을 쓰므로
// content script에서 import하지 않는다. 판단은 주소의 구조(스킴·계정 정보·등록 도메인·이미 거친 주소)와 기존의
// 결제·개인정보 주소 신호(더 묻는 쪽)로만 한다.
import { sensitiveUrlReason } from "./autoApprove.ts";
import { siteOf, withinSite } from "./siteTrust.ts";

// 같은 사이트 안 리다이렉트를 따라가는 최대 횟수(원래 링크 요청은 세지 않는다).
export const MAX_LINK_REDIRECTS = 3;
// 한 턴에 기억하는 "페이지 링크의 리다이렉트 목적지" 수.
export const MAX_REMEMBERED_REDIRECTS = 16;

// 구조적으로 읽지 않는 주소: http(s)가 아니거나 계정 정보가 실린 주소.
export function structuralReject(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "주소가 아님";
  }
  if (!/^https?:$/.test(u.protocol)) return "웹 주소가 아님";
  if (u.username || u.password) return "계정 정보가 실린 주소";
  return null;
}

// 요청·비교용 주소: 해시는 서버로 가지 않으므로 뺀다. 주소가 아니면 null.
export function requestUrl(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

// 리다이렉트 목적지가 원래 링크와 같은 사이트(등록 도메인) 안인지. http → https 승격은 같은 사이트로 본다
// (반대 방향 http로 내려가는 것은 다른 사이트). 감싼 주소(/out?url=https://…)가 밖을 가리키면 다른 사이트다.
export function sameSiteRedirect(fromUrl: string, toUrl: string): boolean {
  const site = siteOf(fromUrl);
  if (!site) return false;
  if (withinSite(site, toUrl)) return true;
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    if (from.protocol !== "http:" || to.protocol !== "https:") return false;
    from.protocol = "https:";
    // 기본 포트(80)는 https 기본 포트로 바꿔 본다. 다른 포트는 그대로(같은 포트끼리만 같은 사이트).
    if (from.port === "80") from.port = "";
    return withinSite(from.origin, toUrl);
  } catch {
    return false;
  }
}

export type RedirectStop = "invalid" | "structural" | "loop" | "too_many" | "downgrade" | "sensitive" | "cross_site";

export type RedirectStep =
  | { kind: "follow"; url: string }
  | { kind: "stop"; reason: RedirectStop; url: string; detail?: string };

// 리다이렉트 응답의 목적지(location, 절대 주소)를 따라갈지 정한다.
// origin: 사용자가 카드에서 고른 원래 링크. visited: 지금까지 요청한 주소(원래 링크 포함, requestUrl 기준).
export function nextRedirectStep(
  origin: string,
  location: string,
  visited: readonly string[],
  maxHops = MAX_LINK_REDIRECTS,
): RedirectStep {
  const target = requestUrl(location);
  if (!target) return { kind: "stop", reason: "invalid", url: location };
  const structural = structuralReject(location);
  if (structural) return { kind: "stop", reason: "structural", url: location, detail: structural };
  if (visited.includes(target)) return { kind: "stop", reason: "loop", url: location };
  if (visited.length - 1 >= maxHops) return { kind: "stop", reason: "too_many", url: location };
  // 직전 요청이 https였으면 http로 내려가는 목적지는 따라가지 않는다(평문 요청을 만들지 않음).
  const previous = visited[visited.length - 1];
  if (previous && new URL(previous).protocol === "https:" && new URL(target).protocol === "http:") {
    return { kind: "stop", reason: "downgrade", url: location };
  }
  // 결제·개인정보 신호는 더 묻는 쪽으로만 쓴다: 걸리면 따라가지 않고 목적지를 알린다.
  const sensitive = sensitiveUrlReason(location);
  if (sensitive) return { kind: "stop", reason: "sensitive", url: location, detail: sensitive };
  if (!sameSiteRedirect(origin, location)) return { kind: "stop", reason: "cross_site", url: location };
  return { kind: "follow", url: target };
}

// 한 턴·한 탭 동안 기억하는 "페이지 링크가 리다이렉트한 다른 사이트 목적지". 목적지 → 페이지에 있던 원래 링크.
// 상한을 넘으면 오래된 것부터 버린다.
export class RedirectMemory {
  private readonly map = new Map<string, string>();
  private readonly limit: number;
  constructor(limit = MAX_REMEMBERED_REDIRECTS) {
    this.limit = limit;
  }

  remember(destination: string, pageLink: string): void {
    const key = requestUrl(destination);
    if (!key || structuralReject(destination)) return;
    this.map.delete(key);
    this.map.set(key, pageLink);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  // 이 주소가 기억한 목적지면 원래 페이지 링크, 아니면 null. 해시는 빼고 요청 주소로 비교한다.
  pageLinkFor(url: string): string | null {
    const key = requestUrl(url);
    return key ? (this.map.get(key) ?? null) : null;
  }

  get size(): number {
    return this.map.size;
  }
}

// 쿠키 없이 받는 요청을 사이트가 막은 것으로 보이는 응답 상태(로그인 필요·접근 거부·요청 제한).
export function blockedWithoutCookies(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}
