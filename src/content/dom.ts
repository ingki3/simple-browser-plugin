import { getAccessibleRoots } from "./docs";
import { inProtectedArea, modelAttr, modelText } from "./modelText";
import { selectorBlock } from "@/lib/selectorPolicy";

export interface QueryResult {
  text: string;
  attrs: Record<string, string>;
}

// 글자는 화면 글자만(입력 칸·편집 영역·숨은 하위 내용 제외), 속성은 정해 둔 구조 속성만 돌려준다(#43).
// 선택자는 값에 의존하는 조건(구조 속성이 아닌 속성 값 비교, value 존재, 입력값 상태 의사 클래스)이 있으면 실행하지 않는다
// — 결과 개수·유무로 비공개 값을 알아낼 수 있어서다(#45, src/lib/selectorPolicy.ts).
export function queryDom(args: { selector: string; attr?: string; limit?: number }): QueryResult[] {
  const blocked = selectorBlock(args.selector);
  if (blocked) throw new Error(`선택자를 실행하지 않았습니다: ${blocked}. 구조(태그·id·class·역할) 조건으로 다시 찾으세요.`);
  const limit = Math.min(args.limit ?? 50, 200);
  const out: QueryResult[] = [];

  for (const root of getAccessibleRoots()) {
    if (out.length >= limit) break;
    let nodes: NodeListOf<Element>;
    try {
      nodes = root.querySelectorAll(args.selector);
    } catch (err) {
      throw new Error(`잘못된 선택자: ${(err as Error).message}`);
    }
    if (nodes.length > 1000) {
      throw new Error(`선택자 결과가 너무 많음 (${nodes.length}). 더 구체적인 선택자를 사용하세요.`);
    }

    nodes.forEach((el) => {
      if (out.length >= limit) return;
      const protectedArea = inProtectedArea(el);
      const text = protectedArea ? "" : modelText(el, 500);
      const attrs: Record<string, string> = {};
      if (args.attr) {
        const v = modelAttr(el, args.attr, protectedArea);
        if (v !== null) attrs[args.attr] = v;
      }
      out.push({ text, attrs });
    });
  }
  return out;
}
