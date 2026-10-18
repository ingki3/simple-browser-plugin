import type { FormField } from "@/lib/messages";
import {
  FIELD_PAYMENT_HINT_RE as PAYMENT_RE,
  PAYMENT_TEXT_RE,
  PERSONAL_HINT_RE,
  SECRET_HINT_RE,
  decodeDeepText,
  looksPersonalValue,
  splitIdentifier,
} from "@/lib/autoApprove";
import { formlessScopes, inPaymentContext, openShadowRootsIn } from "./context";
import type { TargetInfo } from "@/lib/actionTarget";
import { getAccessibleRoots, isTag } from "./docs";
import { noteWritten, peekApproved, recheckApproved, registerTarget, scanTargets, takeApproved, type TargetKind } from "./targets";

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image", "file"]);
const TRUTHY_VALUES = /^(true|1|on|yes|y|checked|check|예|네|체크|선택)$/i;

type FieldElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function isFieldElement(el: Element): el is FieldElement {
  return isTag(el, "input") || isTag(el, "textarea") || isTag(el, "select");
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  return true;
}

// label 안에 든 입력 요소의 글자(select의 선택지 등)는 빼고 label 자신의 글자만 읽는다.
function labelText(label: HTMLLabelElement): string {
  const copy = label.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("select, textarea, input, button").forEach((n) => n.remove());
  return (copy.textContent ?? "").trim();
}

