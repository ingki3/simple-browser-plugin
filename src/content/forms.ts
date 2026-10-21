import type { FormField } from "@/lib/messages";
import {
  FIELD_PAYMENT_HINT_RE as PAYMENT_RE,
  PAYMENT_TEXT_RE,
  PERSONAL_HINT_RE,
  SECRET_HINT_RE,
  decodeDeepText,
  looksPersonalValue,
  sensitiveUrlReason,
  splitIdentifier,
} from "@/lib/autoApprove";
import { formlessScopes, inPaymentContext, nestedContainerScan } from "./context";
import type { TargetInfo } from "@/lib/actionTarget";
import { getAccessibleDocs, getAccessibleRoots, isTag } from "./docs";
import { inProtectedArea, modelName, optionHidden, subtreeText } from "./modelText";
import {
  RiskAddedError,
  noteWritten,
  peekApproved,
  recheckApproved,
  registerTarget,
  scanTargets,
  takeApproved,
  type TargetKind,
} from "./targets";

const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image", "file"]);
const TRUTHY_VALUES = /^(true|1|on|yes|y|checked|check|예|네|체크|선택)$/i;

// checkbox·radio에 넣을 값의 해석(실행·기대 상태·최종 확인이 함께 쓴다). 참 = 기존 참 값, 거짓 = "false",
// 그 밖은 null(지정 오류). 칸의 value 속성과는 비교하지 않는다(#43 — 모델은 value를 모르고, value가 "false"인
// 칸에 거짓 요청이 체크로 처리되지 않게).
export function parseCheckedRequest(value: string): boolean | null {
  const v = value.trim();
  if (TRUTHY_VALUES.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return null;
}

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

// 라벨 외의 접근성 이름 단서: aria-label·aria-labelledby가 가리키는 글자·title·placeholder.
// (label이 '코드'여도 aria-label이 '인증번호'면 비밀 칸이다.)
function accessibleHint(el: Element): string {
  const parts = [el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? "", el.getAttribute("placeholder") ?? ""];
  const root = el.getRootNode() as Document | ShadowRoot;
  for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
    const ref = root.getElementById?.(id) ?? el.ownerDocument.getElementById(id);
    if (ref) parts.push(ref.textContent ?? "");
  }
  return parts.join(" ");
}

function describeType(el: FieldElement): string {
  if (isTag(el, "input")) return el.type || "text";
  if (isTag(el, "textarea")) return "textarea";
  return "select";
}


export function sensitivityOf(el: HTMLElement): TargetInfo["sensitive"] {
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if ((isTag(el, "input") && el.type === "password") || /password|one-time-code/.test(ac)) return "password";
  if (/\bcc-/.test(ac)) return "payment";
  const hint = splitIdentifier(`${el.getAttribute("name") ?? ""} ${el.id} ${isFieldElement(el) ? resolveLabel(el) : ""} ${accessibleHint(el)}`);
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
  const hint = splitIdentifier(`${el.getAttribute("name") ?? ""} ${el.id} ${resolveLabel(el)} ${accessibleHint(el)}`);
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
  // formaction은 그 요소가 실제 제출자(submit 버튼·submit/image input)일 때만 쓰인다. 입력 칸 등에 붙은 것은 무시.
  const submitter =
    (isTag(el, "button") && ((el as HTMLButtonElement).type || "submit") === "submit") ||
    (isTag(el, "input") && ["submit", "image"].includes((el as HTMLInputElement).type));
  if (submitter && el.hasAttribute("formaction")) return (el as HTMLButtonElement).formAction;
  return formAction(form);
}

// 양식의 제출 버튼들. form.elements는 input[type=image]를 빼므로 그 양식에 속한 이미지 버튼(form 속성으로
// 바깥에서 연결된 것 포함)을 따로 모은다.
function formSubmitters(form: HTMLFormElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of formElements(form)) {
    if (
      (isTag(el, "button") && ((el as HTMLButtonElement).type || "submit") === "submit") ||
      (isTag(el, "input") && (el as HTMLInputElement).type === "submit")
    ) {
      out.push(el as HTMLElement);
    }
  }
  const root = form.getRootNode() as Document | ShadowRoot;
  for (const img of Array.from(root.querySelectorAll('input[type="image" i]'))) {
    if ((img as HTMLInputElement).form === form && !out.includes(img as HTMLElement)) out.push(img as HTMLElement);
  }
  return out;
}

// 양식이 제출될 수 있는 모든 주소: 기본 action과 연결된 제출 버튼들의 formaction
// (처리기가 form.requestSubmit(button)으로 다른 버튼의 주소로 보낼 수 있다). 50개를 넘으면 한도 표시를 넣는다.
export function formDestinations(form: HTMLFormElement): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (!u || out.includes(u)) return true;
    if (out.length >= 50) {
      out.push("about:too-many-forms");
      return false;
    }
    out.push(u);
    return true;
  };
  add(formAction(form));
  for (const el of formSubmitters(form)) {
    if (!el.hasAttribute("formaction")) continue;
    const dest = formDestination(el as HTMLElement, form);
    if (!add(dest)) break;
  }
  return out;
}

// 이름 있는 제출 버튼마다 실제로 보낼 주소(그 버튼의 action + 버튼 자신의 name=value, withValues면 양식 값도).
// 같은 action이어도 버튼 값(operation=pay)이 다를 수 있다. 50개를 넘으면 한도 표시를 넣는다.
function submitterUrls(form: HTMLFormElement, withValues: boolean): string[] {
  const urls: string[] = [];
  for (const el of formSubmitters(form)) {
    const b = el as HTMLButtonElement;
    if (!b.name) continue;
    const dest = formDestination(b, form);
    let url = "";
    if (withValues) url = formSubmissionUrl(form, dest, b);
    else {
      try {
        const u = new URL(dest);
        u.searchParams.append(b.name, b.value ?? "");
        url = u.href;
      } catch {
        url = dest;
      }
    }
    if (!url || urls.includes(url)) continue;
    if (urls.length >= 50) {
      urls.push("about:too-many-forms");
      break;
    }
    urls.push(url);
  }
  return urls;
}

