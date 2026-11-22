// 선택지와 트리거의 팝업 종류(#316). 종류 추정(content/targets.ts choiceRelation의 basis "kind" — 늘 승인 카드)에서
// 펼친 트리거가 이 선택지의 목록을 열 수 있는 종류인지 본다. ARIA 역할·aria-haspopup 열거값(구조 속성)만 본다 — 화면 글자는 보지 않는다.

export type ChoiceKind = "listbox" | "menu";
export type PopupKind = "listbox" | "menu" | "tree" | "grid" | "dialog" | "unknown";
export type KindMatch = "match" | "maybe" | "no";

const MENU_CHOICES = new Set(["menuitem", "menuitemradio", "menuitemcheckbox"]);
const NAMED_KINDS = new Set(["listbox", "menu", "tree", "grid", "dialog"]);

function token(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

// 선택지 역할의 목록 종류. option → listbox, menuitem* → menu, 그 밖 null.
export function choiceKindOf(role: string | null | undefined): ChoiceKind | null {
  const r = token(role);
  if (r === "option") return "listbox";
  return MENU_CHOICES.has(r) ? "menu" : null;
}

// 트리거가 여는 팝업 종류. haspopup은 속성이 없으면 null.
// combobox: 속성 없음(빈 값·공백은 아님 — unknown)은 ARIA 1.2 암시값 listbox. 이름 있는 값은 그대로. "true"는 listbox로 본다(react-select가 combobox에 붙인다 —
// ARIA상 true는 menu라 kindMatch가 menu 선택지에는 maybe로 센다). false·그 밖 값은 unknown.
// combobox 아님: true → menu, 이름 있는 값은 그대로, 그 밖(false·잘못된 값·없음)은 unknown.
export function triggerPopupKind(role: string | null | undefined, haspopup: string | null | undefined): PopupKind {
  const combobox = token(role) === "combobox";
  const v = haspopup === null || haspopup === undefined ? null : token(haspopup);
  if (combobox) {
    if (v === null || v === "true") return "listbox";
    return NAMED_KINDS.has(v) ? (v as PopupKind) : "unknown";
  }
  if (v === "true") return "menu";
  return v !== null && NAMED_KINDS.has(v) ? (v as PopupKind) : "unknown";
}

// 그 트리거가 이 종류의 선택지 목록을 열 수 있는지. match: 종류가 같음. maybe: 알 수 없음(모호성으로 센다). no: 다른 종류.
// combobox + aria-haspopup=true는 listbox에 match, menu에는 maybe(ARIA상 true는 menu라 실제 메뉴 주인일 수 있다).
export function kindMatch(role: string | null | undefined, haspopup: string | null | undefined, choice: ChoiceKind): KindMatch {
  const kind = triggerPopupKind(role, haspopup);
  if (kind === "unknown") return "maybe";
  if (token(role) === "combobox" && token(haspopup) === "true" && choice === "menu") return "maybe";
  return kind === choice ? "match" : "no";
}
