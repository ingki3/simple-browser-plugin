// 자동 로그인(sign_in, docs/design/login-automation.md)의 페이지 쪽. 모델이 고른 칸 둘레의 로그인 양식을 구조로 읽고(login_inspect),
// 백그라운드가 비밀번호 관리자에서 받은 값을 넣은 뒤 양식을 제출한다(login_fill). 판정은 칸 종류·autocomplete·양식 관계·제출
// 주소와 메서드로만 한다(낱말로 로그인 화면을 짐작하지 않는다). 값은 이 파일에서 돌려주지 않는다.
import { loginShapeBlock, submitControlBlock, type LoginShape } from "@/lib/loginPolicy";
import { isShadowRoot, isTag } from "./docs";
import { DESTRUCTIVE_REASON, DESTRUCTIVE_TEXT_RE, PAYMENT_TEXT_RE, splitIdentifier } from "@/lib/autoApprove";
import {
  declaresDelete,
  fillFormFields,
  formDestinations,
  formElements,
  isSubmitControl,
  layoutVisible,
  personalValuedElements,
  registerFieldTarget,
} from "./forms";
import { registerClickTarget } from "./clickables";
import { inspectTargets, registeredElement } from "./targets";

// 백그라운드가 중단을 알린 호출(값을 넣는 사이 사용자가 멈추면 제출하지 않는다).
const cancelled = new Set<string>();

export function cancelLogin(callId: string): void {
  cancelled.add(callId);
  if (cancelled.size > 50) cancelled.delete(cancelled.values().next().value as string);
}

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

// 양식이 없을 때의 범위: 가장 가까운 대화상자, 없으면 칸이 든 shadow root 또는 문서 본문.
function formlessRoot(el: Element): Element | ShadowRoot {
  const dialog = el.closest("dialog, [role='dialog'], [aria-modal='true']");
  if (dialog) return dialog;
  // 같은 출처 iframe의 shadow root는 이 창의 ShadowRoot가 아니어서 창과 무관한 판별을 쓴다.
  const root = el.getRootNode();
  if (isShadowRoot(root)) return root;
  return el.ownerDocument.body ?? el.ownerDocument.documentElement;
}

// 칸의 양식 범위: <form>이면 그 양식의 컨트롤(form 속성으로 바깥에서 연결된 칸 포함), 아니면 formlessRoot 안의 칸.
function scopeInputs(el: HTMLInputElement): { form: HTMLFormElement | null; inputs: HTMLInputElement[] } {
  const form = el.form;
  if (form) return { form, inputs: formElements(form).filter((c): c is HTMLInputElement => isTag(c, "input")) };
  const inputs = Array.from(formlessRoot(el).querySelectorAll("input"));
  // 범위 조회가 대상 자신을 못 찾는 구조(다른 shadow root)여도 대상은 늘 본다.
  if (!inputs.includes(el)) inputs.push(el);
  return { form: null, inputs };
}

// 아이디 칸으로 대신 고를 수 있는 칸: autocomplete가 비었거나 아이디·이메일 뜻일 때만(주소·이름 등 다른 뜻을 밝힌 칸은 아님).
const USERNAME_LIKE_TOKENS = new Set(["on", "off", "username", "email", "webauthn"]);
function usernameCandidate(el: HTMLInputElement): boolean {
  return autocompleteTokens(el)
    .filter((t) => !t.startsWith("section-"))
    .every((t) => USERNAME_LIKE_TOKENS.has(t));
}

// 양식이 실제로 쓰는 제출 메서드들(양식의 method와 제출 버튼들의 formmethod). 소문자.
function submitMethods(form: HTMLFormElement): string[] {
  const out = new Set<string>([(form.getAttribute("method") ?? "get").trim().toLowerCase() || "get"]);
  for (const c of formElements(form)) {
    if (isSubmitControl(c) && c.hasAttribute("formmethod")) out.add((c.getAttribute("formmethod") ?? "").trim().toLowerCase() || "get");
  }
  // form.elements는 이미지 버튼을 빼므로 양식이 든 루트(shadow root 포함)에서 따로 찾는다.
  for (const img of Array.from((form.getRootNode() as Document | ShadowRoot).querySelectorAll('input[type="image" i]'))) {
    if ((img as HTMLInputElement).form === form && img.hasAttribute("formmethod")) {
      out.add((img.getAttribute("formmethod") ?? "").trim().toLowerCase() || "get");
    }
  }
  return [...out].map((m) => (m === "post" || m === "dialog" ? m : "get"));
}

