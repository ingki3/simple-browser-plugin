import type { ClickableElement, PageRegion } from "@/lib/messages";
import type { TargetInfo } from "@/lib/actionTarget";
import { PAYMENT_TEXT_RE, splitIdentifier } from "@/lib/autoApprove";
import { clickMatchScore, queryTerms } from "@/lib/clickQuery";
import { getAccessibleRoots, isTag } from "./docs";
import { modelName } from "./modelText";
import {
  choiceUrlsOf,
  controlHasPersonalValue,
  formDestination,
  declaresDelete,
  deleteParamOf,
  opaqueRequestOf,
  requestUrlsOf,
  formHasPersonalValues,
  formSubmissionUrl,
  isPersonalField,
  captureHiddenBaselines,
  connectedLabelsText,
  toggleFieldRisk,
  personalValuedInScopes,
  proxyLabel,
  scopeSubmitUrls,
  otherDestinations,
  sensitivityOf,
  checkedInGroup,
  setNativeProperty,
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
  choiceRelation,
  detectRegion,
  expandedTriggers,
  isChoice,
  recheckApproved,
  registerTarget,
  registeredInfo,
  scanTargets,
  startEffectWatch,
  statesOf,
  takeApproved,
  type Relation,
  type TargetKind,
} from "./targets";
import { VALUE_CONTROL_TAGS } from "@/lib/modelText";
import type { TrustedPrepare } from "@/lib/trustedClick";
import { armTopGuard, choosePoint, type RecheckPhase } from "./trustedClick";

const BASE_SELECTOR =
  'a[href], button, [role="button"], [role="link"], input[type="button"], input[type="submit"]';
// 목록에서 고르는 위젯(#43 B): 선택지·메뉴 항목·탭과 비편집 선택 팝업 트리거. 구조(ARIA 역할)로만 정한다.
// aria-haspopup="true"는 메뉴를 뜻하므로 트리거로 더하지 않는다(그런 버튼은 button이라 이미 잡힌다).
// input이 아닌 체크 위젯(role=checkbox·switch·radio — 메일 목록의 꾸민 행 체크박스 등, #56)도 더한다. 지금 상태는
// states.checked(aria-checked)로 돌려주고 대상 비교에 고정한다(승인 뒤 이미 바뀌었으면 누르면 반대가 되므로).
const ROLE_SELECTOR =
  '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="combobox"], [aria-haspopup="listbox" i], [role="checkbox"], [role="switch"], [role="radio"]';
// 진짜 checkbox·radio(필터 대화상자의 선택지 등). 보이면 그 칸을, 화면에서 숨겼으면(투명·잘라 냄) 구조로 연결된 보이는
// label(forms.ts proxyLabel, #56)을 클릭 대상으로 돌려준다. 지금 상태는 checked 속성값으로 states.checked에 넣는다(targets.ts).
const TOGGLE_SELECTOR = 'input[type="checkbox" i], input[type="radio" i]';
const CLICK_SELECTOR = `${BASE_SELECTOR}, ${ROLE_SELECTOR}, ${TOGGLE_SELECTOR}`;

function isToggleInput(el: Element): el is HTMLInputElement {
  return isTag(el, "input") && (el.type === "checkbox" || el.type === "radio");
}

