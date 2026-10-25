// 자동 로그인 판정(docs/design/login-automation.md). sign_in을 승인 카드 없이 실행할지 정하는 순수 함수와, 사용자가 승인한
// 사이트 목록(출처 → KeePassXC 항목 묶음)의 정리. 판정은 구조(정확한 출처, 칸 종류, 양식의 제출 주소)와 사용자의 명시적 승인으로만
// 한다. 낱말은 결제·삭제처럼 "더 묻는" 기존 신호(destructiveClickBlock·PAYMENT_TEXT_RE)로만 쓴다.
import type { TargetInfo } from "./actionTarget.ts";
import { destructiveClickBlock, destructiveFillBlock, expandUrls, PAYMENT_TEXT_RE, sensitiveUrlReason, splitIdentifier } from "./autoApprove.ts";
import { httpOrigin } from "./url.ts";

export const MAX_LOGIN_SITES = 50;

// 사용자가 자동 로그인을 승인한 사이트. 정확한 출처 하나와 그 출처에 쓸 KeePassXC 항목 하나를 묶는다.
// entryName은 설정 화면 표시용(항목 제목). 아이디·비밀번호는 두지 않는다.
export interface LoginSite {
  origin: string;
  uuid: string;
  entryName: string;
  // 일회용 코드(TOTP)도 자동으로 넣을지. 기본 꺼짐(2단계 인증을 약하게 하므로 따로 고른다).
  totp: boolean;
}

