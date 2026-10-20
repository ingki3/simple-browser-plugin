import type { ClickableElement, PageRegion } from "@/lib/messages";
import { PAYMENT_TEXT_RE, splitIdentifier } from "@/lib/autoApprove";
import { clickMatchScore, queryTerms } from "@/lib/clickQuery";
import { getAccessibleRoots, isTag } from "./docs";
import {
  choiceUrlsOf,
  controlHasPersonalValue,
  formDestination,
  formHasPersonalValues,
  formSubmissionUrl,
  isPersonalField,
  captureHiddenBaselines,
  personalValuedInScopes,
  scopeSubmitUrls,
  otherDestinations,
  sensitivityOf,
} from "./forms";
import {
  closestAcross,
  eventParent,
  formlessScopes,
  inPaymentContext,
  linkHrefOf,
  nestedContainerScan,
  type FormlessScope,
} from "./context";
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
  // SVG의 xlink:href 링크도 포함한다([*|href]는 이름공간과 관계없이 href 속성).
  const link = parent ? closestAcross(parent, "a[href], area[href], a[*|href]") : null;
  return link ? linkHrefOf(link) : "";
}

const CONTROL_SELECTOR =
  'a[href], area[href], button, input[type=submit], input[type=image], input[type=button], [role="button"], [role="link"]';

function parentAcrossShadow(el: Element): Element | null {
  return eventParent(el);
}

// aria-labelledby가 가리키는 요소들의 글자.
function labelledByText(el: Element): string {
  const parts: string[] = [];
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    const ref = (el.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? el.ownerDocument.getElementById(id);
    if (ref) parts.push(ref.textContent ?? "");
  }
  return parts.join(" ");
}

