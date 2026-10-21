import { getAccessibleRoots } from "./docs";
import { inProtectedArea, modelAttr, modelText } from "./modelText";

export interface QueryResult {
  text: string;
  attrs: Record<string, string>;
}

// 글자는 화면 글자만(입력 칸·편집 영역·숨은 하위 내용 제외), 속성은 정해 둔 구조 속성만 돌려준다(#43).
// 선택자 자체는 지금처럼 그대로 실행한다(선택자 조건의 처리는 #45).
export function queryDom(args: { selector: string; attr?: string; limit?: number }): QueryResult[] {
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