// 사용자에게 드러난 클릭 대상인지: 레이아웃상 보이고(크기·display·visibility·opacity) aria-hidden 영역 안이 아니다.
// 입력 칸의 보임(forms.ts layoutVisible)과 달리 aria-hidden 안의 요소는 클릭 후보로 내지 않는다.
function shownToUser(el: HTMLElement): boolean {
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
  // checkbox·radio의 value는 이름이 아니다(제출 값). 연결된 label 글자·aria-label·title로 부른다.
  if (isToggleInput(el)) {
    return cleanText(
      Array.from(el.labels ?? [], (l) => l.textContent ?? "").join(" ") ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        "",
    );
  }
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
  // 대상에 연결된 모든 label의 전체 글자도 본다(바깥 label[for]의 200자 뒤 '구매 확정' — 보여 주는 이름은 잘려도 판정은 전체로).
  const texts: string[] = [accessibleNames(el), connectedLabelsText(el)];
  for (let cur = parentAcrossShadow(el); cur; cur = parentAcrossShadow(cur)) {
    const c = closestAcross(cur, CONTROL_SELECTOR);
    if (!c) break;
    // 바깥 컨트롤도 전체 글자로 본다(clickText는 200자로 자른다).
    texts.push(((c as HTMLElement).innerText || c.textContent || "").replace(/\s+/g, " "), accessibleNames(c));
    cur = c;
  }
  // label을 누르면 연결된 컨트롤이 작동하므로 그 이름도 본다.
  const control = labelControl(el);
  if (control) {
    texts.push(
      (control.innerText || control.textContent || "").replace(/\s+/g, " "),
      accessibleNames(control),
      connectedLabelsText(control),
    );
  }
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
  visible: shownToUser,
  requireVisible: true,
  name: clickText,
  modelName: (el) => modelName(el),
  detail: true,
  fieldType: () => "",
  sensitive: () => null,
  // 누르면 작동할 컨트롤의 양식에서 값이 채워진 개인정보·비밀 칸들(승인 뒤 새로 채워졌는지 보려고).
  personalElements: (el) => {
    return personalValuedInScopes(submitScopes(el));
  },
  // label 안 요소를 누르면 작동하는 checkbox·radio가 화면에서 숨긴 칸이면, 그 label이 숨긴 칸을 대신 보여 주는 것이다(#56).
  // 채우기의 대리 label 칸처럼 표시하고(proxy) 늘 묻는다(autoApproveBlock).
  proxyLabelName: (el) => {
    const t = hiddenToggleBehind(el);
    return t ? modelName(el, 200) : null;
  },
  risk: (el) => withToggleRisk(el, clickOnlyRisk(el)),
};

type ClickRisk = NonNullable<ReturnType<NonNullable<TargetKind["risk"]>>>;

function isToggleEl(c: Element | null | undefined): c is HTMLInputElement {
  return !!c && isTag(c, "input") && (c.type === "checkbox" || c.type === "radio");
}

// 대상을 누르면 작동하는 다른 checkbox·radio(감싼 label 또는 label[for]로 연결된 칸). 대상 자신이 그 칸이면 null.
function toggleBehind(el: HTMLElement): HTMLInputElement | null {
  const c = activatedControl(el) ?? labelControl(el);
  return isToggleEl(c) && c !== el ? c : null;
}

function hiddenToggleBehind(el: HTMLElement): HTMLInputElement | null {
  const t = toggleBehind(el);
  return t && !shownToUser(t) ? t : null;
}

// label 등을 눌러 다른 checkbox·radio가 작동하면, 누르는 자리의 신호에 더해 그 칸 자신의 자리 신호(칸이 든 결제 대화상자·
// 양식·개인정보·삭제·htmx·감싼 링크 — forms.ts toggleFieldRisk, 채우기 판정과 같은 것)를 합친다(더 묻는 쪽만).
// 칸이 개인정보·비밀번호·결제 칸이면 클릭 판정이 보는 개인정보 제출로 넣는다. 칸 쪽의 감싼 링크 주소는 누르는 자리의
// 감싼 링크와 다르면 선택지 주소(choiceUrls)로 넣는다(같은 사이트 경계·결제·개인정보·삭제 주소 판정을 받는다).
function withToggleRisk(el: HTMLElement, risk: ClickRisk): ClickRisk {
  const t = toggleBehind(el);
  if (!t) return risk;
  const f = toggleFieldRisk(t);
  const list = (a: string[] | undefined, b: string[] | undefined) => {
    const out = [...(a ?? [])];
    for (const u of b ?? []) if (!out.includes(u)) out.push(u);
    return out;
  };
  const choiceUrls = list(risk.choiceUrls, [...(f.choiceUrls ?? []), ...(f.ancestorHref && f.ancestorHref !== risk.ancestorHref ? [f.ancestorHref] : [])]);
  const scopeSubmitUrls = list(risk.scopeSubmitUrls, f.scopeSubmitUrls);
  const scopeFormActions = list(risk.scopeFormActions, f.scopeFormActions);
  const aroundFormActions = list(risk.aroundFormActions, f.aroundFormActions);
  const pingUrls = list(risk.pingUrls, f.pingUrls);
  const requestUrls = list(risk.requestUrls, f.requestUrls);
  const outerText = [risk.outerText ?? "", f.outerText ?? ""].filter(Boolean).join(" ");
  return {
    ...risk,
    submitsPersonal: !!risk.submitsPersonal || !!f.submitsPersonal || !!f.personal || !!f.sensitive,
    paymentContext: !!risk.paymentContext || !!f.paymentContext,
    ...(!risk.ancestorHref && f.ancestorHref ? { ancestorHref: f.ancestorHref } : {}),
    ...(risk.insideControl || f.insideControl ? { insideControl: true } : {}),
    ...(risk.download || f.download ? { download: true } : {}),
    ...(risk.deleteMethod || f.deleteMethod ? { deleteMethod: true } : {}),
    ...(risk.deleteParam || f.deleteParam ? { deleteParam: true } : {}),
    ...(risk.opaqueRequest || f.opaqueRequest ? { opaqueRequest: true } : {}),
    ...(outerText ? { outerText } : {}),
    ...(choiceUrls.length ? { choiceUrls } : {}),
    ...(scopeSubmitUrls.length ? { scopeSubmitUrls } : {}),
    ...(scopeFormActions.length ? { scopeFormActions } : {}),
    ...(aroundFormActions.length ? { aroundFormActions } : {}),
    ...(pingUrls.length ? { pingUrls } : {}),
    ...(requestUrls.length ? { requestUrls } : {}),
  };
}

