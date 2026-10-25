// 자동 로그인 판정(docs/design/login-automation.md). sign_in을 승인 카드 없이 실행할지 정하는 순수 함수와, 사용자가 승인한
// 사이트 목록(출처 → KeePassXC 항목 묶음)의 정리. 판정은 구조(정확한 출처, 칸 종류, 양식의 제출 주소)와 사용자의 명시적 승인으로만
// 한다. 낱말은 결제·삭제처럼 "더 묻는" 기존 신호(destructiveClickBlock·PAYMENT_TEXT_RE)로만 쓴다.
import type { TargetInfo } from "./actionTarget.ts";
import {
  decodeDeepText,
  DESTRUCTIVE_REASON,
  destructiveClickBlock,
  destructiveRoute,
  destructiveFillBlock,
  expandUrls,
  PAYMENT_TEXT_RE,
  sensitiveUrlReason,
  splitIdentifier,
} from "./autoApprove.ts";
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
  // 숨은 기본 제출 버튼의 위험(삭제 선언·삭제·결제 글자). 보이는 버튼은 submit 기술로 본다.
  hiddenSubmitBlock?: string | null;
  // 다른 창·프레임으로 보내는 양식(target·formtarget).
  otherTarget?: boolean;
  // 넣을 칸에 결제용 autocomplete(cc-*)·결제 칸 단서가 있는지(비밀번호 칸으로 분류된 카드 보안 코드 칸 등).
  paymentField?: boolean;
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
// 자동 로그인을 막는 이유 모두(카드로 승인한 뒤 새로 생긴 이유만 골라 막으려고 각각 모은다). 빈 목록이면 구조로는 자동 실행해도 된다.
// inserted: 이번 호출이 칸에 넣은 값들. 넣은 뒤 다시 판정할 때 칸 값까지 합친 제출 주소에서 그 값을 빼고 본다(비밀번호에
// 'Payment'·주소 모양 글자가 있어도 결제·외부 목적지로 오판하지 않게). 숨은 칸·버튼 값과 목적지는 그대로 본다.
export function loginShapeBlocks(shape: LoginShape, origin: string, inserted: readonly InsertedValue[] = []): string[] {
  const out = new Set<string>();
  const add = (why: string | null | undefined) => {
    if (why) out.add(why);
  };
  const frame = loginOrigin(shape.frameUrl);
  if (!frame) add("https 페이지가 아님");
  else if (frame !== origin) add("칸이 든 문서의 출처가 다름");
  if (loginOrigin(shape.topUrl) !== origin) add("다른 사이트 안에 끼워 넣은 로그인 칸");
  if (shape.newPassword) add("새 비밀번호 칸이 있는 화면(가입·비밀번호 변경일 수 있음)");
  if (shape.otherFields) add("로그인 칸 밖의 입력 칸이 함께 있는 양식(정보 수정일 수 있음)");
  add(shape.hiddenSubmitBlock);
  if (shape.otherTarget) add("다른 창·프레임으로 보내는 양식");
  // 결제 정보 칸(카드 번호·보안 코드 등)이 넣을 칸이면 묻는다(비밀번호 칸으로 분류된 보안 코드 칸 포함 — paymentField).
  if (shape.paymentField || shape.fields.some((f) => f.sensitive === "payment")) add("결제 정보 칸");
  for (const u of shape.submitUrls) {
    if (!onlyOrigin(u, origin)) add("로그인 정보를 다른 출처로 보내는 양식");
    // 결제·개인정보 주소로 보내는 양식(결제 재인증 등)은 클릭·입력과 같은 기준으로 묻는다.
    const why = sensitiveUrlReason(u);
    if (why) add(`${why}로 보내는 양식`);
    // 삭제 경로로 보내는 양식(숨은 버튼의 formaction="/delete" 등)도 되돌리기 어려운 동작으로 묻는다.
    if (destructiveRoute(u)) add(DESTRUCTIVE_REASON);
  }
  // 값을 넣거나 누르면 일으킬 htmx 요청(change·click 처리기가 칸 값을 실어 보냄)도 같은 출처·같은 기준이어야 한다.
  // 확인할 수 없는 요청(GET 아님·from: 리스너 등)은 묻는다. htmx GET 요청은 칸 값을 주소에 싣는다.
  for (const t of [...shape.fields, ...(shape.submit ? [shape.submit] : [])]) {
    if (t.opaqueRequest) add("확인할 수 없는 htmx 요청이 붙은 칸·버튼");
    for (const u of t.requestUrls ?? []) {
      if (!onlyOrigin(u, origin)) add("로그인 정보를 다른 출처로 보내는 요청(htmx)");
      const why = sensitiveUrlReason(u);
      if (why) add(`${why}로 보내는 요청(htmx)`);
    }
    if ((t.requestUrls ?? []).length) add("값을 주소에 싣는 htmx GET 요청이 붙은 칸·버튼");
  }
  // GET 양식은 값을 주소에 실어 주소창·방문 기록·서버 로그에 남긴다.
  if (shape.hasForm && shape.submitMethods.some((m) => m !== "post")) add("POST가 아닌 방법으로 제출하는 양식");
  // 칸 값까지 합친 제출 주소(숨은 칸의 next=https://다른곳 등)에 실린 목적지도 같은 출처여야 한다.
  for (const t of [...shape.fields, ...(shape.submit ? [shape.submit] : [])]) {
    for (const u of [t.submitUrl ?? "", ...(t.scopeSubmitUrls ?? [])]) {
      if (u && !onlyOrigin(withoutValues(u, inserted), origin)) add("로그인 정보를 다른 출처로 보낼 수 있는 양식(실린 주소)");
    }
  }
  add(destructiveFillBlock(shape.fields));
  if (shape.fields.some((f) => paymentSubmission(f, inserted))) add("결제 값을 함께 보내는 양식");
  if (shape.submit) for (const why of submitControlBlocks(shape.submit, inserted)) add(why);
  if (shape.fields.some((f) => f.paymentContext)) add("결제 화면의 칸");
  return [...out];
}

