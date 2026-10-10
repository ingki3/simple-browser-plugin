import type { FormField } from "@/lib/messages";
import { findElementByAttr, getAccessibleRoots, isTag } from "./docs";

const FIELD_ATTR = "data-sbp-fid";
const SKIP_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image", "file"]);
const TRUTHY_VALUES = /^(true|1|on|yes|y|checked|check|예|네|체크|선택)$/i;
let counter = 0;

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

function resolveLabel(el: FieldElement): string {
  // shadow root 안의 필드는 label도 같은 shadow root 안에 있다.
  const root = el.getRootNode() as Document | ShadowRoot;
  if (el.id) {
    const byFor = root.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor?.textContent) return byFor.textContent.trim();
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
  if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();
  if (!isTag(el, "select")) return el.placeholder?.trim() ?? "";
  return "";
}

function ensureId(el: HTMLElement): string {
  let id = el.getAttribute(FIELD_ATTR);
  if (id) return id;
  counter += 1;
  id = `f${counter}`;
  el.setAttribute(FIELD_ATTR, id);
  return id;
}

function describeType(el: FieldElement): string {
  if (isTag(el, "input")) return el.type || "text";
  if (isTag(el, "textarea")) return "textarea";
  return "select";
}

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
        id: ensureId(el),
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

export function fillFormFields(args: {
  fills: Array<{ id: string; value: string }>;
}): { filledCount: number } {
  let filled = 0;
  for (const f of args.fills) {
    const el = findElementByAttr(FIELD_ATTR, f.id);
    if (!el || !isFieldElement(el)) continue;
    if (fillOne(el, f.value)) filled += 1;
  }
  return { filledCount: filled };
}