// 이 제출 주소 말고 양식이 제출될 수 있는 다른 주소들(다른 제출 버튼의 formaction)과 지금 값을 합친 주소.
// 칸의 change 처리기나 다른 버튼의 클릭 처리기가 form.requestSubmit(그 버튼)으로 보낼 수 있다.
export function otherDestinations(
  form: HTMLFormElement,
  submitTo: string,
): { scopeFormActions?: string[]; scopeSubmitUrls?: string[] } {
  const extra = formDestinations(form).filter((u) => u !== submitTo);
  const urls = submitterUrls(form, true);
  for (const u of extra) {
    const url = u.startsWith("about:") ? u : formSubmissionUrl(form, u);
    if (!urls.includes(url)) urls.push(url);
  }
  return {
    ...(extra.length ? { scopeFormActions: extra } : {}),
    ...(urls.length ? { scopeSubmitUrls: urls } : {}),
  };
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

// 공백으로 이은 여러 주소의 매개변수 값을 모은다.
function urlLikeParamsAll(urls: string): Set<string> {
  const out = new Set<string>();
  for (const u of urls.split(" ").filter(Boolean)) for (const v of urlLikeParams(u)) out.add(v);
  return out;
}

function personalParamsAll(urls: string): Set<string> {
  const out = new Set<string>();
  for (const u of urls.split(" ").filter(Boolean)) for (const v of personalParams(u)) out.add(v);
  return out;
}

// 값이 채워진 개인정보·비밀번호·결제 칸이 있는 양식인지(그 양식의 버튼은 자동 실행하지 않는다).
// 제출되는 값이면 종류를 가리지 않는다: 숨은 칸(로그인한 사용자 이메일 등)·선택 칸(생년월일)·체크한 칸도 본다.
export function formHasPersonalValues(form: HTMLFormElement): boolean {
  return personalValuedElements(form).length > 0;
}

// 값이 채워진 개인정보·비밀번호·결제 칸들.
// 숨은 칸(type=hidden)은 .value를 바꾸면 defaultValue도 같이 바뀌어 처음 값과 비교할 수 없다.
// 페이지를 처음 살필 때(find_*) 값을 기록해 두고 그 값과 비교한다. 기록이 없으면 지금 값을 기준으로 삼는다.
const hiddenBaseline = new WeakMap<Element, string>();
// 기준 값을 기록한 문서. 기록한 뒤에 새로 생긴 숨은 칸은 페이지 기본값이 아니라 바뀐 값으로 본다.
const baselineDocs = new WeakSet<Document>();
// 기준을 기록할 때 있던 칸들. 그 뒤 새로 생긴 칸(값이 있는)은 종류와 관계없이 바뀐 값으로 본다.
const seenFields = new WeakSet<Element>();
const textBaseline = new WeakMap<Element, string>();
const submitterBaseline = new WeakMap<Element, string>();

export function captureHiddenBaselines(): void {
  // 기준은 문서마다 처음 살필 때 한 번만 기록한다(그 뒤에 생긴 숨은 칸을 기준으로 삼지 않게).
  const fresh = getAccessibleDocs().filter((doc) => !baselineDocs.has(doc));
  if (!fresh.length) return;
  for (const root of getAccessibleRoots()) {
    const doc = (root as Node).ownerDocument ?? (root as Document);
    if (!fresh.includes(doc)) continue;
    // checkbox·radio도 value가 속성을 따라 defaultValue와 함께 바뀌므로 같은 방식으로 기록한다.
    for (const el of Array.from(root.querySelectorAll('input[type="hidden"], input[type="checkbox"], input[type="radio"]'))) {
      if (!hiddenBaseline.has(el)) hiddenBaseline.set(el, (el as HTMLInputElement).value);
    }
    for (const el of Array.from(root.querySelectorAll("input, textarea, select"))) seenFields.add(el);
    // 제출 버튼의 값도 기록한다(처리기가 대화 내용을 <button name=q>.value에 복사해 그 버튼으로 제출할 수 있다).
    for (const el of Array.from(root.querySelectorAll("button"))) {
      seenFields.add(el);
      if (!submitterBaseline.has(el)) submitterBaseline.set(el, (el as HTMLButtonElement).value);
    }
    // 일반 칸은 처음 살핀 값을 따로 기록한다(React 등이 value와 defaultValue를 함께 바꾸면 defaultValue 비교로는 못 잡는다).
    for (const el of Array.from(root.querySelectorAll("input, textarea"))) {
      const t = (el as HTMLInputElement).type;
      if (isTag(el, "input") && (t === "hidden" || t === "checkbox" || t === "radio")) continue;
      if (!textBaseline.has(el)) textBaseline.set(el, (el as HTMLInputElement).value);
    }
    // 선택 칸은 처음 살핀 때의 실제 선택 상태를 기준으로 삼는다(selected 속성이 없으면 첫 선택지가 골라져 있다).
    for (const el of Array.from(root.querySelectorAll("select"))) {
      if (!hiddenBaseline.has(el)) hiddenBaseline.set(el, selectedSignature(el as HTMLSelectElement));
    }
  }
  for (const doc of fresh) baselineDocs.add(doc);
}

// 선택 상태와 선택된 선택지의 실제 값을 함께 요약한다(선택은 그대로인데 option.value가 바뀌는 경우도 잡게).
function selectedSignature(sel: HTMLSelectElement): string {
  return Array.from(sel.options, (o) => (o.selected ? `1:${o.value}` : "0")).join("\u0001");
}

// 칸 값이 처음 값(HTML에 적힌 값)에서 바뀐 양식인지. 사용자나 모델이 넣은 값이 있어야 대화 내용이 실릴 수 있다
// (페이지가 처음부터 넣어 둔 값은 페이지의 것이다). 모든 페이지 머리의 빈 검색 양식 같은 것은 빼려는 것.
function formHasChangedValues(form: HTMLFormElement): boolean {
  // 제출 버튼(button·submit·image)의 값: 처음 살핀 값에서 바뀌었거나, 그 뒤 새로 생긴 버튼에 값이 있으면 바뀐 것.
  for (const el of formSubmitters(form)) {
    if (!(el as HTMLButtonElement).name) continue;
    const v = (el as HTMLButtonElement).value ?? "";
    const known = isTag(el, "button") ? submitterBaseline : textBaseline;
    if (known.has(el)) {
      if (known.get(el) !== v) return true;
    } else if (baselineDocs.has(el.ownerDocument) && !seenFields.has(el) && v) {
      return true;
    } else if (!known.has(el)) {
      known.set(el, v);
    }
  }
  for (const el of formElements(form)) {
    if (!isFieldElement(el as HTMLElement)) continue;
    const f = el as FieldElement;
    // 기준을 기록한 문서에 나중에 생긴 칸이 값을 가지고 있으면 바뀐 값이다(처리기가 새 칸에 내용을 복사).
    if (baselineDocs.has(f.ownerDocument) && !seenFields.has(f)) {
      const hasValue = isTag(f, "select")
        ? Array.from(f.selectedOptions).some((o) => o.value)
        : isTag(f, "input") && (f.type === "checkbox" || f.type === "radio")
          ? f.checked
          : !!f.value;
      if (hasValue) return true;
    }
    if (isTag(f, "select")) {
      const sig = selectedSignature(f);
      if (!hiddenBaseline.has(f)) hiddenBaseline.set(f, sig);
      else if (hiddenBaseline.get(f) !== sig) return true;
    } else if (isTag(f, "input") && (f.type === "checkbox" || f.type === "radio")) {
      if (f.checked !== f.defaultChecked) return true;
      // 체크 상태가 그대로여도 제출될 value가 처음 살핀 값에서 바뀌었으면(처리기가 내용을 복사) 바뀐 것.
      if (!hiddenBaseline.has(f)) {
        if (baselineDocs.has(f.ownerDocument) && f.checked) return true;
        hiddenBaseline.set(f, f.value);
      } else if (hiddenBaseline.get(f) !== f.value) return true;
    } else if (isTag(f, "input") && f.type === "hidden") {
      if (!hiddenBaseline.has(f)) {
        // 기준을 기록한 문서에 나중에 생긴 숨은 칸(값이 있는)은 바뀐 것으로 본다.
        if (baselineDocs.has(f.ownerDocument) && f.value) return true;
        hiddenBaseline.set(f, f.value);
      } else if (hiddenBaseline.get(f) !== f.value) return true;
    } else if (f.value !== (f as HTMLInputElement | HTMLTextAreaElement).defaultValue) {
      return true;
    } else if (textBaseline.has(f) && textBaseline.get(f) !== f.value) {
      return true;
    }
  }
  return false;
}

// 범위 안 양식들의 제출 주소. 양식 밖 버튼·칸의 처리기가 그 양식을 requestSubmit할 수 있으니 검사에 넣는다.
// - changed: 칸 값이 처음 값에서 바뀐 양식(사용자·모델이 넣은 값이 실릴 수 있다)의 action과 지금 값을 합친 주소.
//   사이트 경계와 결제·개인정보 주소를 모두 본다.
// - actions: 모든 양식의 action. 결제·개인정보 주소만 본다(처음 값 그대로인 양식은 대화 내용을 싣지 않으니
//   모든 페이지 머리의 다른 하위 도메인 검색 양식 때문에 버튼마다 묻지 않게 사이트 경계는 보지 않는다).
// 한도(각 50개)를 넘으면 끝까지 보지 못했다는 표시를 넣는다(웹 주소가 아니라 늘 묻게 된다).
const TOO_MANY_FORMS = "about:too-many-forms";

export function scopeSubmitUrls(scopes: Array<{ node: Element | ShadowRoot }>): { changed: string[]; actions: string[] } {
  const changed: string[] = [];
  const actions: string[] = [];
  for (const s of scopes) {
    for (const f of Array.from(s.node.querySelectorAll("form"))) {
      // 기본 action뿐 아니라 제출 버튼들의 formaction도 본다.
      const dests = formDestinations(f as HTMLFormElement);
      // 제출 버튼 자신의 name=value(operation=pay)를 붙인 주소도 결제·개인정보 주소인지 본다.
      for (const action of [...dests, ...submitterUrls(f as HTMLFormElement, false)]) {
        if (actions.includes(action)) continue;
        if (actions.length >= 50) {
          actions.push(TOO_MANY_FORMS);
          return { changed, actions };
        }
        actions.push(action);
      }
      if (!formHasChangedValues(f as HTMLFormElement)) continue;
      for (const url of submitterUrls(f as HTMLFormElement, true)) {
        if (changed.includes(url)) continue;
        if (changed.length >= 50) {
          changed.push(TOO_MANY_FORMS);
          return { changed, actions };
        }
        changed.push(url);
      }
      for (const action of dests) {
        const url = formSubmissionUrl(f as HTMLFormElement, action);
        for (const u of [action, url]) {
          if (!u || changed.includes(u)) continue;
          if (changed.length >= 50) {
            changed.push(TOO_MANY_FORMS);
            return { changed, actions };
          }
          changed.push(u);
        }
      }
    }
  }
  return { changed, actions };
}

// 양식 밖 입력 칸의 범위: change 처리기가 다른 양식을 requestSubmit할 수 있으니 클릭처럼 범위 안 양식 칸까지 본다.
function fieldFormlessScopes(el: Element) {
  return formlessScopes(el).map((s) => ({ ...s, includeFormFields: true }));
}

// 범위들의 개인정보 칸. 탐색이 한도에 걸린 범위는 그 범위 노드(또는 shadow host)를 민감 표시로 넣는다.
export function personalValuedInScopes(
  scopes: Array<{ node: Element | ShadowRoot; includeFormFields: boolean; incomplete?: boolean }>,
): Element[] {
  const out: Element[] = [];
  for (const s of scopes) {
    out.push(...personalValuedElements(s.node, s.includeFormFields));
    if (s.incomplete) out.push("host" in s.node ? (s.node as ShadowRoot).host : (s.node as Element));
  }
  return out;
}

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
    // 양식 안 iframe 문서의 칸도 본다. 탐색 한도에 걸리면 끝까지 보지 못했으니 양식 자신을 민감 표시로 넣는다.
    const scan = nestedContainerScan(scope as Element);
    for (const root of scan.containers) {
      for (const c of Array.from(root.querySelectorAll("input, textarea, select"))) if (!fields.includes(c)) fields.push(c);
    }
    if (scan.incomplete) out.push(scope as Element);
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
  visible: isVisible,
  requireVisible: false,
  name: (el) => (isFieldElement(el) ? resolveLabel(el).replace(/\s+/g, " ").slice(0, 200) : ""),
  modelName: (el) => modelName(el),
  fieldType: (el) => (isFieldElement(el) ? describeType(el) : ""),
  sensitive: sensitivityOf,
  personalElements: (el) => {
    const form = isFieldElement(el) ? el.form ?? el.closest("form") : null;
    // 양식 안 칸도 change 처리기가 같은 대화상자·화면의 다른 양식을 requestSubmit할 수 있어 주변 범위를 함께 본다.
    const around = personalValuedInScopes(fieldFormlessScopes(el));
    return form ? [...new Set([...personalValuedElements(form), ...around])] : around;
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
      // 양식 안 칸도 주변 범위(대화상자, 없으면 화면)의 다른 양식을 본다(change 처리기가 그 양식을 제출할 수 있다).
      submitsPersonal:
        (!!form && formHasPersonalValues(form)) ||
        personalValuedInScopes(fieldFormlessScopes(el)).some((p) => p !== el),
      // 칸 이름은 200자로 잘리므로 결제 문구 판정용 전체 라벨을 따로 담는다(긴 약관 뒤의 '구매 확정').
      ...(() => {
        const full = isFieldElement(el)
          ? `${resolveLabel(el)} ${accessibleHint(el)}`.replace(/\s+/g, " ").trim()
          : "";
        return full ? { outerText: full } : {};
      })(),
      // 결제 화면의 칸(체크하면 change 처리기가 결제하는 '구매 확정' 체크박스 등), 결제 문구가 달린 선택지가 있는 선택 칸.
      paymentContext:
        inPaymentContext(el, form) ||
        // 체크하면 실리는 checkbox·radio의 name=value에 결제 문구가 있으면(value="purchase", name="confirm_order").
        (isTag(el, "input") &&
          (el.type === "checkbox" || el.type === "radio") &&
          [el.value, el.name].some((v) => PAYMENT_TEXT_RE.test(v) || PAYMENT_TEXT_RE.test(splitIdentifier(v)))) ||
        (isTag(el, "select") &&
          Array.from(el.options).some((o) => {
            const text = `${o.textContent ?? ""} ${o.value}`;
            return PAYMENT_TEXT_RE.test(text) || PAYMENT_TEXT_RE.test(splitIdentifier(text));
          })),
      ...(submitTo ? { submitTo } : {}),
      ...(submitUrl ? { submitUrl } : {}),
      // 양식 밖 칸이면 범위 안 다른 양식들의 제출 주소도 본다.
      ...(() => {
        if (form) {
          // 양식 안 칸: 제출 버튼들의 formaction(기본 action과 다른 것)과 지금 값을 합친 주소도 본다
          // (change 처리기가 form.requestSubmit(button)으로 그 주소에 제출할 수 있다).
          const own = otherDestinations(form, submitTo);
          // 주변 범위의 다른 양식: 값이 바뀐 양식의 제출 주소와, 모든 양식의 action(change 처리기가 입력값을 옮겨
          // 제출할 수 있다 — 승인 판정에서 사이트 경계와 결제·개인정보 주소를 본다).
          const around = scopeSubmitUrls(fieldFormlessScopes(el).filter((s) => s.node !== form));
          const urls = [...(own.scopeSubmitUrls ?? []), ...around.changed.filter((u) => !(own.scopeSubmitUrls ?? []).includes(u))];
          return {
            ...(own.scopeFormActions ? { scopeFormActions: own.scopeFormActions } : {}),
            ...(urls.length ? { scopeSubmitUrls: urls } : {}),
            ...(around.actions.length ? { aroundFormActions: around.actions } : {}),
          };
        }
        const { changed, actions } = scopeSubmitUrls(fieldFormlessScopes(el));
        return {
          ...(changed.length ? { scopeSubmitUrls: changed } : {}),
          ...(actions.length ? { scopeFormActions: actions } : {}),
        };
      })(),
      ...(choiceUrls.length ? { choiceUrls } : {}),
      ...(isFieldElement(el) && el.name ? { fieldName: el.name } : {}),
      baseUri: el.baseURI,
    };
  },
};

