// query_dom 선택자 검사(#45). 모델이 준 CSS 선택자는 페이지에서 그대로 실행되므로, 결과 글자·속성을 좁혀도 선택자
// 조건으로 비공개 값(입력값이 반영된 value 속성, data-* 등)을 결과 개수·유무로 알아낼 수 있다.
// 위험한 형태를 골라 막으면 브라우저의 CSS 토큰 해석·오류 복구(주석, 잘못된 문자열·url 토큰, 이스케이프 등)와 어긋나
// 우회된다. 그래서 허용하는 문법만 받는 파서로 본다 — 여기서 읽지 못하는 선택자는 실행하지 않는다:
// - 선택자 목록: 복합 선택자를 결합자(공백·>·+·~)로 잇고 쉼표로 나열
// - 단순 선택자: 태그·*, #id, .class, [속성], [속성 연산자 값(이름 또는 역슬래시 없는 따옴표 문자열) i|s]
// - 의사 클래스: STATE_PSEUDOS(인자 없음), nth-*(an+b), not·is·where·has(선택자 목록, has는 > + ~로 시작 가능)
// - 이름: 영문·숫자·_·-·비ASCII만(역슬래시 이스케이프 없음)
// 그리고 속성 값 비교는 구조 속성(STRUCTURAL_ATTRS·STRUCTURAL_ARIA)에만, [value] 존재 조건은 거부한다.
// 낱말 뜻으로 판단하지 않는다(문법과 속성 이름의 구조로만).

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

// 인자 없이 허용하는 의사 클래스: 문서 구조와 페이지가 정한 상태. 입력 칸의 지금 값에 따라 달라지는 것
// (:placeholder-shown·:valid·:invalid·:in-range·:autofill 등)은 넣지 않는다. 체크 상태(:checked)는 찾기 도구도 states로
// 알려 주는 상태라 허용한다(#43).
const STATE_PSEUDOS = new Set([
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "root",
  "empty",
  "checked",
  "disabled",
  "enabled",
  "required",
  "optional",
  "read-only",
  "read-write",
  "default",
  "indeterminate",
  "link",
  "any-link",
  "target",
  "scope",
  "hover",
  "focus",
  "focus-within",
  "focus-visible",
  "active",
  "open",
  "modal",
  "popover-open",
  "defined",
]);
const NTH_PSEUDOS = new Set(["nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type"]);
const LIST_PSEUDOS = new Set(["not", "is", "where", "has"]);

class Reject extends Error {}

// 거부 이유(모델에 보이는 문구). 허용이면 null.
export function selectorBlock(selector: string): string | null {
  const p = new Parser(selector);
  try {
    p.list(false);
    p.ws();
    if (!p.done()) p.fail();
    return null;
  } catch (err) {
    if (err instanceof Reject) return err.message;
    throw err;
  }
}

const UNSUPPORTED = "지원하지 않는 선택자 형식입니다(태그·#id·.class·[속성]·구조 의사 클래스와 결합자만, 이스케이프·주석·함수 불가)";

class Parser {
  i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  done(): boolean {
    return this.i >= this.s.length;
  }
  peek(): string {
    return this.s[this.i] ?? "";
  }
  fail(why: string = UNSUPPORTED): never {
    throw new Reject(why);
  }
  // 공백(스페이스·탭만 — 줄바꿈 등은 받지 않는다). 읽었으면 true.
  ws(): boolean {
    const start = this.i;
    while (this.peek() === " " || this.peek() === "\t") this.i++;
    return this.i > start;
  }
  ident(): string {
    const start = this.i;
    while (!this.done()) {
      const c = this.peek();
      if (/[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80) this.i++;
      else break;
    }
    if (this.i === start) this.fail();
    return this.s.slice(start, this.i);
  }

  // 선택자 목록. relative: :has() 안처럼 앞에 결합자가 올 수 있는지.
  list(relative: boolean): void {
    for (;;) {
      this.ws();
      this.complex(relative);
      this.ws();
      if (this.peek() !== ",") return;
      this.i++;
    }
  }

  complex(relative: boolean): void {
    if (relative && /[>+~]/.test(this.peek())) {
      this.i++;
      this.ws();
    }
    this.compound();
    for (;;) {
      const hadWs = this.ws();
      const c = this.peek();
      if (c === ">" || c === "+" || c === "~") {
        this.i++;
        this.ws();
        this.compound();
      } else if (hadWs && c && c !== "," && c !== ")") {
        this.compound();
      } else return;
    }
  }

  compound(): void {
    let n = 0;
    if (this.peek() === "*") {
      this.i++;
      n++;
    } else if (/[A-Za-z]/.test(this.peek())) {
      this.ident();
      n++;
    }
    for (;;) {
      const c = this.peek();
      if (c === "#" || c === ".") {
        this.i++;
        this.ident();
      } else if (c === "[") {
        this.attr();
      } else if (c === ":") {
        this.pseudo();
      } else break;
      n++;
    }
    if (n === 0) this.fail();
  }

  attr(): void {
    this.i++; // [
    this.ws();
    const name = this.ident().toLowerCase();
    this.ws();
    const c = this.peek();
    if (c === "]") {
      this.i++;
      if (name === "value") this.fail("value 속성 조건은 쓸 수 없습니다(입력값이 반영될 수 있음)");
      return;
    }
    let op = "";
    if (c === "=") op = "=";
    else if (/[~|^$*]/.test(c) && this.s[this.i + 1] === "=") op = c + "=";
    else this.fail();
    this.i += op.length;
    this.ws();
    const q = this.peek();
    if (q === '"' || q === "'") {
      const end = this.s.indexOf(q, this.i + 1);
      if (end < 0) this.fail();
      const body = this.s.slice(this.i + 1, end);
      if (/[\\\n\r\f]/.test(body)) this.fail();
      this.i = end + 1;
    } else {
      this.ident();
    }
    this.ws();
    if (/[iIsS]/.test(this.peek()) && !/[A-Za-z0-9_-]/.test(this.s[this.i + 1] ?? "")) {
      this.i++;
      this.ws();
    }
    if (this.peek() !== "]") this.fail();
    this.i++;
    if (!STRUCTURAL_ATTRS.has(name) && !STRUCTURAL_ARIA.has(name)) {
      this.fail(`'${name}' 속성 값 조건은 쓸 수 없습니다(id·class·name·type·role·href·aria-label 같은 구조 속성만)`);
    }
  }

  pseudo(): void {
    this.i++; // :
    if (this.peek() === ":") this.fail("의사 요소(::)는 쓸 수 없습니다");
    const name = this.ident().toLowerCase();
    if (this.peek() !== "(") {
      if (!STATE_PSEUDOS.has(name)) this.fail(`의사 클래스 :${name}은 쓸 수 없습니다(입력값에 따라 달라지거나 지원하지 않음)`);
      return;
    }
    this.i++; // (
    if (NTH_PSEUDOS.has(name)) {
      this.ws();
      const start = this.i;
      while (/[0-9nN+\- \t]/.test(this.peek()) || /[a-z]/i.test(this.peek())) this.i++;
      const arg = this.s.slice(start, this.i).trim().toLowerCase();
      if (!/^(odd|even|[+-]?\d*n(\s*[+-]\s*\d+)?|[+-]?\d+)$/.test(arg)) this.fail();
    } else if (LIST_PSEUDOS.has(name)) {
      this.list(name === "has");
    } else {
      this.fail(`의사 클래스 :${name}()은 쓸 수 없습니다`);
    }
    this.ws();
    if (this.peek() !== ")") this.fail();
    this.i++;
  }
}
