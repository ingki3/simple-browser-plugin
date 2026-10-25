// 자동 실행의 사이트 경계(백그라운드 전용). 공개 접미사 목록(tldts)을 쓰므로 content script에서 import하지 않는다
// (content에서 쓰는 결제·개인정보 신호는 autoApprove.ts에 있다).
import { parse } from "tldts";
import { httpOrigin } from "./url.ts";
import {
  DESTRUCTIVE_REASON,
  decodeDeepText,
  destructiveRoute,
  expandUrls,
  looksPersonalValue,
  sensitiveUrlReason,
} from "./autoApprove.ts";

// 남에게 하위 도메인이나 경로를 나눠 주는 공유 호스팅(github.io, s3.amazonaws.com 등)의 주소는
// 같은 호스트라도 다른 사용자의 것일 수 있어 신뢰 범위로 보지 않는다(늘 묻는다).
const SHARED_HOSTING_APEXES = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "herokuapp.com", "appspot.com", "blogspot.com", "wordpress.com", "tistory.com", "glitch.me", "onrender.com",
  "azurewebsites.net", "cloudfront.net", "amazonaws.com", "notion.site", "substack.com", "medium.com",
  // 사용자마다 자기 웹앱·양식·파일을 올리는 서비스(남의 배포 주소로 대화 내용을 보낼 수 있다).
  "script.google.com", "script.googleusercontent.com", "docs.google.com", "sites.google.com",
  "storage.googleapis.com", "googleusercontent.com", "forms.gle", "forms.office.com", "blob.core.windows.net",
  "githubusercontent.com", "gist.github.com", "pastebin.com", "dropboxusercontent.com", "firebaseio.com",
  "repl.co", "replit.app", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "surge.sh", "fly.dev", "deno.dev",
  "webhook.site", "pipedream.net",
]);

// 호스트 비교용 정규화: 소문자, 끝의 점 제거(script.google.com. → script.google.com). 공유 호스팅 검사와
// 등록 도메인 계산(tldts는 끝의 점을 지우고 계산한다)이 같은 호스트를 보게 한다.
function normHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "");
}

function isSharedHost(host: string): boolean {
  const h = normHost(host);
  for (const apex of SHARED_HOSTING_APEXES) if (h === apex || h.endsWith(`.${apex}`)) return true;
  return false;
}

// 신뢰 사이트로 기억할 값(웹 주소의 출처). 웹 주소가 아니면 null.
export function siteOf(url: string): string | null {
  return httpOrigin(url);
}


// 공개 접미사 목록(PSL, private 영역 포함)에 근거해 확인된 등록 도메인. 확인되지 않으면 null
// (알 수 없는 접미사·localhost·단일 레이블·IP·접미사 그 자체).
function registrableDomain(host: string): string | null {
  const r = parse(host, { allowPrivateDomains: true });
  if (r.isIp || !r.domain || !(r.isIcann || r.isPrivate)) return null;
  return r.domain;
}

// 호스트가 그 자체로 공개 접미사인지(co.kr, github.io). 하위 도메인 신뢰의 근거가 될 수 없다.
function isPublicSuffix(host: string): boolean {
  const r = parse(host, { allowPrivateDomains: true });
  return !r.isIp && !!r.publicSuffix && r.publicSuffix === host && !!(r.isIcann || r.isPrivate);
}

function isIpHost(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.startsWith("[");
}

// 자동 실행의 신뢰 경계. 신뢰 사이트는 출처(스킴·호스트·포트)로 기억하고, 대상 주소는 브라우저의 "같은 사이트"처럼
// 등록 도메인이 같으면 안으로 본다(www.naver.com → shopping.naver.com). 등록 도메인은 공개 접미사 목록으로
// 확인된 것만 쓰고(co.kr 아래 남의 사이트를 묶지 않음, a.github.io와 b.github.io는 다름), 확인되지 않으면
// 같은 호스트와 그 하위 도메인만 안이다. 공유 호스팅·접미사 자체·IP·단일 레이블인 신뢰 원본은 같은 호스트만 안이다
// (script.google.com에서 시작한 턴이 www.google.com을 신뢰하지 않게).
function hostTrusted(trustedSites: ReadonlySet<string>, u: URL): boolean {
  if (!/^https?:$/.test(u.protocol) || isSharedHost(u.hostname)) return false;
  const uh = normHost(u.hostname);
  for (const site of trustedSites) {
    let t: URL;
    try {
      t = new URL(site);
    } catch {
      continue;
    }
    if (t.protocol !== u.protocol || t.port !== u.port) continue;
    const th = normHost(t.hostname);
    if (uh === th) return true;
    if (isSharedHost(th) || isIpHost(th) || !th.includes(".") || isPublicSuffix(th)) continue;
    const td = registrableDomain(th);
    const ud = registrableDomain(uh);
    if (td && ud) {
      if (td === ud) return true;
      continue;
    }
    // 확인된 등록 도메인이 없으면(알 수 없는 접미사) 예전처럼 하위 도메인만 안이다.
    if (uh.endsWith(`.${th}`)) return true;
  }
  return false;
}