// 개인정보·비밀번호·결제 값이 채워진 양식 안의 버튼이면 제출로 본다(제출 버튼이 아니어도 스크립트로 보내는 양식이 있어 넓게 잡는다).
function clickOnlyRisk(el: HTMLElement): ClickRisk {
  const control = activatedControl(el);
  // label이 연결한 컨트롤(checkbox·radio 포함)도 누르면 작동하므로 그 양식과, 작동 뒤 실릴 값을 본다.
  const linked = control ? null : labelControl(el);
  const linkedForm = linked && "form" in linked ? ((linked as HTMLInputElement).form ?? null) : null;
  const form = control?.form ?? linkedForm ?? (closestAcross(el, "form") as HTMLFormElement | null);
  const submitTo = formDestination(control ?? el, form);
  const submitUrl = form && submitTo ? formSubmissionUrl(form, submitTo, control ?? linked) : "";
  // 링크 안의 요소(<a><span role=button>)를 누르면 바깥 링크가 열리므로 그 주소도 목적지로 본다.
  const ancestorHref = enclosingLinkHref(el);
  // 대상이 클릭 이벤트 경로의 다른 컨트롤(버튼·버튼 역할·summary·label·인라인 클릭 처리기) 안에 있는지.
  // 그 바깥 처리기가 이동을 취소하고 다른 동작을 할 수 있어, 링크 이동 허락(grantableLink)에서 뺀다.
  const parent = eventParent(el);
  const insideControl =
    !!parent &&
    !!closestAcross(
      parent,
      'button, input[type=submit], input[type=image], input[type=button], input[type=reset], [role="button"], summary, label, [onclick]',
    );
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
    ...(insideControl ? { insideControl: true } : {}),
    ...(outerText ? { outerText } : {}),
    ...(scopeForms.changed.length ? { scopeSubmitUrls: scopeForms.changed } : {}),
    ...(scopeForms.actions.length ? { scopeFormActions: scopeForms.actions } : {}),
    ...(choiceUrls.length ? { choiceUrls } : {}),
    // 20개를 넘으면 끝까지 보지 못했다는 표시를 넣는다(늘 묻게 된다).
    ...(pingUrls.length ? { pingUrls: pingUrls.length > 20 ? [...pingUrls.slice(0, 20), "about:too-many-pings"] : pingUrls } : {}),
    ...(closestAcross(el, "a[download], area[download]") ? { download: true } : {}),
    ...(declaresDelete(el, [control, linked], form) ? { deleteMethod: true } : {}),
    // 누른 제출 버튼·클릭으로 바뀌는 checkbox·radio의 name=value, 양식의 숨은 칸, htmx 요청 주소의 삭제 단서(#62).
    ...(deleteParamOf(el, control, [control, linked], form) ? { deleteParam: true } : {}),
    // 확인할 수 없는 htmx 요청(GET 아님·from: 리스너·요청 변형 속성 — #62 fail-closed).
    ...(opaqueRequestOf(el, control, [control, linked], form) ? { opaqueRequest: true } : {}),
    // 누르면 일으킬 수 있는 htmx GET 요청의 목적지(hx-get hx-trigger="click" 등 — 승인 판정이 목적지로 본다).
    ...(() => {
      const requestUrls = requestUrlsOf(el, control, [control, linked], form);
      return requestUrls.length ? { requestUrls } : {};
    })(),
  };
}

// 대상을 직접 누를 때의 위험 신호. checkbox·radio 채우기(forms.ts toggleClickRisk)도 칸을 실제로 누르므로 같은 판정을 쓴다.
export function clickRiskOf(el: HTMLElement): ClickRisk {
  return clickOnlyRisk(el);
}

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