// 양식의 기본 제출 버튼(HTML의 암묵적 제출이 쓰는 첫 제출 컨트롤).
// form.elements는 이미지 버튼을 빼므로 양식이 든 루트에서 그 양식의 이미지 버튼을 더하고 문서 순서로 첫 것을 고른다.
function defaultSubmitter(form: HTMLFormElement): HTMLElement | null {
  const list: HTMLElement[] = formElements(form).filter(isSubmitControl) as HTMLElement[];
  for (const img of Array.from((form.getRootNode() as Document | ShadowRoot).querySelectorAll('input[type="image" i]'))) {
    if ((img as HTMLInputElement).form === form && !list.includes(img as HTMLElement)) list.push(img as HTMLElement);
  }
  list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return list[0] ?? null;
}

// 숨은 기본 제출 버튼의 위험(클릭 대상 기술은 보이는 요소만 만들 수 있어 구조와 글자로 따로 본다 — 더 묻는 쪽).
function hiddenSubmitterBlock(btn: HTMLElement, form: HTMLFormElement): string | null {
  if (declaresDelete(btn, [btn], form)) return DESTRUCTIVE_REASON;
  const text = ["value", "alt", "aria-label", "title"].map((a) => btn.getAttribute(a) ?? "").join(" ") + ` ${btn.textContent ?? ""}`;
  const words = `${text} ${splitIdentifier(text)}`;
  if (DESTRUCTIVE_TEXT_RE.test(words)) return DESTRUCTIVE_REASON;
  if (PAYMENT_TEXT_RE.test(words)) return "결제·주문 버튼";
  return null;
}

// 기본 제출 버튼의 지금 위험(보이면 클릭 대상 기술로, 숨었으면 구조·글자로).
function submitterRisk(btn: HTMLElement, form: HTMLFormElement, callId: string): string | null {
  if (!layoutVisible(btn)) return hiddenSubmitterBlock(btn, form);
  const [info] = inspectTargets([registerClickTarget(btn)], callId, "c");
  return submitControlBlock(info);
}

interface Picked {
  step: LoginShape["step"];
  username: HTMLInputElement | null;
  password: HTMLInputElement | null;
  otp: HTMLInputElement | null;
  form: HTMLFormElement | null;
  newPassword: boolean;
  // 양식에 넣을 칸 밖의 보이는 입력 칸(글자·선택·긴 글)이나 값이 채워진 개인정보 칸이 함께 있는지. 로그인이 아니라 정보 수정
  // 양식일 수 있다(주소가 채워진 '저장' 양식 등). checkbox·radio(로그인 상태 유지 등)는 세지 않는다.
  otherFields: boolean;
}