// 주소(와 감싼 주소 모두)가 신뢰 사이트 안인지. 웹 주소가 아니면 null.
function withinTrusted(trustedSites: ReadonlySet<string>, url: string): boolean | null {
  const { urls, overflow } = expandUrls(url);
  if (!urls.length || !/^https?:$/.test(urls[0].protocol)) return null;
  if (overflow) return false;
  return urls.every((u) => hostTrusted(trustedSites, u));
}

// url이 base 페이지와 같은 사이트(자동 실행의 신뢰 경계와 같은 기준)인지. 둘 중 하나라도 웹 주소가 아니면 false.
// 팝업 창이 클릭한 페이지와 다른 사이트인지 알리는 데 쓴다(실제 승인 판정은 pageActionSiteBlock이 지금 창 주소로 한다).
export function sameSiteAs(baseUrl: string, url: string): boolean {
  const site = siteOf(baseUrl);
  if (!site) return false;
  return withinTrusted(new Set([site]), url) === true;
}

// 이동은 모델이 만든 주소라 대화 내용(개인정보)을 주소·호스트 이름에 실어 밖으로 보낼 수 있다.
// 사용자가 고른 사이트(요청을 시작한 탭의 사이트, 승인 카드로 이동을 허락한 사이트) 안에서만 자동 실행한다.
// 자동 이동·클릭으로 들어간 사이트는 신뢰 사이트가 되지 않는다(두 단계로 나눠 보내는 우회를 막음).
export function navigateAutoBlock(trustedSites: ReadonlySet<string>, targetUrl: string): string | null {
  const inside = withinTrusted(trustedSites, targetUrl);
  if (inside === null) return "웹 주소가 아님";
  if (!inside) return "요청을 시작한 사이트 밖으로 이동";
  return navigateUrlReason(targetUrl);
}

// 아무것도 하지 않는 javascript: 링크. 스킴만 대소문자를 가리지 않고, 식은 그대로 본다
// (javascript:VOID(0)은 페이지가 정의한 VOID 함수를 부른다). void 0 / void(0) / ; / 빈 식만.
const INERT_HREF_RE = {
  test(href: string): boolean {
    if (!/^javascript:/i.test(href)) return false;
    return /^\s*(void(\s+0|\s*\(\s*0\s*\))\s*;?|;|)\s*$/.test(href.slice("javascript:".length));
  },
};

// 클릭·입력: 사용자가 고르지 않은 사이트의 페이지에서는(자동 클릭으로 들어간 수집 페이지의 검색 칸 등) 묻는다.
// 다른 사이트로 가는 링크 클릭과 다른 사이트로 제출하는 양식 버튼도 이동과 같게 본다.
// values: 입력할 값들. 상대 경로(/redirect?next=https://…)나 글 속 주소가 양식 제출·이동에 실릴 수 있어
// 지금 페이지 주소의 매개변수로 넣어 본 것처럼 같은 방식(내장 주소 풀기)으로 검사한다.
export function pageActionSiteBlock(
  trustedSites: ReadonlySet<string>,
  pageUrl: string | undefined,
  linkHrefs: string[],
  values: string[] = [],
): string | null {
  if (!pageUrl || withinTrusted(trustedSites, pageUrl) !== true) return "요청을 시작한 사이트 밖의 페이지";
  for (const v of values) {
    // 개인정보 모양의 값(이메일·전화·카드 번호)을 넣는 것은 칸 이름과 관계없이 묻는다.
    if (looksPersonalValue(decodeDeepText(v))) return "개인정보 모양의 값 입력";
    let probe: URL;
    try {
      probe = new URL(pageUrl);
    } catch {
      return "요청을 시작한 사이트 밖의 페이지";
    }
    probe.search = "";
    probe.hash = "";
    probe.searchParams.set("v", v);
    if (withinTrusted(trustedSites, probe.href) !== true) return "입력 값에 사이트 밖 주소";
    // 입력 값에 실린 결제·개인정보 주소(/checkout/confirm, /continue?email=…)도 이동과 같게 본다.
    const why = sensitiveUrlReason(probe.href);
    if (why) return `입력 값에 ${why}`;
  }
  for (const raw of linkHrefs) {
    let href = raw;
    try {
      href = new URL(raw, pageUrl).href;
    } catch {
      /* 그대로 */
    }
    // 아무 데도 가지 않는 자리표시 링크(javascript:void(0) 등)는 일반 버튼과 같게 본다.
    if (INERT_HREF_RE.test(raw) || INERT_HREF_RE.test(href)) continue;
    // 웹 주소가 아니어서(javascript:…, data:, mailto:) 목적지를 확인할 수 없으면 묻는다.
    if (withinTrusted(trustedSites, href) !== true) return "요청을 시작한 사이트 밖으로 가는 링크·양식 제출";
  }
  return null;
}

