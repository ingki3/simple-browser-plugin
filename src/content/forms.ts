import type { FormField } from "@/lib/messages";
import type { TargetInfo } from "@/lib/actionTarget";
import { getAccessibleRoots, isTag } from "./docs";
import { peekApproved, registerTarget, takeApproved, type TargetKind } from "./targets";

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

const PAYMENT_RE = /(card.?(num|no)|cardnumber|cvc|cvv|카드\s*번호|보안\s*코드)/i;

function sensitivityOf(el: HTMLElement): TargetInfo["sensitive"] {
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if ((isTag(el, "input") && el.type === "password") || /password/.test(ac)) return "password";
  if (/\bcc-/.test(ac)) return "payment";
  const hint = `${el.getAttribute("name") ?? ""} ${el.id} ${isFieldElement(el) ? resolveLabel(el) : ""}`;
  if (PAYMENT_RE.test(hint)) return "payment";
  return null;
}

const FIELD_KIND: TargetKind = {
  prefix: "f",
  attr: "data-sbp-fid",
  selector: "input, textarea, select",
  visible: isVisible,
  name: (el) => (isFieldElement(el) ? resolveLabel(el).replace(/\s+/g, " ").slice(0, 200) : ""),
  fieldType: (el) => (isFieldElement(el) ? describeType(el) : ""),
  sensitive: sensitivityOf,
};

function currentValueOf(el: FieldElement): string {
  if (isTag(el, "input") && (el.type === "checkbox" || el.type === "radio")) {
    return el.checked ? `checked (value=${el.value})` : `unchecked (value=${el.value})`;
  }
  return el.value ?? "";
}

export function findFormFields(args: { onlyVisible?: boolean }): FormField[] {
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

// 승인 카드에서 확인한 칸들이 모두 그대로일 때만 채운다. 하나라도 바뀌었으면 아무것도 채우지 않는다.
export function fillFormFields(
  args: { fills: Array<{ id: string; value: string }> },
  callId: string,
): { filledCount: number; results: FillResult[] } {
  const ids = args.fills.map((f) => f.id);
  if (new Set(ids).size !== ids.length) throw new Error("같은 칸 id가 두 번 들어 있습니다. 칸마다 한 번만 지정하세요.");
  for (const id of ids) peekApproved(id, callId);

  const results: FillResult[] = [];
  for (const f of args.fills) {
    let el: HTMLElement;
    try {
      // 앞 칸을 채우면서 페이지가 다시 그려졌을 수 있어 칸마다 다시 확인한다. 바뀐 칸만 건너뛴다.
      el = takeApproved(f.id, callId);
    } catch (err) {
      results.push({ id: f.id, label: "", applied: false, note: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!isFieldElement(el)) throw new Error(`id '${f.id}'는 입력 칸이 아닙니다.`);
    const label = FIELD_KIND.name(el);
    if (!fillOne(el, f.value)) {
      results.push({ id: f.id, label, applied: false, note: "맞는 선택지가 없거나 이 값으로 고를 수 없습니다" });
      continue;
    }
    const applied = appliedValue(el, f.value);
    results.push(
      applied
        ? { id: f.id, label, applied }
        : { id: f.id, label, applied, note: "페이지가 값을 바꾸거나 받아들이지 않았습니다(최대 길이·서식 등)" },
    );
  }
  return { filledCount: results.filter((r) => r.applied).length, results };
}
