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
      // 결제 문구가 붙은 칸이나 결제 화면의 칸(change 처리기가 결제하는 '구매 확정' 체크박스 등).
      if (PAYMENT_TEXT_RE.test(`${t.name} ${splitIdentifier(t.name)}`)) return "결제 문구가 붙은 칸 입력";
      if (t.paymentContext) return "결제 화면의 칸 입력";
      // 입력의 change 처리기가 양식을 바로 제출하는 페이지가 있어, 개인정보가 채워진 양식의 칸도 묻는다.
      if (t.submitsPersonal) return "개인정보가 채워진 양식의 칸 입력";
      // 같은 이유로 결제·개인정보 주소로 제출되는(지금 값까지 합친 제출 주소 포함) 양식의 칸,
      // 결제·개인정보 주소를 가리키는 선택지가 있는 칸도 묻는다.
      for (const url of [t.submitTo ?? "", t.submitUrl ?? "", ...(t.choiceUrls ?? [])]) {
        const why = url ? sensitiveUrlReason(url) : null;
        if (why) return `${why}로 이어지는 칸 입력`;
      }
    }
    return null;
  }
  if (tool === "click_element") {
    for (const t of targets) {
      // 실제로 작동하는 바깥 버튼·링크의 글자도 본다(<button>구매 <span>확인</span></button>의 span).
      // 붙여 쓴 이름(PayNow, BuyNow, pay_now)도 낱말로 나눠 본다.
      const raw = `${t.name} ${t.outerText ?? ""}`;
      const text = `${raw} ${splitIdentifier(raw)}`;
      if (PAYMENT_TEXT_RE.test(text)) return "결제·주문 버튼";
      if (t.paymentContext) return "결제 화면의 버튼";
      // 파일을 내려받는 링크(download 속성)는 이미지 저장처럼 묻는다.
      if (t.download) return "파일 내려받기 링크";
      // 누르면 가는 링크·양식 제출 주소에 결제 경로나 개인정보가 실려 있으면 묻는다.
      for (const href of [t.href, t.ancestorHref ?? "", t.submitTo ?? "", t.submitUrl ?? "", ...(t.choiceUrls ?? [])]) {
        const why = href ? sensitiveUrlReason(href) : null;
        if (why) return `${why}로 가는 링크`;
      }
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
  // 사용자마다 자기 웹앱·양식·파일을 올리는 서비스(남의 배포 주소로 대화 내용을 보낼 수 있다).
  "script.google.com", "script.googleusercontent.com", "docs.google.com", "sites.google.com",
  "storage.googleapis.com", "googleusercontent.com", "forms.gle", "forms.office.com", "blob.core.windows.net",
  "githubusercontent.com", "gist.github.com", "pastebin.com", "dropboxusercontent.com", "firebaseio.com",
  "repl.co", "replit.app", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "surge.sh", "fly.dev", "deno.dev",
  "webhook.site", "pipedream.net",
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
function embeddedUrls(u: URL, maxValues = Infinity): string[] {
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
  if (values.length > maxValues) return [OVER_BUDGET];
  for (const raw of values) {
    // 잘못된 %ZZ가 섞여도 올바른 %XX는 풀어 본다(decodeDeepText). 다 풀고도 인코딩된 주소 흔적(%3A%2F%2F)이 남으면
    // 목적지를 확인하지 못한 것으로 본다(사이트 경계 판정에서 늘 밖 → 묻기).
    const v = normalizeUrlText(decodeDeepText(normalizeUrlText(raw)));
    if (/%3a|%2f%2f|%5c/i.test(v)) {
      out.push(UNDECODABLE);
      continue;
    }
    // 글 속에 박힌 절대 주소("see https://…").
    const mid = v.search(/https?:[/\\]{2}/i);
    if (mid > 0) out.push(v.slice(mid));
    // 주소로 쓰일 수 있는 값(/·\·?·#·=·:·% 포함)은 이 주소 기준으로 브라우저처럼 풀어 본다
    // (//host, /\host, ?next=//host, 스킴 있는 주소). 평범한 글자는 같은 사이트 경로로 풀려 통과한다.
    if (/[/\\?#=:%]/.test(v)) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
      // 브라우저가 이동에 쓰는 스킴이 아니면(date:desc 같은 값) 상대 경로로 본다.
      const text = scheme && !NAV_SCHEMES.has(scheme) ? `./${v}` : v;
      try {
        out.push(new URL(text, u).href);
      } catch {
        /* 주소가 아님 */
      }
    }
  }
  return out;
}

const NAV_SCHEMES = new Set(["http", "https", "javascript", "vbscript", "data", "blob", "file", "ftp", "filesystem", "about"]);

// 브라우저는 주소의 탭·줄바꿈을 지우고 앞뒤의 제어 문자·공백을 잘라 낸다(ht\ttps://… → https://…). 같은 규칙으로 정리한다.
function normalizeUrlText(v: string): string {
  return v.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

// 주소와 그 안에 감싼 주소들을 모두 펼친다(깊이 3, 같은 주소는 한 번만, 전체 MAX_EXPANDED개까지).
// 한도를 넘거나 깊이 3에서도 감싼 주소가 남으면 overflow — 끝까지 확인하지 못했으니 묻는다.
const MAX_EXPANDED = 200;
// 펼치면서 살펴볼 매개변수 값의 총량. 넘으면 끝까지 확인하지 못한 것으로 본다(서비스 워커가 오래 멈추지 않게).
const MAX_VALUES_TOTAL = 2000;
const OVER_BUDGET = "about:over-budget";
const UNDECODABLE = "about:undecodable";

function expandUrls(url: string): { urls: URL[]; overflow: boolean } {
  const urls: URL[] = [];
  const seen = new Set<string>();
  const queue: Array<{ text: string; depth: number }> = [{ text: url, depth: 0 }];
  let overflow = false;
  let budget = 0;
  while (queue.length) {
    const { text, depth } = queue.shift()!;
    let u: URL;
    try {
      u = new URL(normalizeUrlText(text));
    } catch {
      if (depth === 0) return { urls: [], overflow: false };
      continue;
    }
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    if (seen.size > MAX_EXPANDED) return { urls, overflow: true };
    urls.push(u);
    if (!/^https?:$/.test(u.protocol)) continue;
    const inners = embeddedUrls(u, MAX_VALUES_TOTAL - budget);
    if (inners[0] === OVER_BUDGET) return { urls, overflow: true };
    budget += Array.from(u.searchParams).length + 2;
    if (!inners.length) continue;
    if (depth >= 3) {
      overflow = true;
      continue;
    }
    for (const inner of inners) queue.push({ text: inner, depth: depth + 1 });
  }
  return { urls, overflow };
}

function hostTrusted(trustedSites: ReadonlySet<string>, u: URL): boolean {
  if (!/^https?:$/.test(u.protocol) || isSharedHost(u.hostname)) return false;
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
    if (!isIp && t.hostname.includes(".") && u.hostname.endsWith(`.${t.hostname}`)) return true;
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

// 값을 여러 번 인코딩해 숨긴 경우까지 풀어 본다(alice%2540example.com).
// 잘못된 %ZZ가 섞여 있어도 나머지 올바른 %XX는 하나씩 푼다(한 군데 오류로 전체 해석을 포기하지 않게).
export function decodeDeepText(v: string): string {
  let s = v;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
    let next: string;
    try {
      next = decodeURIComponent(s);
    } catch {
      next = s.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
        try {
          return decodeURIComponent(seq);
        } catch {
          return seq.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
        }
      });
    }
    if (next === s) break;
    s = next;
  }
  return s;
}

// 칸 이름·주소 매개변수 이름의 단서(입력 칸과 주소가 같은 규칙을 쓴다). 대상 글자는 splitIdentifier로 나눈 뒤 검사한다.
export const SECRET_HINT_RE =
  /(password|passwd|\bpwd\b|passcode|비밀\s*번호|암호|\botp\b|one[\s_-]*time|인증\s*(번호|코드)|보안\s*번호|verification[\s_-]*code|auth[\s_-]*code|\bpin\b|api[\s_-]*key|access[\s_-]*key|secret|\btoken\b|bearer|authorization|credential|private[\s_-]*key|session[\s_-]*(id|key)|\bsid\b)/i;
export const FIELD_PAYMENT_HINT_RE = /(card.?(num|no)|cardnumber|cvc|cvv|카드\s*번호|보안\s*코드)/i;
export const PERSONAL_HINT_RE =
  /(이름|성명|성함|휴대\s*폰|핸드폰|전화|연락처|이메일|메일\s*주소|주소|우편\s*번호|생년월일|생일|주민|외국인\s*등록|여권|계좌|e[\s-]?mail|phone|mobile|\btel\b|address|\bzip\b|postal|birth|ssn|passport|account|full\s*name|first\s*name|last\s*name|user\s*name|nick\s*name|(?<![a-z])name(?![a-z]))/i;

// 주소 자체가 개인정보를 싣거나 결제로 가는지: 경로·쿼리·해시에 결제 단서, 매개변수 이름에 개인정보·비밀 단서,
// 값에 이메일·전화번호·카드 번호 모양. 같은 사이트 안이라도 이런 주소로의 이동·링크 클릭은 묻는다
// (이메일이 든 GET 가입 양식 주소로 바로 이동, 결제를 확정하는 GET 링크).
const PAYMENT_ROUTE_RE = /(checkout|payment|\bpay\b|\border\b|결제|구매|주문|송금|이체)/i;
const PERSONAL_PARAM_RE =
  /(e[\s-]?mail|phone|mobile|\btel\b|address|\bzip\b|postal|birth|ssn|passport|account|password|passwd|\bpwd\b|\botp\b|card|cvc|cvv|(?<![a-z])name(?![a-z])|username|이름|성명|전화|휴대|연락처|이메일|주소|생년|주민|계좌|비밀번호|카드|인증)/i;
// 휴대전화(01x)·구분자 있는 일반 전화·카드 번호·주민등록번호 모양. 기사 번호 같은 긴 숫자와 헷갈리지 않게 좁게 잡는다.
const PERSONAL_VALUE_RE =
  /(?<!\d)01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)|(?<!\d)0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}(?!\d)|(?<!\d)\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?!\d)|(?<!\d)\d{6}[-\s][1-4]\d{6}(?!\d)/;