// select 선택지의 보이는 글자(공백 정리). 고르기·최종 확인이 같은 글자를 쓴다. label 속성이 있으면 그것,
// 없으면 선택지 안의 글자에서 숨긴·편집 하위 내용을 뺀 것(커스텀 select의 <option>공개<span hidden>…</span>).
function optionLabel(o: HTMLOptionElement): string {
  const attr = o.getAttribute("label");
  return (attr !== null && attr.trim() ? attr : subtreeText(o, 2000)).replace(/\s+/g, " ").trim();
}

// 선택지 자신이나 select까지의 조상 optgroup(사이에 감싼 요소가 있어도)이 비활성이면 고를 수 없다.
function optionDisabled(o: HTMLOptionElement): boolean {
  if (o.disabled) return true;
  for (let cur = o.parentElement; cur && cur.localName !== "select"; cur = cur.parentElement) {
    if (cur.localName === "optgroup" && (cur as HTMLOptGroupElement).disabled) return true;
  }
  return false;
}

const MAX_OPTIONS = 200;
// 돌려주는 선택지 글자의 상한. 넘으면 잘라 truncated로 표시하고, 잘린 글자로는 고르지 못한다(다른 선택지와 섞이지 않게).
const MAX_OPTION_LABEL = 300;

// 보이는 글자가 요청과 정확히 같은 선택지가 하나뿐이고 고를 수 있으면 그 선택지, 아니면 이유(#43).
// 찾기·채우기·최종 확인이 이 규칙 하나를 쓴다. value 속성이나 textContent로는 고르지 않는다.
// 모델에 돌려주는 선택지 글자(길면 잘라 끝에 …).
function shownOptionLabel(o: HTMLOptionElement): { label: string; truncated: boolean } {
  const label = optionLabel(o);
  return label.length > MAX_OPTION_LABEL
    ? { label: label.slice(0, MAX_OPTION_LABEL) + "…", truncated: true }
    : { label, truncated: false };
}