// https 출처만(개발용 http://localhost·127.0.0.1은 허용). 경로가 붙은 주소는 받지 않는다.
export function loginOrigin(url: string | undefined): string | null {
  const o = httpOrigin(url);
  if (!o) return null;
  try {
    const u = new URL(o);
    if (u.protocol === "https:") return o;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return o;
  } catch {
    return null;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{32}$/i;

export function normalizeLoginSites(raw: unknown): LoginSite[] {
  if (!Array.isArray(raw)) return [];
  const out: LoginSite[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const origin = typeof r.origin === "string" ? loginOrigin(r.origin) : null;
    if (!origin || origin !== r.origin || out.some((s) => s.origin === origin)) continue;
    if (typeof r.uuid !== "string" || !UUID_RE.test(r.uuid)) continue;
    out.push({
      origin,
      uuid: r.uuid.toLowerCase(),
      entryName: typeof r.entryName === "string" ? r.entryName.slice(0, 120) : "",
      totp: r.totp === true,
    });
    if (out.length >= MAX_LOGIN_SITES) break;
  }
  return out;
}

export function loginSiteFor(sites: readonly LoginSite[], origin: string | null): LoginSite | null {
  if (!origin) return null;
  return sites.find((s) => s.origin === origin) ?? null;
}

// content script가 sign_in 대상 칸 주변에서 구조로 읽은 로그인 양식의 모양(src/content/login.ts).
export interface LoginShape {
  // password: 보이는 비밀번호 칸이 있는 단계. username: 아이디만 먼저 받는 단계. otp: 일회용 코드 칸.
  step: "password" | "username" | "otp";
  // 칸이 든 문서의 주소와 최상위 문서의 주소.
  frameUrl: string;
  topUrl: string;
  // 새 비밀번호 칸(autocomplete=new-password)이나 보이는 비밀번호 칸이 둘 이상 — 가입·비밀번호 변경 화면일 수 있다.
  newPassword: boolean;
  // 넣을 칸 밖의 보이는 입력 칸이나 값이 채워진 개인정보 칸이 양식에 함께 있는지(정보 수정 양식일 수 있다).
  otherFields: boolean;
  // 양식(<form>) 안인지. 아니면 채우기만 하고 제출은 모델의 click_element(기존 승인 규칙)로 한다.
  hasForm: boolean;
  // 양식의 제출 주소들(action, 제출 버튼의 formaction, 범위 안 다른 양식의 action). 절대 주소.
  submitUrls: string[];
  // 양식의 실제 제출 메서드들(method, 제출 버튼의 formmethod — get·post·dialog). 양식이 없으면 빈 목록.
  submitMethods: string[];
  // 칸 id(이 호출의 승인 대상으로 등록됨)와 그 기술.
  usernameId?: string;
  passwordId?: string;
  otpId?: string;
  submitId?: string;
  fields: TargetInfo[];
  submit?: TargetInfo;
}

// 주소와 그 안에 실린 주소(리다이렉트 매개변수 등, expandUrls)가 모두 그 출처인지. 끝까지 펼치지 못했으면 false.
function onlyOrigin(url: string, origin: string): boolean {
  if (httpOrigin(url) !== origin) return false;
  const { urls, overflow } = expandUrls(url);
  if (overflow) return false;
  return urls.every((u) => !/^https?:$/.test(u.protocol) || u.origin === origin);
}

// 자동 로그인을 막는 이유. null이면 구조로는 자동 실행해도 된다(사이트 승인·항목 묶음은 따로 본다).
// origin: 값을 받을 출처(항목을 묶은 출처). 모든 제출 주소가 이 출처여야 한다(다른 승인 사이트로도 보내지 않는다).
export function loginShapeBlock(shape: LoginShape, origin: string): string | null {
  const frame = loginOrigin(shape.frameUrl);
  if (!frame) return "https 페이지가 아님";
  if (frame !== origin) return "칸이 든 문서의 출처가 다름";
  if (loginOrigin(shape.topUrl) !== origin) return "다른 사이트 안에 끼워 넣은 로그인 칸";
  if (shape.newPassword) return "새 비밀번호 칸이 있는 화면(가입·비밀번호 변경일 수 있음)";
  if (shape.otherFields) return "로그인 칸 밖의 입력 칸이 함께 있는 양식(정보 수정일 수 있음)";
  for (const u of shape.submitUrls) {
    if (!onlyOrigin(u, origin)) return "로그인 정보를 다른 출처로 보내는 양식";
    // 결제·개인정보 주소로 보내는 양식(결제 재인증 등)은 클릭·입력과 같은 기준으로 묻는다.
    const why = sensitiveUrlReason(u);
    if (why) return `${why}로 보내는 양식`;
  }
  // 값을 넣거나 누르면 일으킬 htmx 요청(change·click 처리기가 칸 값을 실어 보냄)도 같은 출처·같은 기준이어야 한다.
  // 확인할 수 없는 요청(GET 아님·from: 리스너 등)은 묻는다.
  for (const t of [...shape.fields, ...(shape.submit ? [shape.submit] : [])]) {
    if (t.opaqueRequest) return "확인할 수 없는 htmx 요청이 붙은 칸·버튼";
    for (const u of t.requestUrls ?? []) {
      if (!onlyOrigin(u, origin)) return "로그인 정보를 다른 출처로 보내는 요청(htmx)";
      if (sensitiveUrlReason(u)) return `${sensitiveUrlReason(u)}로 보내는 요청(htmx)`;
    }
    // htmx GET 요청은 칸 값을 주소에 싣는다(비밀번호가 주소창·서버 로그에 남음).
    if ((t.requestUrls ?? []).length) return "값을 주소에 싣는 htmx GET 요청이 붙은 칸·버튼";
  }
  // GET 양식은 값을 주소에 실어 주소창·방문 기록·서버 로그에 남긴다.
  if (shape.hasForm && shape.submitMethods.some((m) => m !== "post")) return "POST가 아닌 방법으로 제출하는 양식";
  // 칸 값까지 합친 제출 주소(숨은 칸의 next=https://다른곳 등)에 실린 목적지도 같은 출처여야 한다.
  for (const t of [...shape.fields, ...(shape.submit ? [shape.submit] : [])]) {
    for (const u of [t.submitUrl ?? "", ...(t.scopeSubmitUrls ?? [])]) {
      if (u && !onlyOrigin(u, origin)) return "로그인 정보를 다른 출처로 보낼 수 있는 양식(실린 주소)";
    }
  }
  const fieldDestructive = destructiveFillBlock(shape.fields);
  if (fieldDestructive) return fieldDestructive;
  if (shape.fields.some(paymentSubmission)) return "결제 값을 함께 보내는 양식";
  if (shape.submit) {
    const why = submitControlBlock(shape.submit);
    if (why) return why;
  }
  if (shape.fields.some((f) => f.paymentContext)) return "결제 화면의 칸";
  return null;
}

const PAYMENT_URL_REASON = "결제·주문 주소";

// 실제 제출 값을 합친 주소(숨은 칸 operation=pay 등)의 결제 신호. 개인정보 모양은 보지 않는다(브라우저가 채운 이메일
// 아이디만으로 로그인 양식이 늘 걸리지 않게 — 그 값은 이 호출이 넣는 값이거나 사용자의 값이다).
function paymentSubmission(t: TargetInfo): boolean {
  return [t.submitUrl ?? "", ...(t.scopeSubmitUrls ?? [])].some((u) => !!u && sensitiveUrlReason(u) === PAYMENT_URL_REASON);
}

// 제출 버튼의 되돌리기 어려운 동작·결제 신호(승인 판정과 제출 직전 재검사가 함께 쓴다).
export function submitControlBlock(t: TargetInfo): string | null {
  if (paymentSubmission(t)) return "결제 값을 함께 보내는 양식";
  const clickDestructive = destructiveClickBlock([t]);
  if (clickDestructive) return clickDestructive;
  const raw = `${t.name} ${t.outerText ?? ""}`;
  if (PAYMENT_TEXT_RE.test(`${raw} ${splitIdentifier(raw)}`)) return "결제·주문 버튼";
  if (t.paymentContext) return "결제 화면의 버튼";
  for (const u of [t.submitTo ?? "", t.href, ...(t.scopeFormActions ?? [])]) {
    const why = u ? sensitiveUrlReason(u) : null;
    if (why) return `${why}로 이어지는 버튼`;
  }
  return null;
}

export interface SignInDecisionInput {
  shape: LoginShape;
  // 칸이 든 문서의 출처(브라우저가 정한 탭 주소로 다시 확인한 값).
  origin: string;
  site: LoginSite | null;
  // KeePassXC가 이 주소에 돌려준 항목 uuid들.
  entryUuids: readonly string[];
  // 이 대화에서 이 출처에 이미 자동 로그인을 했는지(재시도 금지).
  attempted: boolean;
  // 이 출처에서 넣은 값이 페이지 글자에 다시 보여 가린 적이 있는지.
  maskedHere: boolean;
  // 외부 본문 보호 중(#37).
  guarded: boolean;
}

// 자동 실행이면 { auto: true }, 아니면 카드에 보일 이유.
export function signInDecision(i: SignInDecisionInput): { auto: true } | { auto: false; reason: string } {
  if (!i.site) return { auto: false, reason: "자동 로그인을 승인하지 않은 사이트" };
  if (!i.entryUuids.includes(i.site.uuid)) return { auto: false, reason: "승인할 때 고른 KeePassXC 항목이 이 주소에 없음" };
  if (i.shape.step === "otp" && !i.site.totp) return { auto: false, reason: "일회용 코드 자동 입력을 켜지 않은 사이트" };
  if (i.guarded) return { auto: false, reason: "외부 문서 내용을 읽은 대화" };
  if (i.attempted) return { auto: false, reason: "이 대화에서 이미 자동 로그인을 시도한 사이트(다시 시도하지 않음)" };
  if (i.maskedHere) return { auto: false, reason: "페이지가 넣은 로그인 정보를 화면에 다시 보여 줌" };
  const why = loginShapeBlock(i.shape, i.origin);
  if (why) return { auto: false, reason: why };
  return { auto: true };
}