// 보이는 글자와 다른 접근성 이름(aria-label·aria-labelledby·title·value). <button aria-label="Buy now">🛒</button>
function accessibleNames(el: Element): string {
  const parts = [el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? "", labelledByText(el)];
  if (isTag(el, "input")) parts.push(el.value);
  // 이미지로 표시한 버튼·링크의 이름(<a><img alt="Buy now"></a>, input[type=image], area, svg title).
  parts.push(el.getAttribute("alt") ?? "");
  // 한도 없이 모두 본다(앞에 무해한 요소를 많이 두고 뒤에 결제 이름을 숨기지 못하게). 각 속성을 따로 넣는다.
  // 자식 컴포넌트의 열린 shadow root 안(<button><payment-label></payment-label></button>)의 글자·이름도 본다.
  const nested = nestedContainerScan(el);
  for (const root of [el, ...nested.containers]) {
    if (root !== el) parts.push(root.textContent ?? "");
    for (const d of Array.from(root.querySelectorAll("img, input, area, svg title, [aria-label], [title], [aria-labelledby]"))) {
      parts.push(d.getAttribute("alt") ?? "", d.getAttribute("aria-label") ?? "", d.getAttribute("title") ?? "");
      parts.push(labelledByText(d));
      if (d.localName === "title") parts.push(d.textContent ?? "");
    }
  }
  // 한도에 걸려 끝까지 보지 못했으면 결제 이름이 숨어 있을 수 있으니 결제 단서로 본다(늘 묻는다).
  if (nested.incomplete) parts.push("payment");
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function enclosingControlTexts(el: HTMLElement): string {
  const texts: string[] = [accessibleNames(el)];
  for (let cur = parentAcrossShadow(el); cur; cur = parentAcrossShadow(cur)) {
    const c = closestAcross(cur, CONTROL_SELECTOR);
    if (!c) break;
    // 바깥 컨트롤도 전체 글자로 본다(clickText는 200자로 자른다).
    texts.push(((c as HTMLElement).innerText || c.textContent || "").replace(/\s+/g, " "), accessibleNames(c));
    cur = c;
  }
  // label을 누르면 연결된 컨트롤이 작동하므로 그 이름도 본다.
  const control = labelControl(el);
  if (control) texts.push((control.innerText || control.textContent || "").replace(/\s+/g, " "), accessibleNames(control));
  // 판정에는 전체 글자를 쓴다(앞부분만 보면 긴 aria-label 뒤의 'Buy now'를 놓친다). 대상 자신의 전체 글자도 넣는다.
  texts.push((el.innerText || el.textContent || "").replace(/\s+/g, " "));
  return texts.filter(Boolean).join(" ");
}

// 버튼이 제출할 값의 범위: 연결된 양식, 없으면 감싼 대화상자, 그것도 없으면 위로 올라가며 처음 만나는
// 입력 칸이 든 조상(최대 6단계). 클릭 처리기가 그 칸들을 읽어 보내는 양식 없는 화면을 잡는다.
function submitScopes(el: HTMLElement): FormlessScope[] {
  const control = activatedControl(el) ?? labelControl(el);
  const form = (control as HTMLInputElement | null)?.form ?? (closestAcross(el, "form") as HTMLFormElement | null);
  // 버튼·링크의 처리기는 자기 양식이 아니라 같은 대화상자·화면의 다른 양식을 requestSubmit할 수 있으니
  // (목적지가 있는 링크도 클릭 처리기에서 이동을 취소하고 제출할 수 있다) 바깥 범위의 양식 칸까지 본다.
  const outer = formlessScopes(el).map((s) => ({ ...s, includeFormFields: true }));
  return form ? [{ node: form, includeFormFields: true }, ...outer] : outer;
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
    return personalValuedInScopes(submitScopes(el));
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
    // 링크의 ping 주소(하이퍼링크 감사): 누르면 목적지 주소를 담아 ping 주소로도 요청이 간다.
    const pingLink = closestAcross(el, "a[ping], area[ping]");
    const pingUrls = pingLink
      ? (pingLink.getAttribute("ping") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((p) => {
            try {
              return new URL(p, pingLink.baseURI).href;
            } catch {
              return p;
            }
          })
      : [];
    // 클릭으로 바뀌는 checkbox·radio(직접 또는 label 연결)의 value가 주소면 그 주소도 목적지로 본다.
    const toggled = [control, linked].find((c) => !!c && isTag(c, "input") && ["checkbox", "radio"].includes((c as HTMLInputElement).type));
    const choiceUrls = toggled ? choiceUrlsOf(toggled as HTMLElement) : [];
    // 대상을 감싼 버튼·링크들(실제로 작동하는 바깥 컨트롤까지)의 글자를 모두 모은다.
    const outerText = enclosingControlTexts(el);
    // 양식 밖 버튼(이동 링크가 아닌 것)이면 범위 안 다른 양식들의 제출 주소도 목적지로 본다.
    // 양식 안 버튼이면 같은 양식의 다른 제출 버튼 주소(formaction)를 본다(처리기가 requestSubmit(숨은 버튼)).
    // 양식 밖 버튼과 양식 안 버튼 모두 범위 안 다른 양식들의 제출 주소를 본다(처리기가 다른 양식을 requestSubmit).
    const around = scopeSubmitUrls(submitScopes(el).filter((s) => s.includeFormFields && s.node !== form));
    const scopeForms = form
      ? (() => {
          const o = otherDestinations(form, submitTo);
          return {
            changed: [...(o.scopeSubmitUrls ?? []), ...around.changed.filter((u) => !(o.scopeSubmitUrls ?? []).includes(u))],
            actions: [...(o.scopeFormActions ?? []), ...around.actions.filter((u) => !(o.scopeFormActions ?? []).includes(u))],
          };
        })()
      : around;
    return {
      // 작동할 컨트롤(제출 버튼, 또는 label이 연결한 checkbox·radio) 자신이 실을 개인정보 값도 본다.
      submitsPersonal:
        (!!form && formHasPersonalValues(form)) ||
        // 양식 없는 화면(대화상자의 로그인 칸 + Continue 버튼 등)은 버튼 주변 입력 칸 묶음을 본다.
        // 양식 안 버튼도 같은 대화상자·화면의 다른 양식(처리기가 requestSubmit할 수 있다)을 함께 본다.
        personalValuedInScopes(submitScopes(el)).length > 0 ||
        controlHasPersonalValue(control ?? linked) ||
        // 클릭으로 체크되는 checkbox·radio가 비밀번호·인증번호·결제 칸이면(접근성 이름 단서 포함) 입력과 같이 본다.
        (!!toggled && !!sensitivityOf(toggled as HTMLElement)) ||
        [control, linked].some(
          (c) => !!c && isTag(c, "input") && ["checkbox", "radio"].includes(c.type) && isPersonalField(c) && !!c.value.trim(),
        ),
      // 작동할 컨트롤(버튼·제출 input, 클릭으로 바뀌는 checkbox·radio — 직접 또는 label 연결)의 name=value에
      // 결제 문구가 있으면(name="confirm_order") 결제 동작으로 본다.
      paymentContext:
        inPaymentContext(el, form) ||
        [control, linked].some(
          (c) =>
            !!c &&
            ["value", "name"].some((attr) => {
              const v = c.getAttribute(attr) ?? "";
              return PAYMENT_TEXT_RE.test(v) || PAYMENT_TEXT_RE.test(splitIdentifier(v));
            }),
        ),
      ...(submitTo ? { submitTo } : {}),
      ...(submitUrl ? { submitUrl } : {}),
      ...(ancestorHref ? { ancestorHref } : {}),
      ...(outerText ? { outerText } : {}),
      ...(scopeForms.changed.length ? { scopeSubmitUrls: scopeForms.changed } : {}),
      ...(scopeForms.actions.length ? { scopeFormActions: scopeForms.actions } : {}),
      ...(choiceUrls.length ? { choiceUrls } : {}),
      // 20개를 넘으면 끝까지 보지 못했다는 표시를 넣는다(늘 묻게 된다).
      ...(pingUrls.length ? { pingUrls: pingUrls.length > 20 ? [...pingUrls.slice(0, 20), "about:too-many-pings"] : pingUrls } : {}),
      ...(closestAcross(el, "a[download], area[download]") ? { download: true } : {}),
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
  captureHiddenBaselines();
  return scanTargets(() => collectClickables(args));
}

// 낱말이 여럿일 때 점수로 줄 세우기 전에 모을 최대 후보 수.
const MAX_RANKED_CANDIDATES = 400;

function collectClickables(args: FindClickablesArgs): ClickableElement[] {
  const limit = Math.min(args.limit ?? 50, 200);
  const terms = queryTerms(args.query);
  const ranked = terms.length > 1;
  const cap = ranked ? MAX_RANKED_CANDIDATES : limit;
  const found: Array<{ el: HTMLElement; item: Omit<ClickableElement, "id">; score: number }> = [];
  const seenKeys = new Set<string>();
  for (const root of getAccessibleRoots()) {
    if (found.length >= cap) break;
    const nodes = root.querySelectorAll<HTMLElement>(CLICK_SELECTOR);
    for (const el of nodes) {
      if (found.length >= cap) break;
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

      let score = 0;
      if (terms.length) {
        score = clickMatchScore(terms, text, href);
        if (!score) continue;
      }

      const key = `${tag}|${text}|${href}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      found.push({ el, item: { text, href, tag, role, region, inViewport }, score });
    }
  }

  // sort는 안정 정렬이라 점수가 같으면 문서 순서가 유지된다.
  if (ranked) found.sort((a, b) => b.score - a.score);
  return found.slice(0, limit).map(({ el, item }) => ({ id: registerTarget(CLICK_KIND, el), ...item }));
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