export function optionByLabel(el: HTMLSelectElement, label: string): HTMLOptionElement | string {
  if (el.multiple) return "다중 선택 칸은 지원하지 않습니다";
  const want = label.replace(/\s+/g, " ").trim();
  // 잘린 선택지 글자와 같은 요청은 그 잘린 선택지를 뜻했을 수 있어 거부한다(다른 선택지가 대신 골라지지 않게).
  if (Array.from(el.options).some((o) => !optionHidden(o) && shownOptionLabel(o).truncated && shownOptionLabel(o).label === want)) {
    return "글자가 길어 잘린 선택지와 같은 글자라 고를 수 없습니다";
  }
  // 숨긴 선택지는 모델에 글자를 보내지 않으므로 고르는 대상에서도 뺀다.
  const matches = Array.from(el.options).filter((o) => !optionHidden(o) && optionLabel(o) === want);
  if (!matches.length) return "보이는 글자가 같은 선택지가 없습니다(find_form_fields의 options 글자를 그대로 쓰세요)";
  if (matches.length > 1) return "보이는 글자가 같은 선택지가 여럿이라 고를 수 없습니다";
  if (optionDisabled(matches[0])) return "고를 수 없는(비활성) 선택지입니다";
  return matches[0];
}

// 값을 쓰기 전에 요청이 이 칸에 맞는지 본다. 맞지 않으면 이유(그 칸은 건드리지 않는다).
function requestProblem(el: FieldElement, value: string): string | null {
  if (isTag(el, "select")) {
    const m = optionByLabel(el, value);
    return typeof m === "string" ? m : null;
  }
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
    const want = parseCheckedRequest(value);
    if (want === null) return "checkbox·radio는 \"true\" 또는 \"false\"로 지정하세요";
    if (el.type === "radio" && !want && el.checked) return "선택된 라디오는 해제할 수 없습니다";
  }
  return null;
}

