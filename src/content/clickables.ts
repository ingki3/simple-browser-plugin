import type { ClickableElement, PageRegion } from "@/lib/messages";
import { getAccessibleRoots, isTag } from "./docs";
import { formHasPersonalValues } from "./forms";
import { PAYMENT_TEXT_RE } from "@/lib/autoApprove";
import {
  detectRegion,
  recheckApproved,
  registerTarget,
  scanTargets,
  startEffectWatch,
  takeApproved,
  type TargetKind,
} from "./targets";

const CLICK_SELECTOR =
  'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]';

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  if (el.closest("[aria-hidden='true']")) return false;
  return true;
}

function cleanText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

function clickText(el: HTMLElement): string {
  return cleanText(
    el.innerText ||
      el.textContent ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      (isTag(el, "input") ? el.value : "") ||
      "",
  );
}

// 결제 화면인지: 문서 주소(경로·쿼리·해시 — SPA는 #/checkout·?route=checkout처럼 라우팅한다)·제목·큰 제목(h1·h2),
// 또는 버튼이 든 양식·대화상자의 글자(앞부분)에 결제 단서가 있으면.
// section·article은 보지 않는다(상품 목록 구역에 "구매 1,234" 같은 글자가 흔해 목록 안 버튼이 모두 걸린다).
function inPaymentContext(el: HTMLElement, form: HTMLFormElement | null): boolean {
  const doc = el.ownerDocument;
  const loc = doc.defaultView?.location;
  let route = `${loc?.pathname ?? ""}${loc?.search ?? ""}${loc?.hash ?? ""}`;
  try {
    route = decodeURIComponent(route);
  } catch {
    /* 그대로 */
  }
  if (/(checkout|payment|\bpay\b|order)/i.test(route)) return true;
  const headings = Array.from(doc.querySelectorAll("h1, h2"), (h) => h.textContent ?? "").join(" ").slice(0, 1000);
  if (PAYMENT_TEXT_RE.test(`${route} ${doc.title} ${headings}`)) return true;
  // 양식과 그 바깥 대화상자를 각각 본다(대화상자의 "결제 금액" 문구 아래 양식 속 '확인' 버튼).
  const dialog = el.closest('dialog, [role="dialog"], [role="alertdialog"]');
  return [form, dialog].some((scope) => !!scope && PAYMENT_TEXT_RE.test((scope.textContent ?? "").slice(0, 2000)));
}

const CLICK_KIND: TargetKind = {
  prefix: "c",
  attr: "data-sbp-cid",
  visible: isVisible,
  requireVisible: true,
  name: clickText,
  fieldType: () => "",
  sensitive: () => null,
  // 개인정보·비밀번호·결제 값이 채워진 양식 안의 버튼이면 제출로 본다(제출 버튼이 아니어도 스크립트로 보내는 양식이 있어 넓게 잡는다).
  risk: (el) => {
    const form = (el as HTMLButtonElement).form ?? el.closest("form");
    // 버튼에 formaction 속성이 있으면 그것이, 없으면 양식 action이 실제 제출 주소다(둘 다 절대 주소로 돌려받는다).
    // formAction은 속성이 없을 때 지금 문서 주소를 돌려주므로 속성이 있을 때만 쓴다.
    const submitTo = form
      ? el.hasAttribute("formaction")
        ? (el as HTMLButtonElement).formAction
        : form.action || ""
      : "";
    return {
      submitsPersonal: !!form && formHasPersonalValues(form),
      paymentContext: inPaymentContext(el, form),
      ...(submitTo ? { submitTo } : {}),
    };
  },
};

function rectInViewport(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView ?? window;
  const vw = win.innerWidth || win.document.documentElement.clientWidth;
  const vh = win.innerHeight || win.document.documentElement.clientHeight;
  return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
}

type FindClickablesArgs = {
  query?: string;
  region?: PageRegion;
  onlyViewport?: boolean;
  limit?: number;
};

export function findClickables(args: FindClickablesArgs): ClickableElement[] {
  return scanTargets(() => collectClickables(args));
}

function collectClickables(args: FindClickablesArgs): ClickableElement[] {
  const limit = Math.min(args.limit ?? 50, 200);
  const q = args.query?.toLowerCase().trim() ?? "";
  const out: ClickableElement[] = [];
  const seenKeys = new Set<string>();
  for (const root of getAccessibleRoots()) {
    if (out.length >= limit) break;
    const nodes = root.querySelectorAll<HTMLElement>(CLICK_SELECTOR);
    for (const el of nodes) {
      if (out.length >= limit) break;
      if (!isVisible(el)) continue;

      const inViewport = rectInViewport(el);
      if (args.onlyViewport && !inViewport) continue;

      const region = detectRegion(el);
      if (args.region && region !== args.region) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? "";
      const href = isTag(el, "a") ? el.href : "";
      const text = clickText(el);
      if (!text && !href) continue;

      if (q) {
        const hay = `${text} ${href}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }

      const key = `${tag}|${text}|${href}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const id = registerTarget(CLICK_KIND, el);
      out.push({ id, text, href, tag, role, region, inViewport });
    }
  }

  return out;
}

// 승인 카드에서 확인한 그 요소일 때만 누른다. 결과 관찰은 클릭 직전에 시작해 백그라운드가 action_effect로 읽는다.
export function clickElement(
  args: { id: string },
  callId: string,
): { clicked: boolean; text: string; href: string; effectToken: string } {
  const { el, info } = takeApproved(args.id, callId, CLICK_KIND.prefix);
  const text = clickText(el);
  const href = isTag(el, "a") ? el.href : "";
  const effectToken = `${callId}:${Date.now()}`;

  // Defer actual click so the content-script response can fly back to the
  // background before a potential navigation tears down this context.
  setTimeout(() => {
    try {
      el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* ignore */
      }
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    // 스크롤·포커스 처리기가 대상을 바꿨을 수 있으니 누르기 바로 앞에서 다시 본다. 같은 실행 흐름 안이라
    // 이 확인과 클릭 사이에는 페이지 코드가 끼어들지 않는다. 바뀌었으면 누르지 않고 결과로 알린다.
    const changed = recheckApproved(CLICK_KIND, el, info);
    // 스크롤·포커스로 생긴 변화는 빼고 클릭 뒤의 변화만 센다.
    startEffectWatch(effectToken, el, changed);
    if (changed) return;
    try {
      el.click();
    } catch (err) {
      console.warn("[click_element] click threw", err);
    }
  }, 0);

  return { clicked: true, text, href, effectToken };
}