function collectClickables(args: FindClickablesArgs): ClickableElement[] {
  const limit = Math.min(args.limit ?? 50, 200);
  const terms = queryTerms(args.query);
  // 낱말이 여럿이면 모든 요소를 보며 점수 상위 limit개만 남긴다(앞쪽 상품 링크 수백 개에 밀려
  // footer의 '주문/배송 조회'가 빠지지 않게). 낱말이 하나 이하면 예전처럼 문서 순서로 limit개에서 멈춘다.
  const ranked = terms.length > 1;
  const found: Array<{
    el: HTMLElement;
    item: Omit<ClickableElement, "id">;
    relation: Relation | null;
    score: number;
  }> = [];
  const full = () => !ranked && found.length >= limit;
  // 같은 요소만 합친다(한 문서의 querySelectorAll은 요소를 한 번씩만 준다). 글자·주소가 같아도 다른 요소면 따로
  // 돌려준다(두 달 달력의 같은 날짜, 상품 행마다 있는 같은 버튼). 모델은 묶음 문맥(context)으로 구분한다.
  let expanded: HTMLElement[] | null = null;
  // 이미 돌려준 요소(숨긴 checkbox의 label이 다른 선택자로도 잡히는 경우 등 — 한 번만).
  const seen = new Set<HTMLElement>();
  for (const root of getAccessibleRoots()) {
    if (full()) break;
    const nodes = root.querySelectorAll<HTMLElement>(CLICK_SELECTOR);
    for (const node of nodes) {
      if (full()) break;
      // 진짜 checkbox·radio: 보이면 그 칸, 숨겼으면 대신 보여 주는 label을 누른다(그 label은 누르면 이 칸이 작동한다).
      // 값(value)은 보내지 않는다 — 이름은 modelName(label 글자), 상태는 checked뿐이다(#43). 비활성 칸은 뺀다.
      const toggle = isToggleInput(node) ? node : null;
      if (toggle?.disabled) continue;
      const el: HTMLElement | null = toggle ? (shownToUser(toggle) ? toggle : proxyLabel(toggle)) : node;
      if (!el || seen.has(el)) continue;
      if (!shownToUser(el)) continue;
      // 역할로만 잡힌 새 대상에서 값 컨트롤·편집 영역은 뺀다(편집형 combobox의 입력값이 클릭 대상 글자로 나가지 않게;
      // 그런 칸은 find_form_fields의 값 미전송 계약을 따른다). checkbox·radio는 값을 보내지 않으므로 편집 영역만 뺀다.
      const roleOnly = !el.matches(BASE_SELECTOR);
      if (toggle ? el.isContentEditable : roleOnly && (VALUE_CONTROL_TAGS.has(el.localName) || el.isContentEditable)) continue;
      seen.add(el);

      const inViewport = rectInViewport(el);
      if (args.onlyViewport && !inViewport) continue;

      const region = detectRegion(el);
      if (args.region && region !== args.region) continue;

      const tag = el.tagName.toLowerCase();
      // checkbox·radio(또는 그것을 대신 누르는 label)는 칸 종류를 role로 알려 준다(구조 — input의 type).
      const role = el.getAttribute("role") || (toggle ? toggle.type : "");
      const href = isTag(el, "a") ? el.href : "";
      // 모델에 돌려주는 글자(입력 칸·편집 영역·숨은 글자 제외). 검색어 필터도 이 글자로 본다(#43).
      const text = modelName(el);
      // 역할 기반 대상은 글자가 비어도 돌려준다(role·상태로 구분). 기존 대상은 글자·주소가 모두 비면 뺀다.
      if (!text && !href && !roleOnly) continue;

      let score = 0;
      if (terms.length) {
        score = clickMatchScore(terms, text, href);
        if (!score) continue;
      }

      // 선택지(option·menuitem*)는 펼친 트리거와의 관계를 정할 수 있을 때만 돌려준다(targets.ts의 choiceRelation).
      let relation: Relation | null = null;
      if (isChoice(el)) {
        expanded ??= expandedTriggers();
        relation = choiceRelation(CLICK_KIND, el, expanded);
        if (!relation) continue;
      }

      const entry = { el, item: { text, href, tag, role, region, inViewport }, relation, score };
      if (!ranked) {
        found.push(entry);
        continue;
      }
      // 점수 내림차순을 유지하며 넣는다. 같은 점수면 먼저 나온 것(문서 순서)이 앞이다.
      if (found.length >= limit && score <= found[found.length - 1].score) continue;
      let i = found.length;
      while (i > 0 && found[i - 1].score < score) i -= 1;
      found.splice(i, 0, entry);
      if (found.length > limit) found.pop();
    }
  }

  return found.map(({ el, item, relation }) => {
    const id = registerTarget(CLICK_KIND, el, relation);
    const info = registeredInfo(id);
    return {
      id,
      ...item,
      ...(info?.modelContext ? { context: info.modelContext } : {}),
      ...(info?.states ? { states: info.states } : {}),
    };
  });
}