const EMAIL_AROUND_AT_RE = /[^\s@/?#&=]{1,64}@[^\s@/?#&=]{1,253}\.[^\s@/?#&=]{1,63}/;
// 이메일 모양이 있는지. 긴 값에서 정규식이 위치마다 다시 훑어 오래 걸리지 않게 '@' 주변(최대 100곳)만 본다.
// 100곳을 넘기면 끝까지 확인하지 못한 것이니 개인정보가 있는 것으로 본다(묻기).
const EMAIL_RE = {
  test(v: string): boolean {
    let from = 0;
    for (let n = 0; n < 100; n++) {
      const at = v.indexOf("@", from);
      if (at < 0) return false;
      if (EMAIL_AROUND_AT_RE.test(v.slice(Math.max(0, at - 64), at + 320))) return true;
      from = at + 1;
    }
    return v.indexOf("@", from) >= 0;
  },
};

// 구분자 없이 이어 쓴 카드 번호(13~19자리, Luhn 검사 통과).
function hasCardNumber(v: string): boolean {
  for (const m of v.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) {
    let sum = 0;
    const digits = m[0];
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

// 식별자 단서(name·id·매개변수 이름)를 낱말로 나눈다: otp_code → "otp code", userPin → "user Pin".
// \b 경계가 _를 단어 글자로 보는 문제를 피한다.
export function splitIdentifier(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.[\]:]+/g, " ");
}

// 값 자체가 개인정보 모양인지(이메일·휴대전화·구분자 있는 전화·카드·주민번호). 인코딩된 값은 풀어 본다.
// 흔한 API 키·토큰 모양(sk-…, ghp_…, xoxb-…, AKIA…, JWT).
const SECRET_VALUE_RE =
  /(?<![A-Za-z0-9])(sk|pk|rk)[-_][A-Za-z0-9][-_A-Za-z0-9]{12,}|(?<![A-Za-z0-9])(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}|(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}|(?<![A-Z0-9])AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./;

export function looksPersonalValue(raw: string): boolean {
  const v = decodeDeepText(raw);
  return PERSONAL_VALUE_RE.test(v) || EMAIL_RE.test(v) || hasCardNumber(v) || SECRET_VALUE_RE.test(v.slice(0, 20000));
}

export function sensitiveUrlReason(url: string): string | null {
  // 리다이렉트 매개변수에 감싼 주소도 같은 기준으로 본다.
  const { urls, overflow } = expandUrls(url);
  if (overflow) return "끝까지 확인하지 못한 복잡한 주소";
  for (const u of urls) {
    // 경로·쿼리·해시를 따로 풀어 본다(한 부분의 잘못된 인코딩이 다른 부분 해석을 막지 않게).
    const route = [u.pathname, u.search, u.hash].map(decodeDeepText).join("");
    // 이어 붙인 표기(pay_now, confirm_order, placeOrder)도 낱말로 나눠 보고, 버튼 문구와 같은 금전 단서
    // (donate, purchase, buy, 충전 등)도 경로 낱말에 적용한다.
    const words = splitIdentifier(route).replace(/[/?#&=+]+/g, " ");
    if (PAYMENT_ROUTE_RE.test(route) || PAYMENT_ROUTE_RE.test(words) || PAYMENT_TEXT_RE.test(words)) {
      return "결제·주문 주소";
    }
    if (u.username || u.password) return "계정 정보가 실린 주소";
    // 쿼리와 해시(#a=b, #/path?a=b — 해시 값을 읽는 SPA) 매개변수 모두 본다.
    const params: Array<[string, string]> = [...u.searchParams];
    if (u.hash.length > 1) {
      const h = u.hash.slice(1);
      try {
        params.push(...new URLSearchParams(h.includes("?") ? h.slice(h.indexOf("?") + 1) : h));
      } catch {
        /* ignore */
      }
    }
    const personal = params.some(([k, raw]) => {
      const v = decodeDeepText(raw);
      const name = splitIdentifier(decodeDeepText(k));
      return (
        !!v.trim() &&
        (PERSONAL_PARAM_RE.test(name) ||
          SECRET_HINT_RE.test(name) ||
          PERSONAL_HINT_RE.test(name) ||
          FIELD_PAYMENT_HINT_RE.test(name) ||
          looksPersonalValue(v))
      );
    });
    // 경로에서는 이메일만 본다(기사·상품 번호 같은 숫자 경로를 개인정보로 오해하지 않게).
    if (personal || EMAIL_RE.test(route)) return "개인정보가 실린 주소";
  }
  return null;
}

// 이동은 모델이 만든 주소라 대화 내용(개인정보)을 주소·호스트 이름에 실어 밖으로 보낼 수 있다.
// 사용자가 고른 사이트(요청을 시작한 탭의 사이트, 승인 카드로 이동을 허락한 사이트) 안에서만 자동 실행한다.
// 자동 이동·클릭으로 들어간 사이트는 신뢰 사이트가 되지 않는다(두 단계로 나눠 보내는 우회를 막음).
export function navigateAutoBlock(trustedSites: ReadonlySet<string>, targetUrl: string): string | null {
  const inside = withinTrusted(trustedSites, targetUrl);
  if (inside === null) return "웹 주소가 아님";
  if (!inside) return "요청을 시작한 사이트 밖으로 이동";
  return sensitiveUrlReason(targetUrl);
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
