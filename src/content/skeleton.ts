import { collapseRepeats, fnv1a } from "@/lib/actionLog";

// 페이지 뼈대 해시: 랜드마크·목록·표·폼 같은 구조 요소의 중첩만 본다. 글자·class·속성 값은 보지 않고,
// 같은 틀이 이어지는 형제(목록 항목)는 하나로 접어서 내용과 항목 수가 달라도 같은 값이 나오게 한다.
// 구조 요소가 아닌 div·span은 건너뛰고 그 안으로만 내려간다. 숨김 여부는 보지 않는다(메뉴를 열고 닫는 것만으로
// 키가 바뀌지 않게, 그리고 요소마다 스타일을 계산하지 않게).

const STRUCTURAL = new Set([
  "main",
  "nav",
  "header",
  "footer",
  "aside",
  "article",
  "section",
  "form",
  "fieldset",
  "table",
  "thead",
  "tbody",
  "tr",
  "ul",
  "ol",
  "li",
  "dl",
  "h1",
  "h2",
  "h3",
  "dialog",
  "iframe",
  "input",
  "select",
  "textarea",
  "button",
]);

const STRUCTURAL_ROLES = new Set([
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "search",
  "form",
  "list",
  "listitem",
  "table",
  "grid",
  "row",
  "tablist",
  "tab",
  "dialog",
  "menu",
  "menubar",
]);

const SKIP = new Set(["script", "style", "template", "noscript", "svg", "head", "link", "meta"]);

// 이보다 깊은 구조는 보지 않는다(본문 안쪽의 작은 차이로 키가 갈리지 않게).
const MAX_STRUCT_DEPTH = 6;
// 한 번에 훑는 요소 수 한도(아주 큰 페이지에서 멈추지 않게).
const MAX_VISITS = 20_000;

function label(el: Element): string | null {
  const role = el.getAttribute("role");
  if (role && STRUCTURAL_ROLES.has(role)) return `${el.localName}[${role}]`;
  if (!STRUCTURAL.has(el.localName)) return null;
  if (el.localName === "input") return `input:${(el.getAttribute("type") || "text").toLowerCase()}`;
  return el.localName;
}

export function pageSkeleton(doc: Document = document): string {
  let visits = 0;

  // el 아래에서 찾은 구조 요소들의 서명 목록을 돌려준다(el 자신은 빼고).
  const childSigs = (el: Element, depth: number): string[] => {
    const out: string[] = [];
    const kids = el.shadowRoot ? [...Array.from(el.shadowRoot.children), ...Array.from(el.children)] : Array.from(el.children);
    for (const child of kids) {
      if (++visits > MAX_VISITS) break;
      if (SKIP.has(child.localName)) continue;
      const own = label(child);
      if (own) {
        if (depth >= MAX_STRUCT_DEPTH) {
          out.push(own);
        } else {
          const inner = collapseRepeats(childSigs(child, depth + 1));
          out.push(inner.length ? `${own}(${inner.join(",")})` : own);
        }
      } else {
        out.push(...childSigs(child, depth));
      }
    }
    return out;
  };

  const body = doc.body;
  if (!body) return fnv1a("");
  const sig = collapseRepeats(childSigs(body, 0)).join(",");
  return fnv1a(sig);
}
