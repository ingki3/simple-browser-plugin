import type { ClickableElement, PageRegion } from "@/lib/messages";
import { getAccessibleRoots, isTag } from "./docs";
import {
  choiceUrlsOf,
  controlHasPersonalValue,
  formDestination,
  formHasPersonalValues,
  formSubmissionUrl,
  isPersonalField,
  personalValuedElements,
} from "./forms";
import { closestAcross, eventParent, inPaymentContext } from "./context";
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




// 링크 안의 요소면 그 링크 주소(웹 컴포넌트를 감싼 <a>까지).
function enclosingLinkHref(el: HTMLElement): string {
  const parent = eventParent(el);
  const link = parent ? closestAcross(parent, "a[href], area[href]") : null;
  return link ? (link as HTMLAnchorElement).href : "";
}

const CONTROL_SELECTOR =
  'a[href], area[href], button, input[type=submit], input[type=image], input[type=button], [role="button"], [role="link"]';

function parentAcrossShadow(el: Element): Element | null {
  return eventParent(el);
}

// 보이는 글자와 다른 접근성 이름(aria-label·aria-labelledby·title·value). <button aria-label="Buy now">🛒</button>
function accessibleNames(el: Element): string {
  const parts = [el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? ""];
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    const ref = (el.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? el.ownerDocument.getElementById(id);
    if (ref) parts.push(ref.textContent ?? "");
  }
  if (isTag(el, "input")) parts.push(el.value);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function enclosingControlTexts(el: HTMLElement): string {
  const texts: string[] = [accessibleNames(el)];
  for (let cur = parentAcrossShadow(el); cur; cur = parentAcrossShadow(cur)) {
    const c = closestAcross(cur, CONTROL_SELECTOR);
    if (!c) break;
    texts.push(clickText(c as HTMLElement), accessibleNames(c));
    cur = c;
  }
  // label을 누르면 연결된 컨트롤이 작동하므로 그 이름도 본다.
  const control = labelControl(el);
  if (control) texts.push(clickText(control), accessibleNames(control));
  return texts.filter(Boolean).join(" ").slice(0, 400);
}

// 누르면 실제로 작동하는 양식 컨트롤: 자신 또는 감싼 button·제출 input(<button form=f><span>다음</span></button>).
function activatedControl(el: HTMLElement): HTMLButtonElement | HTMLInputElement | null {
  // 직접 누르는 checkbox·radio도 자기 양식과 자기 값을 싣는 컨트롤이다.
  const c = closestAcross(
    el,
    "button, input[type=submit], input[type=image], input[type=button], input[type=reset], input[type=checkbox], input[type=radio]",
  );
  if (c) return c as HTMLButtonElement | HTMLInputElement;
  // <label for="send">을 누르면 연결된 제출 input이 작동한다.
  const control = labelControl(el);
  if (control && (isTag(control, "button") || (isTag(control, "input") && ["submit", "image"].includes(control.type)))) {
    return control as HTMLButtonElement | HTMLInputElement;
  }
  return null;
}

function labelControl(el: HTMLElement): HTMLElement | null {
  const label = closestAcross(el, "label") as HTMLLabelElement | null;
  return (label?.control as HTMLElement | null | undefined) ?? null;
}


const CLICK_KIND: TargetKind = {
  prefix: "c",
  attr: "data-sbp-cid",
  visible: isVisible,
  requireVisible: true,
  name: clickText,
  fieldType: () => "",
  sensitive: () => null,
  // 누르면 작동할 컨트롤의 양식에서 값이 채워진 개인정보·비밀 칸들(승인 뒤 새로 채워졌는지 보려고).
  personalElements: (el) => {
    const control = activatedControl(el) ?? labelControl(el);
    const form = (control as HTMLInputElement | null)?.form ?? (closestAcross(el, "form") as HTMLFormElement | null);
    return form ? personalValuedElements(form) : [];
  },
  // 개인정보·비밀번호·결제 값이 채워진 양식 안의 버튼이면 제출로 본다(제출 버튼이 아니어도 스크립트로 보내는 양식이 있어 넓게 잡는다).
  risk: (el) => {
    const control = activatedControl(el);
    // label이 연결한 컨트롤(checkbox·radio 포함)도 누르면 작동하므로 그 양식과, 작동 뒤 실릴 값을 본다.
    const linked = control ? null : labelControl(el);
    const linkedForm = linked && "form" in linked ? ((linked as HTMLInputElement).form ?? null) : null;
    const form = control?.form ?? linkedForm ?? (closestAcross(el, "form") as HTMLFormElement | null);
    const submitTo = formDestination(control ?? el, form);
    const submitUrl = form && submitTo ? formSubmissionUrl(form, submitTo, control ?? linked) : "";
    // 링크 안의 요소(<a><span role=button>)를 누르면 바깥 링크가 열리므로 그 주소도 목적지로 본다.
    const ancestorHref = enclosingLinkHref(el);
    // 클릭으로 바뀌는 checkbox·radio(직접 또는 label 연결)의 value가 주소면 그 주소도 목적지로 본다.
    const toggled = [control, linked].find((c) => !!c && isTag(c, "input") && ["checkbox", "radio"].includes((c as HTMLInputElement).type));
    const choiceUrls = toggled ? choiceUrlsOf(toggled as HTMLElement) : [];
    // 대상을 감싼 버튼·링크들(실제로 작동하는 바깥 컨트롤까지)의 글자를 모두 모은다.
    const outerText = enclosingControlTexts(el);
    return {
      // 작동할 컨트롤(제출 버튼, 또는 label이 연결한 checkbox·radio) 자신이 실을 개인정보 값도 본다.
      submitsPersonal:
        (!!form && formHasPersonalValues(form)) ||
        controlHasPersonalValue(control ?? linked) ||
        [control, linked].some(
          (c) => !!c && isTag(c, "input") && ["checkbox", "radio"].includes(c.type) && isPersonalField(c) && !!c.value.trim(),
        ),
      paymentContext: inPaymentContext(el, form),
      ...(submitTo ? { submitTo } : {}),
      ...(submitUrl ? { submitUrl } : {}),
      ...(ancestorHref ? { ancestorHref } : {}),
      ...(outerText ? { outerText } : {}),
      ...(choiceUrls.length ? { choiceUrls } : {}),
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
