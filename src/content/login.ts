// 자동 로그인(sign_in, docs/design/login-automation.md)의 페이지 쪽. 모델이 고른 칸 둘레의 로그인 양식을 구조로 읽고(login_inspect),
// 백그라운드가 비밀번호 관리자에서 받은 값을 넣은 뒤 양식을 제출한다(login_fill). 판정은 칸 종류·autocomplete·양식 관계·제출
// 주소와 메서드로만 한다(낱말로 로그인 화면을 짐작하지 않는다). 값은 이 파일에서 돌려주지 않는다.
import type { LoginShape } from "@/lib/loginPolicy";
import { isTag } from "./docs";
import { fillFormFields, formDestinations, formElements, layoutVisible, registerFieldTarget, isSubmitControl } from "./forms";
import { registerClickTarget } from "./clickables";
import { inspectTargets, registeredElement } from "./targets";

// 승인 대상 등록의 호출 id. 칸 묶음과 제출 버튼을 따로 둔다(승인 당시 상태 기록이 호출마다 하나라 섞이지 않게).
const submitCallId = (callId: string) => `${callId}:submit`;

function autocompleteTokens(el: Element): string[] {
  return (el.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

function isTextInput(el: Element): el is HTMLInputElement {
  if (!isTag(el, "input")) return false;
  const t = (el as HTMLInputElement).type;
  return t === "text" || t === "email" || t === "tel" || t === "";
}

function usable(el: Element): el is HTMLInputElement {
  return isTag(el, "input") && !(el as HTMLInputElement).disabled && layoutVisible(el as HTMLElement);
}

// 칸의 양식 범위: <form>이면 그 양식의 컨트롤(form 속성으로 바깥에서 연결된 칸 포함), 아니면 가장 가까운 대화상자 또는 문서 본문.
function scopeInputs(el: HTMLInputElement): { form: HTMLFormElement | null; inputs: HTMLInputElement[] } {
  const form = el.form;
  if (form) return { form, inputs: formElements(form).filter((c): c is HTMLInputElement => isTag(c, "input")) };
  const root = el.closest("dialog, [role='dialog'], [aria-modal='true']") ?? el.ownerDocument.body ?? el.ownerDocument.documentElement;
  return { form: null, inputs: Array.from(root.querySelectorAll("input")) };
}

// 양식이 실제로 쓰는 제출 메서드들(양식의 method와 제출 버튼들의 formmethod). 소문자.
function submitMethods(form: HTMLFormElement): string[] {
  const out = new Set<string>([(form.getAttribute("method") ?? "get").trim().toLowerCase() || "get"]);
  for (const c of formElements(form)) {
    if (isSubmitControl(c) && c.hasAttribute("formmethod")) out.add((c.getAttribute("formmethod") ?? "").trim().toLowerCase() || "get");
  }
  for (const img of Array.from(form.ownerDocument.querySelectorAll('input[type="image" i]'))) {
    if ((img as HTMLInputElement).form === form && img.hasAttribute("formmethod")) {
      out.add((img.getAttribute("formmethod") ?? "").trim().toLowerCase() || "get");
    }
  }
  return [...out].map((m) => (m === "post" || m === "dialog" ? m : "get"));
}

// 양식의 기본 제출 버튼(HTML의 암묵적 제출이 쓰는 첫 제출 컨트롤).
function defaultSubmitter(form: HTMLFormElement): HTMLElement | null {
  for (const c of formElements(form)) if (isSubmitControl(c)) return c as HTMLElement;
  return null;
}

interface Picked {
  step: LoginShape["step"];
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
  otp: HTMLInputElement | null;
  form: HTMLFormElement | null;
  newPassword: boolean;
}

function pick(target: HTMLInputElement): Picked {
  const { form, inputs } = scopeInputs(target);
  const visible = inputs.filter(usable);
  const passwords = visible.filter((i) => i.type === "password");
  const newPassword = passwords.length > 1 || visible.some((i) => autocompleteTokens(i).includes("new-password"));
  const base = { form, newPassword };
  if (autocompleteTokens(target).includes("one-time-code")) {
    return { ...base, step: "otp", username: null, password: null, otp: target };
  }
  if (target.type === "password" || passwords.length === 1) {
    const password = target.type === "password" ? target : passwords[0];
    // 아이디 칸: 같은 범위의 autocomplete=username, 없으면 비밀번호 칸 바로 앞의 보이는 글자 칸.
    let username = visible.find((i) => i !== password && autocompleteTokens(i).includes("username")) ?? null;
    if (!username) {
      const before = visible.slice(0, visible.indexOf(password)).filter(isTextInput);
      username = before[before.length - 1] ?? null;
    }
    return { ...base, step: "password", username, password, otp: null };
  }
  if (passwords.length === 0) {
    const tokens = autocompleteTokens(target);
    const others = visible.filter((i) => i !== target && isTextInput(i));
    if ((tokens.includes("username") || tokens.includes("email")) && isTextInput(target) && others.length === 0) {
      return { ...base, step: "username", username: target, password: null, otp: null };
    }
  }
  throw new Error(
    "로그인 칸으로 볼 수 없습니다(보이는 비밀번호 칸, autocomplete=username인 아이디 칸, autocomplete=one-time-code인 코드 칸 중 하나여야 합니다).",
  );
}

// 이 호출(callId)의 로그인 모양. 넣을 칸과 제출 버튼을 이 호출의 승인 대상으로 등록하고 그 기술을 함께 돌려준다.
export function inspectLogin(id: string, callId: string): LoginShape {
  const target = registeredElement(id, "f");
  if (!isTag(target, "input")) throw new Error("로그인 칸은 input이어야 합니다.");
  const p = pick(target as HTMLInputElement);
  const fieldEls = [p.username, p.password, p.otp].filter((e): e is HTMLInputElement => !!e);
  const ids = fieldEls.map((e) => (e === target ? id : registerFieldTarget(e)));
  const fields = inspectTargets(ids, callId, "f");
  const idOf = (e: HTMLInputElement | null) => (e ? ids[fieldEls.indexOf(e)] : undefined);
  const doc = target.ownerDocument;
  const submitter = p.form ? defaultSubmitter(p.form) : null;
  let submitId: string | undefined;
  let submit: LoginShape["submit"];
  if (submitter && layoutVisible(submitter)) {
    submitId = registerClickTarget(submitter);
    [submit] = inspectTargets([submitId], submitCallId(callId), "c");
  }
  const submitUrls = new Set<string>();
  if (p.form) for (const u of formDestinations(p.form)) submitUrls.add(u);
  for (const f of fields) for (const u of [f.submitTo ?? "", ...(f.scopeFormActions ?? []), ...(f.aroundFormActions ?? [])]) if (u) submitUrls.add(u);
  return {
    step: p.step,
    frameUrl: doc.URL,
    topUrl: window.location.href,
    newPassword: p.newPassword,
    hasForm: !!p.form,
    submitUrls: [...submitUrls],
    submitMethods: p.form ? submitMethods(p.form) : [],
    ...(idOf(p.username) ? { usernameId: idOf(p.username) } : {}),
    ...(idOf(p.password) ? { passwordId: idOf(p.password) } : {}),
    ...(idOf(p.otp) ? { otpId: idOf(p.otp) } : {}),
    ...(submitId ? { submitId } : {}),
    fields,
    ...(submit ? { submit } : {}),
  };
}

export interface LoginFillResult {
  // 값을 넣은 칸 수(이미 같은 값이라 건드리지 않은 칸 포함).
  filled: number;
  total: number;
  submitted: boolean;
  // 채우지 못했거나 제출하지 않은 이유(값을 담지 않는다).
  note?: string;
}

// 값을 넣고 제출한다. 칸은 승인 때 확인한 것과 같아야 한다(fillFormFields가 칸마다 다시 본다). 제출 직전에 양식의 제출 주소·메서드가
// 승인 때와 같은지 다시 본다(넣는 사이 처리기가 양식을 바꿨으면 제출하지 않는다).
export async function fillLogin(
  callId: string,
  fills: Array<{ id: string; value: string }>,
  submit: { submitId?: string; submitUrls: string[]; submitMethods: string[] } | null,
): Promise<LoginFillResult> {
  const anchor = fills[0] ? registeredElement(fills[0].id, "f") : null;
  // 아이디 칸에 이미 같은 값이 있으면(브라우저 자동 채우기 등) 건드리지 않는다.
  const todo = fills.filter((f) => {
    const el = registeredElement(f.id, "f") as HTMLInputElement;
    return !(el.type !== "password" && el.value === f.value);
  });
  const total = fills.length;
  if (todo.length) {
    const res = await fillFormFields({ fills: todo }, callId);
    if (res.filledCount !== res.results.length) {
      return { filled: res.filledCount, total, submitted: false, note: "일부 칸에 값이 들어가지 않아 제출하지 않았습니다." };
    }
  }
  if (!submit) return { filled: total, total, submitted: false };
  const form = anchor && isTag(anchor, "input") ? (anchor as HTMLInputElement).form : null;
  if (!form || !form.isConnected) return { filled: total, total, submitted: false, note: "양식이 사라져 제출하지 않았습니다." };
  const urls = formDestinations(form);
  const methods = submitMethods(form);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  if (!urls.every((u) => submit.submitUrls.includes(u)) || !same(methods, submit.submitMethods)) {
    return { filled: total, total, submitted: false, note: "값을 넣는 사이 양식의 제출 주소·방법이 바뀌어 제출하지 않았습니다." };
  }
  let submitter: HTMLElement | null = null;
  if (submit.submitId) {
    submitter = registeredElement(submit.submitId, "c");
    if (defaultSubmitter(form) !== submitter || !layoutVisible(submitter)) {
      return { filled: total, total, submitted: false, note: "제출 버튼이 바뀌어 제출하지 않았습니다." };
    }
  }
  form.requestSubmit(submitter);
  return { filled: total, total, submitted: true };
}

// 제출 뒤: 비밀번호 칸이 같은 문서에 그대로 보이는지(그대로면 실패일 수 있다).
export function loginFieldStillShown(id: string): boolean {
  try {
    const el = registeredElement(id, "f");
    return el.isConnected && layoutVisible(el);
  } catch {
    return false;
  }
}