function pick(target: HTMLInputElement): Picked {
  const { form, inputs } = scopeInputs(target);
  const visible = inputs.filter(usable);
  const passwords = visible.filter((i) => i.type === "password");
  const newPassword =
    passwords.length > 1 ||
    autocompleteTokens(target).includes("new-password") ||
    visible.some((i) => autocompleteTokens(i).includes("new-password"));
  const hasOtherFields = (picked: Array<HTMLInputElement | null>): boolean => {
    const mine = new Set(picked.filter(Boolean) as Element[]);
    // 양식이 없는 화면은 같은 범위(대화상자 또는 문서 본문)의 모든 칸을 본다(정보 수정 화면의 change 처리기가 바로 저장할 수 있다).
    const controls: Element[] = form ? formElements(form) : Array.from(formlessRoot(target).querySelectorAll("input, select, textarea"));
    const shown = controls.some((c) => {
      if (mine.has(c)) return false;
      if (isTag(c, "select") || isTag(c, "textarea")) return layoutVisible(c as HTMLElement);
      if (!isTag(c, "input")) return false;
      const t = (c as HTMLInputElement).type;
      if (["hidden", "submit", "button", "reset", "image", "checkbox", "radio"].includes(t)) return false;
      return layoutVisible(c as HTMLElement);
    });
    return shown || (!!form && personalValuedElements(form).some((e) => !mine.has(e)));
  };
  const base = { form, newPassword };
  if (autocompleteTokens(target).includes("one-time-code")) {
    return { ...base, step: "otp", username: null, password: null, otp: target, otherFields: hasOtherFields([target]) };
  }
  if (target.type === "password" || passwords.length === 1) {
    const password = target.type === "password" ? target : passwords[0];
    // 아이디 칸: 같은 범위의 autocomplete=username, 없으면 비밀번호 칸 바로 앞의 보이는 글자 칸.
    let username = visible.find((i) => i !== password && autocompleteTokens(i).includes("username")) ?? null;
    if (!username) {
      const before = visible.slice(0, visible.indexOf(password)).filter((i) => isTextInput(i) && usernameCandidate(i));
      username = before[before.length - 1] ?? null;
    }
    return { ...base, step: "password", username, password, otp: null, otherFields: hasOtherFields([username, password]) };
  }
  if (passwords.length === 0) {
    const tokens = autocompleteTokens(target);
    const others = visible.filter((i) => i !== target && isTextInput(i));
    if ((tokens.includes("username") || tokens.includes("email")) && isTextInput(target) && others.length === 0) {
      return { ...base, step: "username", username: target, password: null, otp: null, otherFields: hasOtherFields([target]) };
    }
  }
  throw new Error(
    "로그인 칸으로 볼 수 없습니다(보이는 비밀번호 칸, autocomplete=username인 아이디 칸, autocomplete=one-time-code인 코드 칸 중 하나여야 합니다).",
  );
}

// 승인 때 읽은 구조(호출별). 값을 넣기 직전에 지금 구조와 같은지 본다.
const inspected = new Map<string, { targetId: string; picked: Picked }>();

function samePick(a: Picked, b: Picked): boolean {
  return (
    a.step === b.step &&
    a.newPassword === b.newPassword &&
    a.otherFields === b.otherFields &&
    a.username === b.username &&
    a.password === b.password &&
    a.otp === b.otp &&
    a.form === b.form
  );
}

// 이 호출(callId)의 로그인 모양. 넣을 칸과 제출 버튼을 이 호출의 승인 대상으로 등록하고 그 기술을 함께 돌려준다.
export function inspectLogin(id: string, callId: string): LoginShape {
  const target = registeredElement(id, "f");
  if (!isTag(target, "input")) throw new Error("로그인 칸은 input이어야 합니다.");
  const p = pick(target as HTMLInputElement);
  inspected.set(callId, { targetId: id, picked: p });
  if (inspected.size > 50) inspected.delete(inspected.keys().next().value as string);
  return buildShape(target as HTMLInputElement, id, p, callId);
}

