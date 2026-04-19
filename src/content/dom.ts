import { getAccessibleDocs } from "./docs";

export interface QueryResult {
  text: string;
  attrs: Record<string, string>;
}

export function queryDom(args: { selector: string; attr?: string; limit?: number }): QueryResult[] {
  const limit = Math.min(args.limit ?? 50, 200);
  const out: QueryResult[] = [];

  for (const doc of getAccessibleDocs()) {
    if (out.length >= limit) break;
    let nodes: NodeListOf<Element>;
    try {
      nodes = doc.querySelectorAll(args.selector);
    } catch (err) {
      throw new Error(`잘못된 선택자: ${(err as Error).message}`);
    }
    if (nodes.length > 1000) {
      throw new Error(`선택자 결과가 너무 많음 (${nodes.length}). 더 구체적인 선택자를 사용하세요.`);
    }

    nodes.forEach((el) => {
      if (out.length >= limit) return;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      const attrs: Record<string, string> = {};
      if (args.attr) {
        const v = el.getAttribute(args.attr);
        if (v !== null) attrs[args.attr] = v.slice(0, 500);
      }
      out.push({ text, attrs });
    });
  }
  return out;
}