function resolveLabel(el: FieldElement): string {
  // shadow root 안의 필드는 label도 같은 shadow root 안에 있다.
  const root = el.getRootNode() as Document | ShadowRoot;
  if (el.id) {
    const byFor = root.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    const text = byFor ? labelText(byFor) : "";
    if (text) return text;
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const wrappingLabel = el.closest("label");
  const wrapped = wrappingLabel ? labelText(wrappingLabel) : "";
  if (wrapped) return wrapped;
  if (!isTag(el, "select")) return el.placeholder?.trim() ?? "";
  return "";
}

function describeType(el: FieldElement): string {
  if (isTag(el, "input")) return el.type || "text";
  if (isTag(el, "textarea")) return "textarea";
  return "select";
}


function sensitivityOf(el: HTMLElement): TargetInfo["sensitive"] {
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if ((isTag(el, "input") && el.type === "password") || /password|one-time-code/.test(ac)) return "password";
  if (/\bcc-/.test(ac)) return "payment";
  const hint = splitIdentifier(`${el.getAttribute("name") ?? ""} ${el.id} ${isFieldElement(el) ? resolveLabel(el) : ""}`);
  if (PAYMENT_RE.test(hint)) return "payment";
  // 비밀번호 표시로 type이 text가 된 칸, 일회용 인증 코드 칸도 비밀 값으로 본다.
  if (SECRET_HINT_RE.test(hint)) return "password";
  return null;
}

// 개인정보 칸: 이름·연락처·주소·생년월일·신분 번호·계좌 등. 자동 실행을 켜도 이런 칸에 채우는 것은 묻는다.
const PERSONAL_AC_RE =
  /\b(name|given-name|family-name|additional-name|honorific-\w+|nickname|email|tel|tel-\w+|street-address|address-line\d|address-level\d|postal-code|bday|bday-\w+|sex|username)\b/;

export function isPersonalField(el: HTMLElement): boolean {
  if (!isFieldElement(el)) return false;
  if (isTag(el, "input") && (el.type === "email" || el.type === "tel")) return true;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (PERSONAL_AC_RE.test(ac)) return true;
  const hint = splitIdentifier(`${el.getAttribute("name") ?? ""} ${el.id} ${resolveLabel(el)}`);
  return PERSONAL_HINT_RE.test(hint);
}

// 양식의 컨트롤 목록·action은 이름이 elements·action인 칸이 가릴 수 있어(form.elements가 그 칸을 돌려줌)
// 플랫폼 접근자로 직접 읽는다.
function nativeGetter<T>(proto: object, prop: string, obj: object): T | undefined {
  const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
  return get ? (get.call(obj) as T) : undefined;
}

function formElements(form: HTMLFormElement): Element[] {
  const list = nativeGetter<HTMLFormControlsCollection>(HTMLFormElement.prototype, "elements", form);
  return list ? Array.from(list) : [];
}

function formAction(form: HTMLFormElement): string {
  return nativeGetter<string>(HTMLFormElement.prototype, "action", form) ?? "";
}

// 양식이 실제로 제출되는 주소: 버튼에 formaction 속성이 있으면 그것, 없으면 양식 action(둘 다 절대 주소).
// formAction은 속성이 없을 때 지금 문서 주소를 돌려주므로 속성이 있을 때만 쓴다.
export function formDestination(el: HTMLElement, form: HTMLFormElement | null): string {
  if (!form) return "";
  if (el.hasAttribute("formaction") && "formAction" in el) return (el as HTMLButtonElement).formAction;
  return formAction(form);
}

const MAX_CHOICE_URLS = 50;
// 검사 한도를 넘었다는 표시. 웹 주소가 아니라 사이트 경계 판정에서 늘 "밖"으로 걸린다(묻기).
const TOO_MANY_CHOICES = "about:too-many-url-choices";

// 주소로 쓰일 수 있는 값: 스킴·/·\로 시작하거나, 상대 경로처럼 /·?·=·%·:가 섞인 값(redirect?next=…).
// "ko", "seoul" 같은 평범한 값은 아니다.
function urlLike(v: string, doc: Document): string | null {
  // 인코딩된 값(https%3A%2F%2F…)은 먼저 풀어 본다(change 처리기·서버가 풀어 쓰는 경우).
  const s = decodeDeep(v);
  if (!s || !/^(https?:|javascript:|data:|\/|\\)|[/?=%:]/i.test(s)) return null;
  // 다 풀고도 인코딩된 주소 흔적이 남으면 목적지를 확인할 수 없다(사이트 경계에서 늘 밖 → 묻기).
  if (/%3a|%2f%2f|%5c/i.test(s)) return "about:undecodable";
  if (/^javascript:|^data:/i.test(s)) return s;
  try {
    return new URL(s, doc.baseURI).href;
  } catch {
    return s;
  }
}

// 입력으로 실제 들어갈 수 있는 값 중 주소처럼 보이는 것: select의 모든 선택지, checkbox·radio의 value.
export function choiceUrlsOf(el: HTMLElement): string[] {
  const values = isTag(el, "select")
    ? Array.from(el.options, (o) => o.value)
    : isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")
      ? [el.value]
      : [];
  const out: string[] = [];
  for (const v of values) {
    const u = urlLike(v, el.ownerDocument);
    if (!u) continue;
    if (out.length >= MAX_CHOICE_URLS) return [...out, TOO_MANY_CHOICES];
    out.push(u);
  }
  return out;
}

// 양식을 지금 값으로 제출하면 요청하는 주소(action + 칸 값을 쿼리로). GET 양식은 실제로 이 주소로 가고,
// POST 양식도 값에 실린 주소(리다이렉트 매개변수 next=https://…)를 같은 방식으로 검사하려고 쿼리로 붙인다.
// FormData는 페이지에 formdata 이벤트를 일으키므로(그 처리기가 전송할 수 있다) 쓰지 않고 칸 값을 직접 읽는다.
// submitter가 있으면 그 버튼의 name=value도 넣는다(실제 제출에 포함된다).
export function formSubmissionUrl(form: HTMLFormElement, action: string, submitter?: Element | null): string {
  if (!action) return "";
  let u: URL;
  try {
    u = new URL(action);
  } catch {
    return action;
  }
  for (const el of formElements(form)) {
    if (!isFieldElement(el as HTMLElement)) continue;
    const f = el as FieldElement;
    if (!f.name || f.disabled) continue;
    if (isTag(f, "input")) {
      if (["submit", "button", "image", "reset", "file"].includes(f.type)) continue;
      if ((f.type === "checkbox" || f.type === "radio") && !f.checked) continue;
    }
    if (isTag(f, "select")) {
      for (const o of Array.from(f.selectedOptions)) u.searchParams.append(f.name, o.value);
      continue;
    }
    u.searchParams.append(f.name, f.value ?? "");
  }
  if (submitter && (isTag(submitter, "button") || isTag(submitter, "input"))) {
    const b = submitter as HTMLButtonElement | HTMLInputElement;
    if (b.name) u.searchParams.append(b.name, b.value ?? "");
  }
  return u.href;
}

// 제출 버튼 자신의 name=value에 개인정보·비밀 값이 실려 있는지(<button name="email" value="a@b.c">).
export function controlHasPersonalValue(control: Element | null): boolean {
  if (!control || !(isTag(control, "button") || isTag(control, "input"))) return false;
  const b = control as HTMLButtonElement | HTMLInputElement;
  const value = (b.value ?? "").trim();
  if (!value) return false;
  // 값 자체가 개인정보 모양이면 name이 없어도(스크립트가 값을 읽어 보내는 경우) 개인정보로 본다.
  if (looksPersonalValue(value)) return true;
  if (!b.name) return false;
  const hint = splitIdentifier(`${b.name} ${b.id}`);
  return (
    PERSONAL_HINT_RE.test(hint) ||
    SECRET_HINT_RE.test(hint) ||
    PAYMENT_RE.test(hint) ||
    // 이름에 개인정보 단서가 있으면 긴 숫자 묶음도 개인정보로 본다(선형 시간 검사).
    /\d[\d\s-]{7,}\d/.test(value.slice(0, 2000))
  );
}

// 값을 여러 번 인코딩한 경우까지 풀어 본다(https%253A%252F%252F…).
// 공통 디코더(잘못된 %ZZ가 섞여도 올바른 %XX는 푼다)를 쓴다.
function decodeDeep(v: string): string {
  return decodeDeepText(v.trim());
}

function urlLikeValue(v: string): boolean {
  const s = decodeDeep(v);
  return /^[/\\]|^[a-z][a-z0-9+.-]*:|:[/\\]{2}|[/?=]/i.test(s);
}

// 제출 주소의 매개변수 값 중 주소로 쓰일 수 있는 것(풀어 쓴 값). 입력 직전 새로 생겼는지 보려고.
function urlLikeParams(submitUrl: string): Set<string> {
  const out = new Set<string>();
  try {
    new URL(submitUrl).searchParams.forEach((v) => {
      if (urlLikeValue(v)) out.add(decodeDeep(v));
    });
  } catch {
    /* ignore */
  }
  return out;
}

// 제출 주소의 매개변수 값 중 개인정보 모양인 것(입력 도중 새로 생겼는지 보려고).
function personalParams(submitUrl: string): Set<string> {
  const out = new Set<string>();
  try {
    new URL(submitUrl).searchParams.forEach((v) => {
      if (looksPersonalValue(decodeDeep(v))) out.add(decodeDeep(v));
    });
  } catch {
    /* ignore */
  }
  return out;
}

// 값이 채워진 개인정보·비밀번호·결제 칸이 있는 양식인지(그 양식의 버튼은 자동 실행하지 않는다).
// 제출되는 값이면 종류를 가리지 않는다: 숨은 칸(로그인한 사용자 이메일 등)·선택 칸(생년월일)·체크한 칸도 본다.
export function formHasPersonalValues(form: HTMLFormElement): boolean {
  return personalValuedElements(form).length > 0;
}

// 값이 채워진 개인정보·비밀번호·결제 칸들.
export function personalValuedElements(
  scope: HTMLFormElement | Element | ShadowRoot,
  includeFormFields = false,
): Element[] {
  const out: Element[] = [];
  // 양식이면 그 컨트롤 목록. 대화상자면 그 안의 모든 입력 칸(바깥 버튼이 안쪽 양식을 requestSubmit하는 경우 포함).
  // 그 밖의 양식 없는 범위면 어느 양식에도 속하지 않은 칸만(양식에 속한 칸은 그 양식이 제출할 때만 나간다 —
  // 넓은 조상 범위에서 주변의 다른 양식까지 끌어오지 않게).
  const isElement = "localName" in scope;
  const isDialog =
    isElement &&
    ((scope as Element).localName === "dialog" || /^(dialog|alertdialog)$/.test((scope as Element).getAttribute("role") ?? ""));
  let fields: Element[];
  if (isElement && isTag(scope as Element, "form")) {
    fields = formElements(scope as HTMLFormElement);
    // 양식 안 웹 컴포넌트의 열린 shadow root 칸도 본다(컴포넌트가 그린 비밀번호 칸 — 제출 처리기가 읽어 보낸다).
    for (const root of openShadowRootsIn(scope as Element)) {
      for (const c of Array.from(root.querySelectorAll("input, textarea, select"))) if (!fields.includes(c)) fields.push(c);
    }
  } else {
    const withForms = isDialog || includeFormFields;
    fields = Array.from(scope.querySelectorAll("input, textarea, select")).filter(
      (f) => withForms || !(f as HTMLInputElement).form,
    );
    // 안쪽 양식까지 보는 범위면 그 양식들의 컨트롤 목록(커스텀 컨트롤 포함)도 더한다.
    if (withForms) {
      for (const form of Array.from(scope.querySelectorAll("form"))) {
        for (const c of formElements(form as HTMLFormElement)) if (!fields.includes(c)) fields.push(c);
      }
    }
  }
  for (const el of fields) {
    // 양식에 연결된 커스텀 컨트롤(ElementInternals.setFormValue)은 제출 값을 읽을 수 없으니 민감한 값으로 본다.
    if (!isFieldElement(el as HTMLElement)) {
      if (el.localName.includes("-")) out.push(el);
      continue;
    }
    const f = el as FieldElement;
    if (isTag(f, "input") && ["submit", "button", "image", "reset"].includes(f.type)) continue;
    // 파일이 선택된 칸은 내용을 볼 수 없으니 늘 민감한 값으로 본다(로컬 파일 업로드).
    if (isTag(f, "input") && f.type === "file") {
      if (f.files?.length) out.push(f);
      continue;
    }
    if (isTag(f, "input") && (f.type === "checkbox" || f.type === "radio") && !f.checked) continue;
    // 다중 선택 칸은 첫 선택값(value)만 보면 빈 값일 수 있어 선택된 값을 모두 본다.
    const value = isTag(f, "select") ? Array.from(f.selectedOptions, (o) => o.value).join(" ") : f.value ?? "";
    if (!value.trim()) continue;
    // 칸 이름 단서가 없어도 값 자체가 개인정보 모양이면(댓글 칸에 붙여 넣은 카드 번호 등) 개인정보로 본다.
    if (sensitivityOf(f) || isPersonalField(f) || looksPersonalValue(value)) out.push(f);
  }
  return out;
}

const FIELD_KIND: TargetKind = {
  prefix: "f",
  attr: "data-sbp-fid",
  visible: isVisible,
  requireVisible: false,
  name: (el) => (isFieldElement(el) ? resolveLabel(el).replace(/\s+/g, " ").slice(0, 200) : ""),
  fieldType: (el) => (isFieldElement(el) ? describeType(el) : ""),
  sensitive: sensitivityOf,
  personalElements: (el) => {
    const form = isFieldElement(el) ? el.form ?? el.closest("form") : null;
    return form
      ? personalValuedElements(form)
      : formlessScopes(el).flatMap((s) => personalValuedElements(s.node, s.includeFormFields));
  },
  // 칸 자신이 개인정보인지에 더해, 그 양식에 개인정보가 채워졌는지와 제출 주소도 본다
  // (change 처리기로 바로 제출하는 칸이 있다).
  risk: (el) => {
    const form = isFieldElement(el) ? el.form ?? el.closest("form") : null;
    const submitTo = formDestination(el, form);
    // 기존 칸 값까지 합친 제출 주소(change 처리기로 바로 제출되면 숨은 next=https://… 도 함께 간다).
    const submitUrl = form && submitTo ? formSubmissionUrl(form, submitTo) : "";
    // 선택 칸은 표시 문구로 고르면 실제 option.value가, checkbox·radio는 자기 value가 들어가므로 주소처럼 보이는
    // 값을 미리 풀어 둔다(change 처리기가 그 값으로 이동하거나 양식을 제출하는 페이지). 한도를 넘으면 묻는다.
    const choiceUrls = choiceUrlsOf(el);
    return {
      // checkbox·radio는 체크하면 자기 value가 실리므로, 그 값이 개인정보 모양이어도 개인정보 칸으로 본다.
      // 선택 칸은 표시 문구로 골라도 실제 option.value가 들어가므로, 개인정보 모양의 선택지가 있으면 개인정보 칸으로 본다.
      personal:
        isPersonalField(el) ||
        (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio") && controlHasPersonalValue(el)) ||
        (isTag(el, "select") && Array.from(el.options).some((o) => looksPersonalValue(o.value))),
      // 양식 없는 화면은 주변 입력 칸 묶음을 본다(change 처리기가 화면 전체 값을 저장하는 SPA 설정 화면).
      submitsPersonal: form
        ? formHasPersonalValues(form)
        : formlessScopes(el).some((s) => personalValuedElements(s.node, s.includeFormFields).some((p) => p !== el)),
      // 결제 화면의 칸(체크하면 change 처리기가 결제하는 '구매 확정' 체크박스 등), 결제 문구가 달린 선택지가 있는 선택 칸.
      paymentContext:
        inPaymentContext(el, form) ||
        (isTag(el, "select") &&
          Array.from(el.options).some((o) => {
            const text = `${o.textContent ?? ""} ${o.value}`;
            return PAYMENT_TEXT_RE.test(text) || PAYMENT_TEXT_RE.test(splitIdentifier(text));
          })),
      ...(submitTo ? { submitTo } : {}),
      ...(submitUrl ? { submitUrl } : {}),
      ...(choiceUrls.length ? { choiceUrls } : {}),
    };
  },
};

function currentValueOf(el: FieldElement): string {
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
    return el.checked ? `checked (value=${el.value})` : `unchecked (value=${el.value})`;
  }
  return el.value ?? "";
}

export function findFormFields(args: { onlyVisible?: boolean }): FormField[] {
  return scanTargets(() => collectFormFields(args));
}

function collectFormFields(args: { onlyVisible?: boolean }): FormField[] {
  const onlyVisible = args.onlyVisible !== false;
  const fields: FormField[] = [];

  for (const root of getAccessibleRoots()) {
    root.querySelectorAll("input, textarea, select").forEach((el) => {
      if (!isFieldElement(el)) return;
      if (isTag(el, "input") && SKIP_INPUT_TYPES.has(el.type)) return;
      if (onlyVisible && !isVisible(el)) return;
      if (el.disabled) return;
      if (!isTag(el, "select") && el.readOnly) return;

      fields.push({
        id: registerTarget(FIELD_KIND, el),
        label: resolveLabel(el),
        placeholder: isTag(el, "select") ? "" : el.placeholder ?? "",
        type: describeType(el),
        role: el.getAttribute("role") ?? "",
        currentValue: currentValueOf(el),
      });
    });
  }

  return fields;
}

// React 등은 value/checked 속성 setter를 인스턴스에 덮어써 변경을 추적한다.
// 요소 자신의 프로토타입(= iframe이면 그 창의 프로토타입) setter로 써야 이벤트가 반영된다.
function setNativeProperty(el: Element, prop: "value" | "checked", value: string | boolean): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop)?.set;
  if (setter) setter.call(el, value);
  else (el as unknown as Record<string, unknown>)[prop] = value;
}

