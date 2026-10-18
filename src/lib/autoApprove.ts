// 자동 실행(승인 없이 진행) 옵션의 예외 판정. 자동 실행을 켜도 결제와 개인정보 제출은 승인 카드를 띄운다.
// 여기에는 DOM 없이 계산하는 부분만 둔다. 칸·버튼의 성격(개인정보 칸인지, 개인정보가 든 양식을 제출하는지)은
// content script가 대상 확인 때 TargetInfo에 담아 준다(src/content/forms.ts, src/content/clickables.ts).

import type { TargetInfo } from "./actionTarget.ts";

// 자동 실행 대상: 페이지 이동·클릭·입력.
// 이미지 저장(모델이 고른 주소로 요청)·파일 읽기(쿠키를 실어 요청)·Google 문서 쓰기는 자동 실행을 켜도 늘 묻는다.
export const AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "navigate_to_url",
  "click_element",
  "fill_form_fields",
]);

// 돈이 나가는 버튼: 결제·구매·주문·송금 등.
export const PAYMENT_TEXT_RE =
  /(결제|구매|구입|주문|송금|이체|충전|후원|기부|입금|\bpay\b|payment|checkout|check\s*out|\bbuy\b|purchase|place\s*order|order\s*now|donate)/i;
// 개인정보를 내보내는 버튼: 가입·신청·제출·인증 등.
const SUBMIT_TEXT_RE =
  /(가입|신청|제출|접수|본인\s*인증|인증\s*(번호|요청|하기)|예약\s*하기|문의\s*(하기|등록)|sign\s*up|register|submit|verify)/i;

// 자동 실행하면 안 되는 이유. 없으면 null(자동 실행 가능).
export function autoApproveBlock(tool: string, targets: TargetInfo[]): string | null {
  if (!AUTO_APPROVE_TOOLS.has(tool)) return "자동 실행 대상이 아닌 도구";
  if (tool === "fill_form_fields") {
    for (const t of targets) {
      if (t.sensitive === "password") return "비밀번호 칸 입력";
      if (t.sensitive === "payment") return "결제 정보 칸 입력";
      if (t.personal) return `개인정보 칸 입력('${t.name.slice(0, 30) || t.fieldType}')`;
      // 입력의 change 처리기가 양식을 바로 제출하는 페이지가 있어, 개인정보가 채워진 양식의 칸도 묻는다.
      if (t.submitsPersonal) return "개인정보가 채워진 양식의 칸 입력";
    }
    return null;
  }
  if (tool === "click_element") {
    for (const t of targets) {
      // 실제로 작동하는 바깥 버튼·링크의 글자도 본다(<button>구매 <span>확인</span></button>의 span).
      const text = `${t.name} ${t.outerText ?? ""}`;
      if (PAYMENT_TEXT_RE.test(text)) return "결제·주문 버튼";
      if (t.paymentContext) return "결제 화면의 버튼";
      if (t.submitsPersonal) return "개인정보가 채워진 양식 제출";
      if (SUBMIT_TEXT_RE.test(text)) return "가입·신청·제출 버튼";
    }
    return null;
  }
  return null;
}

// 자동 실행의 신뢰 경계. 신뢰 사이트는 출처(스킴·호스트·포트)로 기억하고, 대상 주소는
// 같은 출처이거나 그 호스트의 하위 도메인(news.naver.com → n.news.naver.com)일 때만 안으로 본다.
// 등록 도메인을 추정하지 않는다(co.za·s3.amazonaws.com처럼 형제 하위 도메인이 남의 것일 수 있다).
// 남에게 하위 도메인이나 경로를 나눠 주는 공유 호스팅(github.io, s3.amazonaws.com 등)의 주소는
// 같은 호스트라도 다른 사용자의 것일 수 있어 신뢰 범위로 보지 않는다(늘 묻는다).
const SHARED_HOSTING_APEXES = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "herokuapp.com", "appspot.com", "blogspot.com", "wordpress.com", "tistory.com", "glitch.me", "onrender.com",
  "azurewebsites.net", "cloudfront.net", "amazonaws.com", "notion.site", "substack.com", "medium.com",
]);