// 첫 이유(카드에 보일 것). 없으면 null.
export function loginShapeBlock(shape: LoginShape, origin: string): string | null {
  return loginShapeBlocks(shape, origin)[0] ?? null;
}

export interface InsertedValue {
  name: string;
  value: string;
}

// 쿼리에서 이름·값이 inserted 중 하나인 매개변수를 뺀 주소(값은 한 번 이상 인코딩돼 있을 수 있어 풀어서 비교).
function withoutValues(url: string, inserted: readonly InsertedValue[]): string {
  if (!inserted.length) return url;
  try {
    const u = new URL(url);
    const kept = new URLSearchParams();
    u.searchParams.forEach((v, k) => {
      const dv = decodeDeepText(v);
      // 이번 호출이 쓴 칸의 이름·값 쌍만 뺀다(같은 값을 다른 이름의 숨은 칸에 옮긴 결제 신호 buy=alice는 남긴다).
      if (!inserted.some((x) => x.name === k && (x.value === v || x.value === dv || x.value.trim() === dv.trim()))) kept.append(k, v);
    });
    u.search = kept.toString();
    return u.href;
  } catch {
    return url;
  }
}

const PAYMENT_URL_REASON = "결제·주문 주소";

// 실제 제출 값을 합친 주소(숨은 칸 operation=pay 등)의 결제 신호. 개인정보 모양은 보지 않는다(브라우저가 채운 이메일
// 아이디만으로 로그인 양식이 늘 걸리지 않게 — 그 값은 이 호출이 넣는 값이거나 사용자의 값이다).
function paymentSubmission(t: TargetInfo, inserted: readonly InsertedValue[] = []): boolean {
  return [t.submitUrl ?? "", ...(t.scopeSubmitUrls ?? [])].some(
    (u) => !!u && sensitiveUrlReason(withoutValues(u, inserted)) === PAYMENT_URL_REASON,
  );
}

// 제출 버튼의 되돌리기 어려운 동작·결제 신호 모두(승인 판정과 입력·제출 직전 재검사가 함께 쓴다).
export function submitControlBlocks(t: TargetInfo, inserted: readonly InsertedValue[] = []): string[] {
  const out = new Set<string>();
  if (paymentSubmission(t, inserted)) out.add("결제 값을 함께 보내는 양식");
  const clickDestructive = destructiveClickBlock([t]);
  if (clickDestructive) out.add(clickDestructive);
  const raw = `${t.name} ${t.outerText ?? ""}`;
  if (PAYMENT_TEXT_RE.test(`${raw} ${splitIdentifier(raw)}`)) out.add("결제·주문 버튼");
  if (t.paymentContext) out.add("결제 화면의 버튼");
  for (const u of [t.submitTo ?? "", t.href, ...(t.scopeFormActions ?? [])]) {
    const why = u ? sensitiveUrlReason(u) : null;
    if (why) out.add(`${why}로 이어지는 버튼`);
  }
  return [...out];
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
