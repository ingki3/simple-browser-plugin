export const DOCUMENT_EXTENSIONS = ["docx", "xlsx", "pptx"] as const;
export type DocumentExtension = (typeof DOCUMENT_EXTENSIONS)[number];

export interface DocumentTarget {
  url: string;
  filename: string;
  extension: DocumentExtension;
}

// read_document가 받을 수 있는 URL인지 판별한다. 쿠키를 실어 GET을 보내므로,
// 프롬프트 주입으로 임의 URL을 호출하지 않도록 경로가 지원 확장자로 끝나는 http(s) URL만 받는다.
export function parseDocumentUrl(rawUrl: string): DocumentTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  let name: string;
  try {
    name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  } catch {
    return null;
  }
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (!extension || !(DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)) return null;
  return { url: url.href, filename: name, extension: extension as DocumentExtension };
}