// 승인 카드에서 확인한 그 요소일 때만 누른다. 결과 관찰은 클릭 직전에 시작해 백그라운드가 action_effect로 읽는다.
// trusted(가드 토큰)가 있으면 실제 입력 클릭(0.2.0)으로 준비만 한다: 누를 점을 계산하고 가드를 건 뒤 돌려주고, 누르기는
// 백그라운드가 chrome.debugger로 한다. 실제 입력을 쓸 수 없는 대상(iframe 안, 보이는 사각형 없음, 대상 안의 다른 활성
// 요소가 점을 받음)이면 지금처럼 스크립트로 누른다.
export function clickElement(
  args: { id: string },
  callId: string,
  trusted?: string,
): { clicked: boolean; text: string; href: string; effectToken: string; trusted?: TrustedPrepare } {
  const { el, info, relation } = takeApproved(args.id, callId, CLICK_KIND.prefix);
  const text = info.modelName ?? "";
  const href = isTag(el, "a") ? el.href : "";
  const effectToken = `${callId}:${Date.now()}`;

  if (trusted) {
    scrollToCenter(el);
    const changed = recheckApproved(CLICK_KIND, el, info, relation);
    if (changed) {
      startEffectWatch(effectToken, el, changed);
      return { clicked: true, text, href, effectToken, trusted: { mode: "aborted" } };
    }
    // 대상에 닿는 점을 고른다(#89 — 가운데가 고정 바 등에 덮였으면 다른 자리). 모든 점이 덮였거나 대상 안의 다른 활성 요소가
    // 받으면 실제 입력 대신 스크립트 클릭으로 누른다(사용자 결정 — 설정을 켜기 전과 같은 동작, 결과 줄에 이유).
    let point: { x: number; y: number } | null = null;
    let reason: string | null = null;
    if (el.ownerDocument !== document) reason = "iframe 안의 대상";
    else {
      const chosen = choosePoint(el);
      if (!chosen) reason = "화면에 보이는 사각형이 없는 대상";
      else if (!chosen.ok) reason = chosen.reason;
      else point = chosen.point;
    }
    if (reason || !point) {
      const why = reason ?? "누를 점 없음";
      setTimeout(() => scriptClick(el, info, relation, effectToken, false), 0);
      return { clicked: true, text, href, effectToken, trusted: { mode: "script", reason: why } };
    }
    startEffectWatch(effectToken, el);
    // click 단계에서 대상(또는 label의 컨트롤)이 checkbox·radio면 브라우저가 처리기보다 먼저 체크 상태를 바꿔 양식 값(제출 주소)도 달라진다.
    // 그 변화를 잠깐 되돌린 상태로(승인 때와 같은 체크 상태에서) 확인한다.
    // label이면 연결된 checkbox·radio(투명한 칸이 label을 덮어 실제 입력이 칸에 닿는 경우)도 같다.
    const control = isTag(el, "label") ? (el as HTMLLabelElement).control : null;
    const toggleEl = isToggleInput(el) ? el : control && isToggleInput(control) ? control : null;
    const toggle = toggleEl
      ? { checked: toggleEl.checked, indeterminate: toggleEl.indeterminate, prevRadio: toggleEl.type === "radio" ? checkedInGroup(toggleEl) : null }
      : null;
    // click 단계 확인은 체크 상태를 승인 때로 되돌린 채(asApproved) 하므로 "up"과 같은 기준으로 본다.
    armTopGuard(
      trusted,
      el,
      point,
      (phase) => recheckApproved(CLICK_KIND, el, phaseInfo(el, info, phase === "click" ? "up" : phase), relation),
      (check) => (toggleEl && toggle ? withToggleReverted(toggleEl, toggle, check) : check()),
    );
    return { clicked: true, text, href, effectToken, trusted: { mode: "trusted", x: point.x, y: point.y } };
  }

  // Defer actual click so the content-script response can fly back to the
  // background before a potential navigation tears down this context.
  setTimeout(() => scriptClick(el, info, relation, effectToken, true), 0);

  return { clicked: true, text, href, effectToken };
}

