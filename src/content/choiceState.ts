// 입력 묶음이 쓴 선택 칸의 상태(#62 — 재검사의 예상된 변화 비교용). forms.ts(쓰기·판정)와 targets.ts(기록)가 함께 쓴다.
// 글자가 아니라 실제 상태를 고정한다: select는 선택된 option 하나(요소 참조)와 그 value·선택 상태·select의 name,
// checkbox·radio는 name·value·checked. 처리기가 보이는 글자는 두고 value만 바꾸면 다른 상태다.

import { isTag } from "./docs";

export interface ChoiceState {
  name: string;
  value: string;
  option: Element | null;
  checked: boolean;
}

// 선택 칸이 아니거나 select에서 option이 하나만 골라지지 않았으면 null.
export function choiceState(c: Element): ChoiceState | null {
  if (isTag(c, "select")) {
    const picked = Array.from((c as HTMLSelectElement).selectedOptions);
    if (picked.length !== 1) return null;
    return { name: c.getAttribute("name") ?? "", value: picked[0].value, option: picked[0], checked: picked[0].selected };
  }
  if (isTag(c, "input") && ["checkbox", "radio"].includes((c as HTMLInputElement).type)) {
    const input = c as HTMLInputElement;
    return { name: input.getAttribute("name") ?? "", value: input.value, option: null, checked: input.checked };
  }
  return null;
}

export function sameChoiceState(a: ChoiceState, b: ChoiceState): boolean {
  return a.name === b.name && a.value === b.value && a.option === b.option && a.checked === b.checked;
}
