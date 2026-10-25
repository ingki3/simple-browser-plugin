// query_dom 선택자 검사(#45). 모델이 준 CSS 선택자는 페이지에서 그대로 실행되므로, 결과 글자·속성을 좁혀도 선택자
// 조건으로 비공개 값(입력값이 반영된 value 속성, data-* 등)을 결과 개수·유무로 알아낼 수 있다. 그런 조건을 구조로 거부한다:
// - 속성 값 비교([a=…], ~=, |=, ^=, $=, *=)는 구조 속성(STRUCTURAL_ATTRS, STRUCTURAL_ARIA)에만 허용한다.
// - 주석이 든 선택자는 거부하고, 줄바꿈은 CSS처럼 정규화한 뒤 본다.
// - 속성 존재 조건([a])은 허용하되 value는 거부한다(값을 넣은 칸에만 속성을 다는 프레임워크가 있다).
// - 입력값에 따라 달라지는 상태 의사 클래스(:placeholder-shown, :valid 등)는 거부한다.
// :has()·:is()·:where()·:not() 안쪽도 같은 기준으로 본다(문자열 전체를 훑는다). 낱말 뜻으로 판단하지 않는다.

// 값 비교를 허용하는 속성: 페이지가 만든 구조·화면 정보(주소·역할·이름표). class는 .a 선택자와 같다.
const STRUCTURAL_ATTRS = new Set([
  "id",
  "class",
  "name",
  "type",
  "role",
  "href",
  "src",
  "alt",
  "title",
  "for",
  "lang",
  "dir",
  "rel",
  "target",
  "tabindex",
  "placeholder",
  "method",
  "action",
  "hreflang",
  "colspan",
  "rowspan",
  "scope",
  "headers",
]);

// 값 비교를 허용하는 aria 속성: 이름표·관계·구조·상태. 현재 값을 담는 것(aria-valuenow·aria-valuetext 등)과 입력 유효성
// (aria-invalid)·활성 항목(aria-activedescendant)은 넣지 않는다.
const STRUCTURAL_ARIA = new Set([
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
  "aria-haspopup",
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-pressed",
  "aria-disabled",
  "aria-hidden",
  "aria-current",
  "aria-level",
  "aria-posinset",
  "aria-setsize",
  "aria-modal",
  "aria-orientation",
  "aria-sort",
  "aria-live",
  "aria-roledescription",
  "aria-required",
  "aria-readonly",
  "aria-multiselectable",
  "aria-autocomplete",
  "aria-placeholder",
]);

// 입력 칸의 지금 값에 따라 맞고 안 맞는 의사 클래스.
const VALUE_PSEUDOS = new Set([
  "placeholder-shown",
  "valid",
  "invalid",
  "user-valid",
  "user-invalid",
  "in-range",
  "out-of-range",
  "blank",
  "autofill",
  "-webkit-autofill",
  "-internal-autofill-selected",
]);

// 거부 이유(모델에 보이는 문구). 허용이면 null.
export function selectorBlock(raw: string): string | null {
  // CSS 입력 정규화(줄바꿈 CRLF·CR·FF → LF, NUL → U+FFFD)를 먼저 해 브라우저와 같은 글자로 본다.
  const selector = raw.replace(/\r\n|\r|\f/g, "\n").replace(/\0/g, "\ufffd");
  // 주석은 브라우저가 지우고 실행하므로 주석 안의 따옴표·대괄호로 검사를 어긋나게 할 수 있다. 주석이 있으면 거부한다.
  if (selector.includes("/*")) return "선택자에 주석(/* */)은 쓸 수 없습니다";
  let i = 0;
  const n = selector.length;
  while (i < n) {
    const c = selector[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(selector, i);
      continue;
    }
    if (c === "[") {
      const end = attrEnd(selector, i);
      if (end < 0) return null; // 문법 오류는 querySelectorAll이 알린다.
      const why = attrBlock(selector.slice(i + 1, end));
      if (why) return why;
      i = end + 1;
      continue;
    }
    if (c === ":") {
      if (selector[i + 1] === ":") {
        i += 2;
        continue;
      }
      const { name, end } = readIdent(selector, i + 1);
      if (VALUE_PSEUDOS.has(name.toLowerCase())) return `입력값에 따라 달라지는 조건(:${name})은 쓸 수 없습니다`;
      i = Math.max(end, i + 1);
      continue;
    }
    i++;
  }
  return null;
}

function skipString(s: string, start: number): number {
  const q = s[start];
  let i = start + 1;
  while (i < s.length && s[i] !== q) i += s[i] === "\\" ? 2 : 1;
  return i + 1;
}

// [ 다음부터 짝이 되는 ]의 위치(문자열·이스케이프 안의 ]는 건너뜀). 없으면 -1.
function attrEnd(s: string, start: number): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === '"' || c === "'") i = skipString(s, i);
    else if (c === "]") return i;
    else i++;
  }
  return -1;
}

// 이름(ident)을 이스케이프를 풀어 읽는다: \41 (16진 1~6자리, 뒤 공백 하나 포함)·\x(그 글자). 끝 위치도 돌려준다.
function readIdent(s: string, start: number): { name: string; end: number } {
  let i = start;
  let name = "";
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const hex = /^[0-9a-fA-F]{1,6}/.exec(s.slice(i + 1));
      if (hex) {
        const cp = parseInt(hex[0], 16);
        name += cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
        i += 1 + hex[0].length;
        if (s[i] === " " || s[i] === "\t" || s[i] === "\n") i++;
      } else if (i + 1 < s.length) {
        name += s[i + 1];
        i += 2;
      } else i++;
      continue;
    }
    if (/[-\w]/.test(c) || c.charCodeAt(0) >= 0x80) {
      name += c;
      i++;
      continue;
    }
    break;
  }
  return { name, end: i };
}

// 속성 조건 안쪽(대괄호 제외)을 본다.
function attrBlock(inner: string): string | null {
  let i = 0;
  while (i < inner.length && /\s/.test(inner[i])) i++;
  // 네임스페이스 접두사(ns| 또는 *|)는 건너뛴다. 접두사가 있어도 속성 이름으로 같은 기준을 쓴다.
  let first = readIdent(inner, i);
  if (inner[first.end] === "|" && inner[first.end + 1] !== "=") first = readIdent(inner, first.end + 1);
  else if (inner[i] === "*" && inner[i + 1] === "|") first = readIdent(inner, i + 2);
  const name = first.name.toLowerCase();
  if (!name) return null;
  let j = first.end;
  while (j < inner.length && /\s/.test(inner[j])) j++;
  const compares = /^[~|^$*]?=/.test(inner.slice(j));
  if (!compares) return name === "value" ? "value 속성 조건은 쓸 수 없습니다(입력값이 반영될 수 있음)" : null;
  if (STRUCTURAL_ATTRS.has(name) || STRUCTURAL_ARIA.has(name)) return null;
  return `'${name}' 속성 값 조건은 쓸 수 없습니다(id·class·name·type·role·href·aria-label 같은 구조 속성만)`;
}