// 모델에 돌려줄 칸 하나(#43): 사용자가 입력한 값은 담지 않는다.
function fieldForModel(el: FieldElement, id: string): FormField {
  // 칸 자신이 편집 영역·숨은 영역 안이면 이름·선택지도 돌려주지 않는다.
  const area = inProtectedArea(el, true);
  const field: FormField = {
    id,
    label: modelName(el),
    placeholder:
      !area && !isTag(el, "select") ? (el.getAttribute("placeholder") ?? "").replace(/\s+/g, " ").trim().slice(0, 200) : "",
    type: describeType(el),
    role: el.getAttribute("role") ?? "",
  };
  if (isTag(el, "select")) {
    if (el.multiple) field.multiple = true;
    if (!area) {
      field.options = Array.from(el.options)
        .slice(0, MAX_OPTIONS)
        .map((o) => {
          // 숨긴 선택지(hidden·aria-hidden·display:none)는 글자를 보내지 않는다(위치만 남겨 selectedIndex와 맞춘다).
          if (optionHidden(o)) return { label: "", hidden: true };
          const shown = shownOptionLabel(o);
          return {
            label: shown.label,
            ...(shown.truncated ? { truncated: true } : {}),
            ...(optionDisabled(o) ? { disabled: true } : {}),
          };
        });
    }
    // 개인정보 단서가 있는 칸(저장된 배송지 목록 등)은 선택된 위치를 숨긴다(더 숨기는 방향만).
    const selected = el.selectedOptions[0];
    const personal =
      isPersonalField(el) || (!!selected && (looksPersonalValue(selected.value) || looksPersonalValue(optionLabel(selected))));
    if (!el.multiple && !personal && !area && el.selectedIndex >= 0 && el.selectedIndex < MAX_OPTIONS) {
      field.selectedIndex = el.selectedIndex;
    }
    return field;
  }
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
    field.checked = el.checked;
    return field;
  }
  field.hasValue = !!(el.value ?? "");
  return field;
}