function isSharedHost(host: string): boolean {
  const h = host.toLowerCase();
  for (const apex of SHARED_HOSTING_APEXES) if (h === apex || h.endsWith(`.${apex}`)) return true;
  return false;
}

// 신뢰 사이트로 기억할 값(웹 주소의 출처). 웹 주소가 아니면 null.
export function siteOf(url: string): string | null {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch {
    return null;
  }
}

// 주소의 쿼리·해시 값에 실린 다른 주소(리다이렉트 매개변수 ?url=https%3A…, ?next=//host/…).
// 신뢰 사이트의 열린 리다이렉트를 거쳐 밖으로 나가는 것을 막으려고 그 목적지도 경계 안이어야 한다.
function embeddedUrls(u: URL): string[] {
  const values: string[] = [];
  u.searchParams.forEach((v) => values.push(v));
  if (u.hash.length > 1) {
    const h = u.hash.slice(1);
    values.push(h);
    try {
      new URLSearchParams(h.includes("?") ? h.slice(h.indexOf("?") + 1) : h).forEach((v) => values.push(v));
    } catch {
      /* ignore */
    }
  }
  const out: string[] = [];
  for (const raw of values) {
    let v = raw.trim();
    for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(v); i++) {
      try {
        v = decodeURIComponent(v);
      } catch {
        break;
      }
    }
    // 브라우저가 주소로 해석할 수 있는 값은 모두 실제 목적지로 풀어 본다(역슬래시 /\host, //host, 스킴 있는 주소).
    // 평범한 상대 경로·글자는 같은 사이트로 풀리므로 그대로 통과한다.
    if (/^[/\\]|^(https?|javascript|vbscript|data|blob|file|ftp):/i.test(v)) {
      try {
        out.push(new URL(v, u).href);
      } catch {
        /* 주소가 아님 */
      }
    } else if (/https?:[/\\]{2}/i.test(v)) {
      out.push(v.slice(v.search(/https?:[/\\]{2}/i)));
    }
  }
  return out;
}

function withinTrusted(trustedSites: ReadonlySet<string>, url: string, depth = 0): boolean | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (isSharedHost(u.hostname)) return false;
  const inners = embeddedUrls(u);
  // 리다이렉트를 여러 겹 감싼 주소는 끝까지 풀지 않고 밖으로 본다(묻는다).
  if (inners.length && depth >= 3) return false;
  for (const inner of inners) {
    if (withinTrusted(trustedSites, inner, depth + 1) !== true) return false;
  }
  for (const site of trustedSites) {
    let t: URL;
    try {
      t = new URL(site);
    } catch {
      continue;
    }
    if (t.protocol !== u.protocol || t.port !== u.port) continue;
    if (u.hostname === t.hostname) return true;
    const isIp = /^[\d.]+$/.test(t.hostname) || t.hostname.startsWith("[");
    if (!isIp && t.hostname.includes(".") && u.hostname.endsWith(`.${t.hostname}`)) {
      return true;
    }
  }
  return false;
}

// 이동은 모델이 만든 주소라 대화 내용(개인정보)을 주소·호스트 이름에 실어 밖으로 보낼 수 있다.
// 사용자가 고른 사이트(요청을 시작한 탭의 사이트, 승인 카드로 이동을 허락한 사이트) 안에서만 자동 실행한다.
// 자동 이동·클릭으로 들어간 사이트는 신뢰 사이트가 되지 않는다(두 단계로 나눠 보내는 우회를 막음).
export function navigateAutoBlock(trustedSites: ReadonlySet<string>, targetUrl: string): string | null {
  const inside = withinTrusted(trustedSites, targetUrl);
  if (inside === null) return "웹 주소가 아님";
  return inside ? null : "요청을 시작한 사이트 밖으로 이동";
}

const INERT_HREF_RE = /^javascript:\s*(void\s*\(?\s*0\s*\)?\s*;?|;|)\s*$/i;

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
