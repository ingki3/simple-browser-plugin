import type { FormField } from "@/lib/messages";
import { findElementByAttr, getAccessibleDocs } from "./docs";

const FIELD_ATTR = "data-sbp-fid";
let counter = 0;

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  return true;
}

function resolveLabel(el: HTMLElement): string {
  const doc = el.ownerDocument;
  if (el.id) {
    const byFor = doc.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor?.textContent) return byFor.textContent.trim();
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const ref = doc.getElementById(labelledBy);
    if (ref?.textContent) return ref.textContent.trim();
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.placeholder?.trim() ?? "";
  }
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

function describeType(el: HTMLElement): string {
  if (el instanceof HTMLInputElement) return el.type || "text";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  return el.tagName.toLowerCase();
}

export function findFormFields(args: { onlyVisible?: boolean }): FormField[] {
  const onlyVisible = args.onlyVisible !== false;
  const fields: FormField[] = [];

  for (const doc of getAccessibleDocs()) {
    const nodes = doc.querySelectorAll<HTMLElement>("input, textarea, select");
    nodes.forEach((el) => {
      if (el instanceof HTMLInputElement) {
        const skip = ["hidden", "submit", "reset", "button", "image"];
        if (skip.includes(el.type)) return;
      }
      if (onlyVisible && !isVisible(el)) return;
      if ((el as HTMLInputElement).disabled) return;
      if ((el as HTMLInputElement).readOnly) return;

      const id = ensureId(el);
      const label = resolveLabel(el);
      const placeholder =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.placeholder ?? ""
          : "";
      const currentValue =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
          ? (el as HTMLInputElement).value ?? ""
          : "";

      fields.push({
        id,
        label,
        placeholder,
        type: describeType(el),
        role: el.getAttribute("role") ?? "",
        currentValue,
      });
    });
  }

  return fields;
}

export function fillFormFields(args: {
  fills: Array<{ id: string; value: string }>;
}): { filledCount: number } {
  let filled = 0;
  for (const f of args.fills) {
    const el = findElementByAttr(FIELD_ATTR, f.id);
    if (!el) continue;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (setter) setter.call(el, f.value);
      else el.value = f.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      filled += 1;
    } else if (el instanceof HTMLSelectElement) {
      const want = f.value;
      const match = Array.from(el.options).find(
        (opt) => opt.value === want || opt.textContent?.trim() === want,
      );
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        filled += 1;
      }
    }
  }
  return { filledCount: filled };
}