export function findFormFields(_args: { onlyVisible?: boolean }): FormField[] {
  captureHiddenBaselines();
  return scanTargets(() => collectFormFields());
}

// 보이는 칸만 돌려준다. 화면에 보이지 않는 칸(onlyVisible:false로 찾던 숨은 칸)은 이제 돌려주지 않는다(#43).
function collectFormFields(): FormField[] {
  const fields: FormField[] = [];

  for (const root of getAccessibleRoots()) {
    root.querySelectorAll("input, textarea, select").forEach((el) => {
      if (!isFieldElement(el)) return;
      if (isTag(el, "input") && SKIP_INPUT_TYPES.has(el.type)) return;
      if (!isVisible(el)) return;
      if (el.disabled) return;
      if (!isTag(el, "select") && el.readOnly) return;

      fields.push(fieldForModel(el, registerTarget(FIELD_KIND, el)));
    });
  }

  return fields;
}

// React 등은 value/checked 속성 setter를 인스턴스에 덮어써 변경을 추적한다.
// 요소 자신의 프로토타입(= iframe이면 그 창의 프로토타입) setter로 써야 이벤트가 반영된다.
function setNativeProperty(el: Element, prop: "value" | "checked" | "selectedIndex", value: string | boolean | number): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), prop)?.set;
  if (setter) setter.call(el, value);
  else (el as unknown as Record<string, unknown>)[prop] = value;
}

// input 처리기가 돈 뒤 change를 보내기 전에 막혔다는 표시(이유가 메시지).
class ChangeBlocked extends Error {}

function dispatchChange(el: Element, guard?: () => string | null): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const blocked = guard?.();
  if (blocked) throw new ChangeBlocked(blocked);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// 이 입력이 실제로 넣을 값(페이지 처리기가 돌기 전에 정한 것): 선택 칸은 고를 option.value, checkbox·radio는 자기 value.
function intendedValue(el: FieldElement, value: string): string {
  if (isTag(el, "select")) {
    const match = optionByLabel(el, value);
    return typeof match === "string" ? value : match.value;
  }
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) return el.value;
  return value;
}

// onSet: 글자 칸에 브라우저가 정리한 실제 값(앞뒤 공백 제거 등)을 페이지 처리기가 돌기 전에 알려 준다.
// guard: input 처리기가 돈 뒤 change를 보내기 전에 부른다. 이유를 돌려주면 change를 보내지 않는다(ChangeBlocked).
function fillOne(
  el: FieldElement,
  value: string,
  onSet?: (actual: string) => void,
  guard?: () => string | null,
): boolean {
  if (isTag(el, "select")) {
    const match = optionByLabel(el, value);
    if (typeof match === "string") return false;
    // 그 선택지 자체를 고른다(value로 쓰면 같은 value의 다른 선택지가 먼저 골라질 수 있다).
    setNativeProperty(el, "selectedIndex", match.index);
    // 이벤트를 보내기 전에 그 선택지 하나만 골라졌는지 본다. 아니면 이벤트 없이 실패.
    if (el.selectedOptions.length !== 1 || el.selectedOptions[0] !== match) return false;
    dispatchChange(el, guard);
    return true;
  }
  if (isTag(el, "input") && el.type === "checkbox") {
    // value 속성이 아니라 체크 상태를 바꾼다.
    const want = parseCheckedRequest(value);
    if (want === null) return false;
    if (el.checked !== want) {
      setNativeProperty(el, "checked", want);
      dispatchChange(el, guard);
    }
    return true;
  }
  if (isTag(el, "input") && el.type === "radio") {
    // 라디오는 해제할 수 없으니 선택만 한다. 거짓 요청은 이미 해제돼 있을 때만 그대로 둔다.
    const want = parseCheckedRequest(value);
    if (want === null) return false;
    if (!want) return !el.checked;
    if (!el.checked) {
      setNativeProperty(el, "checked", true);
      dispatchChange(el, guard);
    }
    return true;
  }
  // 브라우저가 정리할 값(줄바꿈 제거, range의 숫자 정규화 등)을 페이지에 붙지 않은 복제본에서 먼저 구해 검사한다.
  // onSet이 막으면(개인정보 모양으로 바뀜) 실제 칸에는 쓰지 않는다(페이지 스크립트가 .value를 읽지 못하게).
  if (onSet) {
    const probe = el.cloneNode(false) as HTMLInputElement | HTMLTextAreaElement;
    setNativeProperty(probe, "value", value);
    onSet(probe.value);
  }
  setNativeProperty(el, "value", value);
  dispatchChange(el, guard);
  return true;
}

// 채운 뒤 값을 다시 읽어 실제로 반영됐는지 본다. 페이지가 값을 고치거나(최대 길이·서식) 거부할 수 있다.
function appliedValue(el: FieldElement, value: string): boolean {
  if (isTag(el, "select")) {
    const match = optionByLabel(el, value);
    return typeof match !== "string" && el.selectedOptions.length === 1 && el.selectedOptions[0] === match;
  }
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
    return el.checked === parseCheckedRequest(value);
  }
  return el.value === value;
}