function dispatchChange(el: Element): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// 이 입력이 실제로 넣을 값(페이지 처리기가 돌기 전에 정한 것): 선택 칸은 고를 option.value, checkbox·radio는 자기 value.
function intendedValue(el: FieldElement, value: string): string {
  if (isTag(el, "select")) {
    const match = Array.from(el.options).find((opt) => opt.value === value || opt.textContent?.trim() === value);
    return match ? match.value : value;
  }
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) return el.value;
  return value;
}

function fillOne(el: FieldElement, value: string): boolean {
  if (isTag(el, "select")) {
    const match = Array.from(el.options).find(
      (opt) => opt.value === value || opt.textContent?.trim() === value,
    );
    if (!match) return false;
    setNativeProperty(el, "value", match.value);
    dispatchChange(el);
    return true;
  }
  if (isTag(el, "input") && el.type === "checkbox") {
    // value 속성이 아니라 체크 상태를 바꾼다. "true"/"예" 등이면 체크, 그 외는 해제.
    const want = TRUTHY_VALUES.test(value.trim()) || value === el.value;
    if (el.checked !== want) {
      setNativeProperty(el, "checked", want);
      dispatchChange(el);
    }
    return true;
  }
  if (isTag(el, "input") && el.type === "radio") {
    // 라디오는 해제할 수 없으니 선택만 한다. 값이 이 항목의 value이거나 참 값이면 선택.
    if (value !== el.value && !TRUTHY_VALUES.test(value.trim())) return false;
    if (!el.checked) {
      setNativeProperty(el, "checked", true);
      dispatchChange(el);
    }
    return true;
  }
  setNativeProperty(el, "value", value);
  dispatchChange(el);
  return true;
}