// 주소(와 감싼 주소 모두)가 이 출처의 같은 사이트 안인지(read_linked_pages 카드의 "다른 사이트" 표시용).
export function withinSite(site: string, url: string): boolean {
  return withinTrusted(new Set([site]), url) === true;
}

// 브라우저 내부 페이지(새 탭·설정·빈 페이지 등). content script를 넣을 수 없어 페이지를 읽거나 조작할 수 없다.
export function isBrowserInternalUrl(url: string | undefined): boolean {
  return !!url && /^(chrome|edge|about|chrome-search|chrome-untrusted|devtools):/i.test(url);
}

// 사용자 요청 글에 적힌 웹 주소·도메인의 출처(#54). 낱말 뜻이 아니라 주소·호스트 모양으로만 뽑는다:
// http(s) 주소는 그 출처(http면 https 출처도), 맨 도메인은 공개 접미사 목록으로 등록 도메인이 확인될 때 https 출처.
// 글을 공백으로만 나눈 덩어리 하나를 주소 하나로 본다(덩어리 안을 다시 쪼개지 않는다 — 경로·매개변수 속 주소를
// 따로 뽑지 않게). 앞뒤의 ASCII 괄호·따옴표·문장부호만 걷어 내고, 호스트 글자는 지우거나 자르지 않은 채 URL 파서가
// 정규화한 결과를 쓴다(전각 문자·국제화 도메인도 브라우저와 같게). 그대로 주소가 되지 않는 덩어리("naver.com으로"처럼
// 조사가 붙은 것 포함)는 사이트로 보지 않는다 — 모호한 주소는 승인 카드로 묻는다. 이메일(@)·값 모양(=)·IP는 뽑지 않는다.
const SCHEME_RE = /^https?:\/\//i;
const MAX_NAMED_SITES = 10;
const OPENERS = new Set([..."(<[{\"'`"]);
const CLOSERS = new Set([...")>]}\"'`.,!?;:"]);

function trimWrappers(piece: string): string {
  let start = 0;
  let end = piece.length;
  while (start < end && OPENERS.has(piece[start])) start += 1;
  while (end > start && CLOSERS.has(piece[end - 1])) end -= 1;
  return piece.slice(start, end);
}

export function userNamedSites(text: string): string[] {
  const out = new Set<string>();
  const add = (origin: string) => {
    if (out.size < MAX_NAMED_SITES) out.add(origin);
  };
  const accept = (u: URL): boolean => {
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return false;
    const host = normHost(u.hostname);
    return !isIpHost(host) && registrableDomain(host) !== null;
  };
  // 덩어리 하나를 주소로 읽는다. 읽었으면 그 출처들, 아니면 null.
  const read = (token: string): string[] | null => {
    try {
      if (SCHEME_RE.test(token)) {
        const u = new URL(token);
        if (u.username || u.password || !accept(u)) return null;
        return u.protocol === "http:" ? [u.origin, `https://${u.host}`] : [u.origin];
      }
      // 맨 도메인: 첫 '/'·'?'·'#' 앞이 호스트(와 포트)여야 한다. 계정 정보·값 모양(@·=)이면 보지 않는다.
      const hostPart = token.split(/[/?#]/, 1)[0];
      if (!hostPart || /[@=]/.test(hostPart)) return null;
      const u = new URL(`https://${hostPart}`);
      if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || !accept(u)) return null;
      return [u.origin];
    } catch {
      return null;
    }
  };
  for (const piece of text.split(/\s+/)) {
    const token = trimWrappers(piece);
    if (!token) continue;
    for (const o of read(token) ?? []) add(o);
  }
  return [...out];
}

// 내부 페이지(새 탭·설정)에서 시작한 이동의 자동 실행 경계(#54). 내부 페이지에는 페이지 글이 없어 숨긴 지시문이
// 끼어들 수 없지만, 모델이 만든 주소로 대화 내용이 나갈 수 있어 사용자가 이번 요청 글에 적은 사이트(등록 도메인이
// 같음)나 이 대화에서 승인 카드로 허락한 사이트 안에서만 자동 실행한다.
export function internalNavigateAutoBlock(
  approvedSites: Iterable<string>,
  namedSites: Iterable<string>,
  targetUrl: string,
): string | null {
  const inside = withinTrusted(new Set([...approvedSites, ...namedSites]), targetUrl);
  if (inside === null) return "웹 주소가 아님";
  if (!inside) return "요청 글에 적지 않은 사이트로 이동";
  return navigateUrlReason(targetUrl);
}

// 신뢰 사이트 안의 이동이어도 묻는 주소: 결제·개인정보 신호, 삭제·스팸 경로(#62 — 더 묻는 쪽으로만).
function navigateUrlReason(targetUrl: string): string | null {
  return sensitiveUrlReason(targetUrl) ?? (destructiveRoute(targetUrl) ? DESTRUCTIVE_REASON : null);
}