// 브라우저의 정리(앞뒤 공백·줄바꿈 제거)만 허용한다. 잘못된 숫자·날짜를 빈 값으로 만든 것은 거부로 본다.
function sameIgnoringSpace(actual: string, value: string): boolean {
  return actual !== "" && actual.replace(/\s+/g, "") === value.replace(/\s+/g, "");
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
  const written: Array<{ el: FieldElement; info: TargetInfo; value: string; actual?: string; result: FillResult }> = [];
  const applied = new Set<string>();
  // 이 묶음이 채운 칸의 이름과 값(name\u0001값). 재검사에서 이 쌍만 승인한 값으로 빼고 본다.
  const appliedPairs = new Set<string>();
  // 한 칸이 승인 뒤 위험 변화(제출 주소·이름·개인정보)로 막히면 남은 칸도 채우지 않는다
  // (앞 칸의 처리기가 뒤 칸을 바꿔 둔 것일 수 있다).
  let halted = false;
  for (const f of args.fills) {
    if (halted) {
      results.push({ id: f.id, label: "", applied: false, note: "앞 칸에서 위험 변화가 보여 채우지 않았습니다. 다시 찾으세요." });
      continue;
    }
    let el: HTMLElement;
    let info: TargetInfo;
    try {
      // 앞 칸을 채우면서 페이지가 행을 바꿨을 수 있어 칸마다 행 글자까지 다시 확인한다. 바뀐 칸만 건너뛴다.
      ({ el, info } = takeApproved(f.id, callId, FIELD_KIND.prefix));
    } catch (err) {
      results.push({ id: f.id, label: "", applied: false, note: err instanceof Error ? err.message : String(err) });
      // 대상이 사라진 것이 아니라 위험이 생긴 것(riskAdded)이면 남은 칸도 멈춘다.
      if (err instanceof RiskAddedError) halted = true;
      continue;
    }
    if (!isFieldElement(el)) throw new Error(`id '${f.id}'는 입력 칸이 아닙니다.`);
    // 결과 문구에는 모델에 돌려준 이름만 쓴다.
    const label = FIELD_KIND.modelName(el);
    const problem = requestProblem(el, f.value);
    if (problem) {
      results.push({ id: f.id, label, applied: false, note: problem });
      continue;
    }
    // 처리기가 돌기 전에 이 입력이 넣을 값을 정해 둔다(처리기가 덮어쓴 값은 승인한 변화가 아니다).
    const intended = intendedValue(el, f.value);
    // checkbox·radio: 처리기가 돌기 전의 value와 요청한 체크 상태로 기대 값 요약을 만든다(fieldValueSignature와 같은 꼴).
    const expectedSig =
      isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")
        ? `${parseCheckedRequest(f.value) === true}:${el.value}`
        : null;
    // 승인 뒤 양식이 바뀌었는지(채우기 직전과, input 처리기가 돈 뒤 change를 보내기 전에 본다).
    // 이 묶음에서 넣는 값으로 생긴 것은 승인 때 이미 검사했다.
    // 처리기가 칸 이름을 바꿔(q → payment) 승인 예외를 넓히지 못하게 승인 당시의 이름을 쓴다.
    const startName = info.fieldName ?? "";
    // 브라우저가 정리한 실제 값(onSet에서 받는다). change 전 재검사의 허용 값에도 넣는다.
    let actual: string | undefined;
    const driftReason = (): string | null => {
      if (el.name !== startName) return "입력 중 칸 이름이 바뀌어 채우지 않았습니다. 다시 찾으세요.";
      const nowRisk = FIELD_KIND.risk?.(el);
      // 같은 칸의 양식 제출 주소와, 양식 밖 칸이면 주변 양식들의 제출 주소를 함께 본다.
      const nowUrl = [nowRisk?.submitUrl ?? "", ...(nowRisk?.scopeSubmitUrls ?? [])].join(" ");
      const approvedUrl = [info.submitUrl ?? "", ...(info.scopeSubmitUrls ?? [])].join(" ");
      if (!nowUrl.trim()) return null;
      const known = new Set([
        ...urlLikeParamsAll(approvedUrl),
        ...args.fills.map((x) => decodeDeep(x.value)),
        // 이 칸에 실제로 넣을 값(선택 칸을 표시 문구로 고르면 option.value)과 브라우저가 정리한 값도 승인한 값이다.
        decodeDeep(intended),
        ...(actual !== undefined ? [decodeDeep(actual)] : []),
        ...applied,
      ]);
      const approvedPersonal = personalParamsAll(approvedUrl);
      const added = [...urlLikeParamsAll(nowUrl), ...personalParamsAll(nowUrl)].filter(
        (v) => !known.has(v) && !approvedPersonal.has(v),
      );
      if (added.length) return "승인한 뒤 양식에 주소·개인정보 값이 새로 생겨 채우지 않았습니다. 다시 찾으세요.";
      // 앞선 입력의 처리기가 숨은 값을 바꿔(operation=browse → pay) 제출 주소가 결제·민감 주소로 바뀌었으면 멈춘다.
      // 이 칸과 앞서 채운 칸의 이름·값 쌍만 승인한 값으로 빼고 본다(같은 값이라도 다른 이름 payment=1은 남긴다).
      const pairs = new Set([
        ...appliedPairs,
        `${startName}\u0001${decodeDeep(intended)}`,
        ...(actual !== undefined ? [`${startName}\u0001${decodeDeep(actual)}`] : []),
      ]);
      // byPair: 이 묶음이 채운 칸의 이름·값 쌍만 뺀다(결제 판정용 — 같은 값의 새 이름 payment=1을 남긴다).
      // 아니면 그 쌍과 함께, 개인정보 승인 카드를 받은 묶음(consentPersonal)이 넣는 개인정보 모양의 값은 이름과
      // 관계없이 뺀다(승인한 이메일을 처리기가 같은 양식의 숨은 칸에 복사하는 것은 승인한 변화다). 자동 실행한
      // 일반 값이 full_name 같은 개인정보 매개변수로 복사된 것은 빼지 않는다.
      const withoutKnown = (u: string, byPair: boolean) => {
        try {
          const x = new URL(u);
          const kept = new URLSearchParams();
          x.searchParams.forEach((v, k) => {
            const dv = decodeDeep(v);
            const drop =
              pairs.has(`${k}\u0001${dv}`) ||
              (!byPair && !!info.consentPersonal && known.has(dv) && looksPersonalValue(dv));
            if (!drop) kept.append(k, v);
          });
          x.search = kept.toString();
          return x.href;
        } catch {
          return u;
        }
      };
      // 이유별로 비교한다(이미 개인정보 주소였던 양식에 결제 동작이 새로 붙은 경우도 잡게).
      const PAYMENT_REASON = "결제·주문 주소";
      // 제출 주소(쿼리 뺀 주소)별로 이유를 모은다. 다른 양식에 이미 있던 결제 단서가 이 양식의 새 결제를 덮지 않게.
      const target = (u: string) => {
        try {
          const x = new URL(u);
          return `${x.origin}${x.pathname}`;
        } catch {
          return u;
        }
      };
      const reasonsIn = (list: string[]) => {
        const out = new Set<string>();
        for (const u of list) {
          if (!u) continue;
          const key = target(u);
          if (sensitiveUrlReason(withoutKnown(u, true)) === PAYMENT_REASON) out.add(`${key}\u0001${PAYMENT_REASON}`);
          const other = sensitiveUrlReason(withoutKnown(u, false));
          if (other) out.add(`${key}\u0001${other}`);
        }
        return out;
      };
      const nowList = [nowRisk?.submitUrl ?? "", ...(nowRisk?.scopeSubmitUrls ?? []), ...(nowRisk?.scopeFormActions ?? [])];
      const approvedList = [info.submitUrl ?? "", ...(info.scopeSubmitUrls ?? []), ...(info.scopeFormActions ?? [])];
      const approvedReasons = reasonsIn(approvedList);
      if ([...reasonsIn(nowList)].some((r) => !approvedReasons.has(r))) {
        return "승인한 뒤 양식의 제출 주소가 결제·개인정보 주소로 바뀌어 채우지 않았습니다. 다시 찾으세요.";
      }
      return null;
    };
    const before = driftReason();
    if (before) {
      results.push({ id: f.id, label, applied: false, note: before });
      halted = true;
      continue;
    }
    // change를 보내기 전 재검사에서 이 칸 자신이 쓴 값이 '승인 뒤 채워진 개인정보'로 보이지 않게 먼저 기록한다.
    noteWritten(callId, el, expectedSig ?? intended);
    // input 처리기가 action·숨은 값·대상을 바꿨으면 change(제출로 이어질 수 있다)를 보내지 않는다.
    const guard = (): string | null => {
      const changed = recheckApproved(FIELD_KIND, el, info);
      if (changed) return `입력 중 칸이 바뀌어 변경 이벤트를 보내지 않았습니다(${changed}). 다시 찾으세요.`;
      return driftReason();
    };
    let filled: boolean;
    try {
      filled = fillOne(
        el,
        f.value,
        (v) => {
          actual = v;
          // 브라우저가 정리한 실제 값이 개인정보 모양으로 바뀌었으면(요청한 값은 아니었다) 승인 범위 밖이다.
          // 페이지 처리기가 보기 전(input 이벤트 전)에 멈춘다.
          if (v !== intended && looksPersonalValue(v) && !looksPersonalValue(intended)) {
            throw new ChangeBlocked("브라우저가 정리한 입력값이 개인정보 모양이라 입력 이벤트를 보내지 않았습니다. 다시 확인하세요.");
          }
          if (!expectedSig) noteWritten(callId, el, v);
        },
        guard,
      );
    } catch (err) {
      if (!(err instanceof ChangeBlocked)) throw err;
      results.push({ id: f.id, label, applied: false, note: err.message });
      halted = true;
      continue;
    }
    if (!filled) {
      results.push({ id: f.id, label, applied: false, note: "맞는 선택지가 없거나 이 값으로 고를 수 없습니다" });
      continue;
    }
    // 앞선 입력이 넣은 값(선택 칸은 표시 문구가 아니라 option.value)은 승인한 변화다.
    applied.add(decodeDeep(intended));
    if (actual !== undefined) applied.add(decodeDeep(actual));
    if (startName && el.name === startName) {
      appliedPairs.add(`${startName}\u0001${decodeDeep(intended)}`);
      if (actual !== undefined) appliedPairs.add(`${startName}\u0001${decodeDeep(actual)}`);
    }
    // 이 호출이 써 넣은 상태를 값 요약으로 기록한다. checkbox·radio는 처리기가 돌기 전에 정한 상태(expectedSig),
    // 글자 칸은 브라우저가 정리한 실제 값(type=email의 앞뒤 공백 제거 등).
    noteWritten(callId, el, expectedSig ?? actual ?? intended);
    const result: FillResult = { id: f.id, label, applied: false };
    results.push(result);
    written.push({ el, info, value: f.value, actual, result });
  }

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  for (const { el, info, value, actual, result } of written) {
    // input·change 처리기가 칸을 새로 그렸으면 떨어져 나간 이전 요소의 값은 화면과 무관하다.
    if (!el.isConnected) {
      result.note = "입력 뒤 페이지가 칸을 새로 그려 값이 남았는지 확인하지 못했습니다";
      continue;
    }
    // 같은 칸 노드가 다른 행에 다시 쓰였으면 값이 남아 있어도 승인한 칸에 들어간 것이 아니다.
    const changed = recheckApproved(FIELD_KIND, el, info);
    if (changed) {
      result.note = `입력 뒤 칸이 바뀌어 승인한 칸에 반영됐는지 확인하지 못했습니다(${changed})`;
    } else if (appliedValue(el, value) || (actual !== undefined && el.value === actual && sameIgnoringSpace(actual, value))) {
      result.applied = true;
    } else {
      result.note = "페이지가 값을 바꾸거나 받아들이지 않았습니다(최대 길이·서식 등)";
    }
  }
  return { filledCount: results.filter((r) => r.applied).length, results };
}