// 실제 입력의 단계별 재확인에 쓸 승인 기술.
// - down: 그대로(엄격).
// - up·click: 앞 단계의 페이지 처리기가 바꾼 화면 상태(aria 펼침·눌림·선택 등)는 받아들인다. 체크 상태와 주소·양식·위험
//   신호는 그대로 비교한다(대상 자신이 checkbox·radio인 click 단계는 withToggleReverted로 승인 때 체크 상태에서 본다).
function phaseInfo(el: HTMLElement, info: TargetInfo, phase: RecheckPhase): TargetInfo {
  if (phase === "down") return info;
  const { checked: _now, ...ui } = statesOf(el) ?? {};
  const checked = info.states?.checked;
  const states = { ...ui, ...(checked !== undefined ? { checked } : {}) };
  return { ...info, states: Object.keys(states).length ? states : undefined };
}

// 체크 상태를 준비 때(승인 때와 같은지 이미 확인한 상태)로 잠깐 되돌려 check를 부르고 지금 상태로 되살린다.
// 속성 setter를 직접 써서(프레임워크의 값 추적·이벤트를 건드리지 않음) 동기로만 바꾼다. 상태가 그대로면 그냥 부른다.
// radio의 직전 체크(prevRadio)는 지금도 대상과 같은 그룹일 때만 되돌린다. 클릭 도중 페이지가 name을 바꿔 다른 그룹이
// 됐으면 그것을 체크하면 그 그룹의 체크가 풀리므로 건드리지 않는다(#83) — 그러면 확인은 승인 때와 다른 상태를 보게 되어
// 더 묻는 쪽(클릭 중단)으로만 달라진다.
function withToggleReverted(
  el: HTMLInputElement,
  before: { checked: boolean; indeterminate: boolean; prevRadio: HTMLInputElement | null },
  check: () => string | null,
): string | null {
  const now = { checked: el.checked, indeterminate: el.indeterminate, prev: el.type === "radio" ? checkedInGroup(el) : null };
  if (now.checked === before.checked && now.indeterminate === before.indeterminate && now.prev === before.prevRadio) return check();
  const prev = el.type === "radio" && before.prevRadio && sameRadioGroup(before.prevRadio, el) ? before.prevRadio : null;
  const restore = () => {
    if (el.type === "radio") {
      // 직전 체크를 되돌렸으면(같은 그룹) 지금 그룹의 체크로 되살린다. 그 사이 다른 칸이 체크돼 있었으면 그것을, 없으면 해제.
      if (prev) {
        if (now.prev) setNativeProperty(now.prev, "checked", true);
        else setNativeProperty(prev, "checked", false);
      }
      setNativeProperty(el, "checked", now.checked);
    } else {
      setNativeProperty(el, "checked", now.checked);
      el.indeterminate = now.indeterminate;
    }
  };
  try {
    if (el.type === "radio") {
      setNativeProperty(el, "checked", before.checked);
      if (prev) setNativeProperty(prev, "checked", true);
    } else {
      setNativeProperty(el, "checked", before.checked);
      el.indeterminate = before.indeterminate;
    }
    return check();
  } finally {
    restore();
  }
}

// 두 radio가 지금 같은 그룹인지(같은 name, 같은 양식, 양식이 없으면 같은 문서·shadow root).
function sameRadioGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  return !!a.name && a.name === b.name && a.form === b.form && (a.form !== null || a.getRootNode() === b.getRootNode());
}

function scrollToCenter(el: HTMLElement): void {
  try {
    el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      /* ignore */
    }
  }
}

function scriptClick(
  el: HTMLElement,
  info: TargetInfo,
  relation: Relation | null,
  effectToken: string,
  scroll: boolean,
): void {
  if (scroll) scrollToCenter(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  // 스크롤·포커스 처리기가 대상을 바꿨을 수 있으니 누르기 바로 앞에서 다시 본다. 같은 실행 흐름 안이라
  // 이 확인과 클릭 사이에는 페이지 코드가 끼어들지 않는다. 바뀌었으면 누르지 않고 결과로 알린다.
  const changed = recheckApproved(CLICK_KIND, el, info, relation);
  // 스크롤·포커스로 생긴 변화는 빼고 클릭 뒤의 변화만 센다.
  startEffectWatch(effectToken, el, changed);
  if (changed) return;
  try {
    el.click();
  } catch (err) {
    console.warn("[click_element] click threw", err);
  }
}