// 채운 뒤 값을 다시 읽어 실제로 반영됐는지 본다. 페이지가 값을 고치거나(최대 길이·서식) 거부할 수 있다.
function appliedValue(el: FieldElement, value: string): boolean {
  if (isTag(el, "select")) {
    const opt = el.selectedOptions[0];
    return !!opt && (opt.value === value || opt.textContent?.trim() === value);
  }
  if (isTag(el, "input") && el.type === "checkbox") {
    return el.checked === (TRUTHY_VALUES.test(value.trim()) || value === el.value);
  }
  if (isTag(el, "input") && el.type === "radio") return el.checked;
  return el.value === value;
}

export interface FillResult {
  id: string;
  label: string;
  applied: boolean;
  note?: string;
}

// 페이지가 값을 고치거나 되돌리는 처리(마이크로태스크·타이머·다시 그리기)가 끝날 틈을 준 뒤 최종 값을 본다.
const SETTLE_MS = 150;

// 승인 카드에서 확인한 칸들이 모두 그대로일 때만 채운다. 하나라도 바뀌었으면 아무것도 채우지 않는다.
export async function fillFormFields(
  args: { fills: Array<{ id: string; value: string }> },
  callId: string,
): Promise<{ filledCount: number; results: FillResult[] }> {
  const ids = args.fills.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new Error("같은 칸 id가 두 번 들어 있습니다. 칸마다 한 번만 지정하세요.");
  for (const id of ids) peekApproved(id, callId, FIELD_KIND.prefix);

  const results: FillResult[] = [];
  const written: Array<{ el: FieldElement; info: TargetInfo; value: string; result: FillResult }> = [];
  const applied = new Set<string>();
  for (const f of args.fills) {
    let el: HTMLElement;
    let info: TargetInfo;
    try {
      // 앞 칸을 채우면서 페이지가 행을 바꿨을 수 있어 칸마다 행 글자까지 다시 확인한다. 바뀐 칸만 건너뛴다.
      ({ el, info } = takeApproved(f.id, callId, FIELD_KIND.prefix));
    } catch (err) {
      results.push({ id: f.id, label: "", applied: false, note: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!isFieldElement(el)) throw new Error(`id '${f.id}'는 입력 칸이 아닙니다.`);
    const label = FIELD_KIND.name(el);
    // 처리기가 돌기 전에 이 입력이 넣을 값을 정해 둔다(처리기가 덮어쓴 값은 승인한 변화가 아니다).
    const intended = intendedValue(el, f.value);
    // 승인 뒤 양식 값에 주소가 새로 생겼으면(페이지가 숨은 next를 바꾼 경우) 채우지 않는다.
    // 이 묶음에서 넣는 값으로 생긴 것은 승인 때 이미 검사했다.
    const nowUrl = FIELD_KIND.risk?.(el).submitUrl ?? "";
    if (nowUrl) {
      const known = new Set([
        ...urlLikeParams(info.submitUrl ?? ""),
        ...args.fills.map((x) => decodeDeep(x.value)),
        ...applied,
      ]);
      const added = [...urlLikeParams(nowUrl), ...personalParams(nowUrl)].filter(
        (v) => !known.has(v) && !personalParams(info.submitUrl ?? "").has(v),
      );
      if (added.length) {
        results.push({
          id: f.id,
          label,
          applied: false,
          note: "승인한 뒤 양식에 주소·개인정보 값이 새로 생겨 채우지 않았습니다. 다시 찾으세요.",
        });
        continue;
      }
    }
    if (!fillOne(el, f.value)) {
      results.push({ id: f.id, label, applied: false, note: "맞는 선택지가 없거나 이 값으로 고를 수 없습니다" });
      continue;
    }
    // 앞선 입력이 넣은 값(선택 칸은 표시 문구가 아니라 option.value)은 승인한 변화다.
    applied.add(decodeDeep(intended));
    noteWritten(callId, el, intended);
    const result: FillResult = { id: f.id, label, applied: false };
    results.push(result);
    written.push({ el, info, value: f.value, result });
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  for (const { el, info, value, result } of written) {
    // input·change 처리기가 칸을 새로 그렸으면 떨어져 나간 이전 요소의 값은 화면과 무관하다.
    if (!el.isConnected) {
      result.note = "입력 뒤 페이지가 칸을 새로 그려 값이 남았는지 확인하지 못했습니다";
      continue;
    }
    // 같은 칸 노드가 다른 행에 다시 쓰였으면 값이 남아 있어도 승인한 칸에 들어간 것이 아니다.
    const changed = recheckApproved(FIELD_KIND, el, info);
    if (changed) {
      result.note = `입력 뒤 칸이 바뀌어 승인한 칸에 반영됐는지 확인하지 못했습니다(${changed})`;
    } else if (appliedValue(el, value)) {
      result.applied = true;
    } else {
      result.note = "페이지가 값을 바꾸거나 받아들이지 않았습니다(최대 길이·서식 등)";
    }
  }
  return { filledCount: results.filter((r) => r.applied).length, results };
}
