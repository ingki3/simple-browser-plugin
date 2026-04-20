import { googleFetch } from "./auth";

interface DocsParagraphElement {
  textRun?: { content?: string };
}
interface DocsParagraph {
  elements?: DocsParagraphElement[];
  paragraphStyle?: { namedStyleType?: string };
}
interface DocsStructuralElement {
  paragraph?: DocsParagraph;
  endIndex?: number;
}
interface DocsResponse {
  title?: string;
  revisionId?: string;
  body?: { content?: DocsStructuralElement[] };
}

export interface DocsReadResult {
  title: string;
  revisionId: string;
  text: string;
  endIndex: number;
  headings: Array<{ level: number; text: string }>;
}

export async function readDoc(documentId: string): Promise<DocsReadResult> {
  const res = await googleFetch(
    `/docs/v1/documents/${encodeURIComponent(documentId)}`,
  );
  const json = (await res.json()) as DocsResponse;
  let text = "";
  let endIndex = 1;
  const headings: DocsReadResult["headings"] = [];
  for (const el of json.body?.content ?? []) {
    if (el.endIndex) endIndex = Math.max(endIndex, el.endIndex);
    const paragraph = el.paragraph;
    if (!paragraph) continue;
    const styleType = paragraph.paragraphStyle?.namedStyleType ?? "";
    const chunk = (paragraph.elements ?? [])
      .map((e) => e.textRun?.content ?? "")
      .join("");
    if (chunk) text += chunk;
    const m = /^HEADING_(\d)$/.exec(styleType);
    if (m) {
      const level = Number(m[1]);
      const raw = chunk.replace(/\s+/g, " ").trim();
      if (raw) headings.push({ level, text: raw });
    }
  }
  return {
    title: json.title ?? "",
    revisionId: json.revisionId ?? "",
    text: text.length > 30_000 ? text.slice(0, 30_000) + "\n…(잘림)" : text,
    endIndex,
    headings: headings.slice(0, 40),
  };
}

export async function appendText(
  documentId: string,
  text: string,
): Promise<{ insertedChars: number }> {
  const info = await readDoc(documentId);
  const insertAt = Math.max(1, info.endIndex - 1);
  await googleFetch(
    `/docs/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [
          { insertText: { location: { index: insertAt }, text } },
        ],
      }),
    },
  );
  return { insertedChars: text.length };
}

export async function replaceText(
  documentId: string,
  find: string,
  replace: string,
  matchCase: boolean,
): Promise<{ replacedCount: number }> {
  const res = await googleFetch(
    `/docs/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            replaceAllText: {
              containsText: { text: find, matchCase },
              replaceText: replace,
            },
          },
        ],
      }),
    },
  );
  const json = (await res.json()) as {
    replies?: Array<{ replaceAllText?: { occurrencesChanged?: number } }>;
  };
  return {
    replacedCount: json.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0,
  };
}
