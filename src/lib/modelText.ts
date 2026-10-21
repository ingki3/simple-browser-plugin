// 찾기·실행 도구가 모델에 돌려주는 글자의 경계(#43). 화면 글자(페이지가 만든 글자)는 보내고, 사용자가 입력한 값은
// 보내지 않는다. 판정은 구조(요소 종류·편집 가능 여부·표시 여부)로만 한다. DOM 없이 계산하는 부분만 여기에 둔다
// (DOM 쪽은 src/content/modelText.ts).

// 요소 하나를 보고 모은 사실.
export interface ProtectFacts {
  // localName(소문자).
  tag: string;
  // contenteditable 속성 값(없으면 null).
  contentEditable: string | null;
  hidden: boolean;
  ariaHidden: boolean;
  // 계산 스타일(없으면 null).
  display: string | null;
  visibility: string | null;
}

// 값을 담는 컨트롤: 그 안의 내용과 값은 모델에 보내지 않는다(select의 선택지는 find_form_fields의 계약으로만).
export const VALUE_CONTROL_TAGS = new Set(["input", "textarea", "select"]);
// 글자가 아닌 내용.
const NON_TEXT_TAGS = new Set(["script", "style", "noscript", "template"]);

// 편집 영역의 시작(편집 호스트): contenteditable이 있고 "false"가 아니면 그 아래 전부가 편집 내용이다.
// contenteditable="false"인 섬도 편집 영역 안이면 보호한다(조상 쪽에서 막힌다).
export function editingHost(contentEditable: string | null): boolean {
  if (contentEditable === null) return false;
  return contentEditable.trim().toLowerCase() !== "false";
}

// 이 요소의 하위 글자를 모델용 글자에서 뺄지와 그 이유.
export function protectedReason(f: ProtectFacts): "control" | "editable" | "hidden" | "non_text" | null {
  if (VALUE_CONTROL_TAGS.has(f.tag)) return "control";
  if (editingHost(f.contentEditable)) return "editable";
  if (f.hidden || f.ariaHidden) return "hidden";
  if (f.display === "none" || f.visibility === "hidden" || f.visibility === "collapse") return "hidden";
  if (NON_TEXT_TAGS.has(f.tag)) return "non_text";
  return null;
}

// query_dom이 돌려주는 속성의 고정 목록. 값 성격(value·aria-valuetext·aria-valuenow)·임의 data-*·class·style 등은 받지 않는다.
// 주소(href·src)는 #44, 선택자 조건은 #45의 범위다.
export const QUERY_DOM_ATTRS = [
  "href",
  "src",
  "role",
  "type",
  "name",
  "id",
  "alt",
  "title",
  "aria-label",
  "aria-selected",
  "aria-expanded",
  "aria-checked",
  "aria-disabled",
  "disabled",
  "hidden",
] as const;

export type QueryDomAttr = (typeof QUERY_DOM_ATTRS)[number];

// 보호 영역 안이면 돌려주지 않는 이름 성격의 속성.
export const NAME_ATTRS = new Set<string>(["alt", "title", "aria-label"]);

export function cleanModelText(raw: string, max: number): string {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}