// targetId가 null이면 모든 칸을 지금 기술로 다시 등록한다(값을 넣은 뒤 제출 직전 재판정 — 승인 대상은 바꾸지 않는 별도 callId로).
function buildShape(target: HTMLInputElement, targetId: string | null, p: Picked, callId: string): LoginShape {
  const fieldEls = [p.username, p.password, p.otp].filter((e): e is HTMLInputElement => !!e);
  const ids = fieldEls.map((e) => (e === target && targetId ? targetId : registerFieldTarget(e)));
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
  const hiddenSubmitBlock = submitter && p.form && !layoutVisible(submitter) ? hiddenSubmitterBlock(submitter, p.form) : null;
  const submitUrls = new Set<string>();
  if (p.form) for (const u of formDestinations(p.form)) submitUrls.add(u);
  for (const f of fields) for (const u of [f.submitTo ?? "", ...(f.scopeFormActions ?? []), ...(f.aroundFormActions ?? [])]) if (u) submitUrls.add(u);
  return {
    step: p.step,
    frameUrl: doc.URL,
    topUrl: window.location.href,
    newPassword: p.newPassword,
    otherFields: p.otherFields,
    hiddenSubmitBlock,
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
  // 승인 때의 구조 판정(카드로 승인했으면 그때 보인 이유, 자동이면 null)과 값을 받을 출처. 제출 직전 다시 판정해 새 이유가 생기면
  // 제출하지 않는다.
  approved: { origin: string; block: string | null } | null = null,
): Promise<LoginFillResult> {
  // 값을 쓰기 전에 승인 때의 구조(단계·새 비밀번호 칸 유무·넣을 칸·양식)가 그대로인지 본다
  // (기다리는 사이 autocomplete가 new-password로 바뀌는 등).
  const before = inspected.get(callId);
  inspected.delete(callId);
  if (!before) throw new Error("로그인 칸을 다시 확인하세요.");
  let now: Picked;
  try {
    now = pick(registeredElement(before.targetId, "f") as HTMLInputElement);
  } catch {
    return { filled: 0, total: fills.length, submitted: false, note: "승인한 뒤 로그인 양식이 바뀌어 넣지 않았습니다." };
  }
  if (!samePick(before.picked, now)) {
    return { filled: 0, total: fills.length, submitted: false, note: "승인한 뒤 로그인 양식이 바뀌어 넣지 않았습니다." };
  }
  const anchor = fills[0] ? registeredElement(fills[0].id, "f") : null;
  // 제출 방법·주소가 승인 때와 같은지: 쓰기 전과 칸마다(입력 이벤트 사이) 본다. change 처리기가 바로 제출하는 양식이
  // 그사이 GET·다른 주소로 바뀌었으면 값을 넣지 않는다.
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
  const formDrift = (): string | null => {
    // 입력 처리기가 칸을 새 비밀번호 칸으로 바꾸거나 칸·양식을 바꿨으면(가입·변경 화면으로 바뀜) 멈춘다.
    let again: Picked;
    try {
      again = pick(registeredElement(before.targetId, "f") as HTMLInputElement);
    } catch {
      return "입력 중 로그인 양식이 바뀌어 넣지 않았습니다.";
    }
    if (!samePick(before.picked, again)) return "입력 중 로그인 양식이 바뀌어 넣지 않았습니다.";
    if (!submit || !now.form) return null;
    // 기본 제출 버튼의 위험 신호(삭제 선언·결제 등)를 입력 이벤트마다 다시 본다(처리기가 그 버튼으로 바로 제출할 수 있다).
    // 버튼이 승인 때와 같아도 기술은 바뀔 수 있어(값을 넣으면 켜짐 등) 지금 기술로 다시 등록해 위험만 본다.
    const ds = defaultSubmitter(now.form);
    if (ds) {
      const why = submitterRisk(ds, now.form, `${callId}:guard`);
      if (why && why !== approved?.block) return `제출 버튼에 위험 신호가 생겨 넣지 않았습니다(${why}).`;
    }
    if (!now.form.isConnected) return "양식이 사라졌습니다.";
    const urls = formDestinations(now.form);
    if (!urls.every((u) => submit.submitUrls.includes(u)) || !same(submitMethods(now.form), submit.submitMethods)) {
      return "승인한 뒤 양식의 제출 주소·방법이 바뀌어 넣지 않았습니다.";
    }
    return null;
  };
  const drift = formDrift();
  if (drift) return { filled: 0, total: fills.length, submitted: false, note: drift };
  // 아이디 칸에 이미 같은 값이 있으면(브라우저 자동 채우기 등) 건드리지 않는다.
  const todo = fills.filter((f) => {
    const el = registeredElement(f.id, "f") as HTMLInputElement;
    return !(el.type !== "password" && el.value === f.value);
  });
  const total = fills.length;
  let submittedByPage = false;
  if (todo.length) {
    // 입력·변경 처리기가 양식을 바로 제출하는 페이지(일회용 코드 자동 제출 등)면 다시 제출하지 않는다.
    // submit 이벤트는 shadow 경계를 넘지 않으므로 양식에 직접 단다.
    const formEl = now.form;
    const onSubmit = () => {
      submittedByPage = true;
    };
    formEl?.addEventListener("submit", onSubmit, true);
    let res: Awaited<ReturnType<typeof fillFormFields>>;
    try {
      res = await fillFormFields({ fills: todo }, callId, formDrift);
    } finally {
      formEl?.removeEventListener("submit", onSubmit, true);
    }
    // 페이지가 이미 제출했으면(그 뒤 칸을 지워 반영 확인이 실패해도) 제출한 것으로 알린다.
    if (submittedByPage) return { filled: res.filledCount, total, submitted: true, note: "페이지가 입력 중에 양식을 제출했습니다." };
    if (res.filledCount !== res.results.length) {
      return { filled: res.filledCount, total, submitted: false, note: "일부 칸에 값이 들어가지 않아 제출하지 않았습니다." };
    }
  }
  if (cancelled.has(callId)) return { filled: total, total, submitted: false, note: "중단되어 제출하지 않았습니다." };
  if (!submit) return { filled: total, total, submitted: false };
  const driftAfter = formDrift();
  if (driftAfter) return { filled: total, total, submitted: false, note: driftAfter.replace("넣지 않았습니다", "제출하지 않았습니다") };
  // 제출 직전에 지금 모습으로 로그인 구조를 다시 판정한다(쓰기를 건너뛴 칸이 있어도 — 기다리는 사이 숨은 값이 결제로 바뀌는 등).
  if (approved) {
    const targetEl = registeredElement(before.targetId, "f") as HTMLInputElement;
    const recheckId = `${callId}:recheck`;
    const fresh = buildShape(targetEl, null, pick(targetEl), recheckId);
    const why = loginShapeBlock(fresh, approved.origin);
    if (why && why !== approved.block) {
      return { filled: total, total, submitted: false, note: `값을 넣은 뒤 양식에 새 위험이 보여 제출하지 않았습니다(${why}).` };
    }
  }
  const form = anchor && isTag(anchor, "input") ? (anchor as HTMLInputElement).form : null;
  if (!form || !form.isConnected) return { filled: total, total, submitted: false, note: "양식이 사라져 제출하지 않았습니다." };
  const urls = formDestinations(form);
  const methods = submitMethods(form);
  if (!urls.every((u) => submit.submitUrls.includes(u)) || !same(methods, submit.submitMethods)) {
    return { filled: total, total, submitted: false, note: "값을 넣는 사이 양식의 제출 주소·방법이 바뀌어 제출하지 않았습니다." };
  }
  let submitter: HTMLElement | null = null;
  if (submit.submitId) {
    submitter = registeredElement(submit.submitId, "c");
    if (defaultSubmitter(form) !== submitter || !layoutVisible(submitter)) {
      return { filled: total, total, submitted: false, note: "제출 버튼이 바뀌어 제출하지 않았습니다." };
    }
    // 아직 비활성인 버튼(보안 문자·서버 확인을 기다리는 화면)으로는 제출하지 않는다.
    if ((submitter as HTMLButtonElement).disabled || submitter.matches(":disabled")) {
      return {
        filled: total,
        total,
        submitted: false,
        note: "로그인 버튼이 아직 비활성이라 제출하지 않았습니다. 화면을 관측해 남은 단계(보안 문자 등)를 사용자에게 알리세요.",
      };
    }
    // 승인 뒤 제출 버튼에 삭제 선언·결제 신호가 생겼는지 지금 모습으로 다시 본다(넣은 값은 개인정보 변화가 아니라 이 호출이 넣은 것).
    // 값을 넣으면 활성화되는 버튼(disabled 해제)처럼 기술이 바뀌는 것은 정상이라, 같은 요소를 지금 기술로 다시 등록해 위험 신호만 본다.
    const freshId = registerClickTarget(submitter);
    const [now] = inspectTargets([freshId], submitCallId(callId), "c");
    const why = submitControlBlock(now);
    if (why) return { filled: total, total, submitted: false, note: `제출 버튼에 위험 신호가 생겨 제출하지 않았습니다(${why}).` };
  } else {
    // 승인 때 보이는 제출 버튼이 없었는데 지금 생겼으면(그 버튼의 위험 신호를 보지 않았다) 제출하지 않는다.
    const appeared = defaultSubmitter(form);
    if (appeared && layoutVisible(appeared)) {
      return { filled: total, total, submitted: false, note: "제출 버튼이 새로 생겨 제출하지 않았습니다." };
    }
  }
  if (cancelled.has(callId)) return { filled: total, total, submitted: false, note: "중단되어 제출하지 않았습니다." };
  // 기본 제출 버튼이 비활성이면(숨겨진 버튼 포함) 페이지가 제출을 보류한 것이다. 암묵적 제출로 우회하지 않는다.
  const implicit = defaultSubmitter(form) as HTMLButtonElement | null;
  if (implicit && (implicit.disabled || implicit.matches(":disabled"))) {
    return {
      filled: total,
      total,
      submitted: false,
      note: "로그인 버튼이 아직 비활성이라 제출하지 않았습니다. 화면을 관측해 남은 단계(보안 문자 등)를 사용자에게 알리세요.",
    };
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
