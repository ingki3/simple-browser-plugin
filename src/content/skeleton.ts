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

// root 아래(root 자신은 빼고) 구조 요소 중첩의 해시. maxDepth: 이보다 깊은 구조는 보지 않는다.
// 페이지 키(pageSkeleton)는 body를 기본 깊이로, 반복 작업 작전(#284)의 영역 모양은 영역 뿌리를 얕은 깊이로 잰다.
export function skeletonOf(root: Element, maxDepth = MAX_STRUCT_DEPTH): string {
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
        if (depth >= maxDepth) {
          out.push(own);
        } else {
          const inner = collapseRepeats(childSigs(child, depth + 1));
          out.push(inner.length ? `${own}(${inner.join(",")})` : own);
        }
      } else {
        // 구조 요소가 아닌 감싸개(div 등) 안에 구조 요소가 여럿이면 한 묶음으로 둔다. 그래야 div로 만든 반복 목록
        // (<div><h2/><button/></div> × N)도 항목 단위로 접혀 항목 수와 상관없이 같은 뼈대가 된다.
        const inner = collapseRepeats(childSigs(child, depth));
        if (inner.length > 1) out.push(`{${inner.join(",")}}`);
        else out.push(...inner);
      }
    }
    return out;
  };

  return fnv1a(collapseRepeats(childSigs(root, 0)).join(","));
}

// 페이지 키의 뼈대(읽기 레시피 #156). 값이 바뀌면 저장된 레시피 키가 모두 무효가 되므로 skeletonOf(body)와 같게 둔다
// (하네스 skeleton-compat이 고정값으로 지킨다).
export function pageSkeleton(doc: Document = document): string {
  const body = doc.body;
  if (!body) return fnv1a("");
  return skeletonOf(body);
}
