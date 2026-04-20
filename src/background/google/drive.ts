import { googleFetch } from "./auth";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
}

export async function searchFiles(
  query: string,
  maxResults: number,
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    pageSize: String(Math.min(Math.max(1, maxResults), 100)),
    fields:
      "files(id,name,mimeType,webViewLink,modifiedTime,size)",
    orderBy: "modifiedTime desc",
    spaces: "drive",
  });
  const res = await googleFetch(`/drive/v3/files?${params.toString()}`);
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

export async function listRecent(
  mimeType: string | undefined,
  maxResults: number,
): Promise<DriveFile[]> {
  const q = mimeType ? `mimeType='${mimeType.replace(/'/g, "\\'")}'` : undefined;
  const params = new URLSearchParams({
    pageSize: String(Math.min(Math.max(1, maxResults), 100)),
    fields:
      "files(id,name,mimeType,webViewLink,modifiedTime,size)",
    orderBy: "modifiedTime desc",
    spaces: "drive",
  });
  if (q) params.set("q", q);
  const res = await googleFetch(`/drive/v3/files?${params.toString()}`);
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

const EXPORT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  md: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export async function exportFile(
  fileId: string,
  format: string,
  maxChars: number,
): Promise<{
  format: string;
  mimeType: string;
  excerpt: string;
  bytes: number;
  truncated: boolean;
}> {
  const mimeType = EXPORT_MIME[format.toLowerCase()];
  if (!mimeType) {
    throw new Error(
      `지원하지 않는 export 포맷: ${format}. 가능: ${Object.keys(EXPORT_MIME).join(", ")}`,
    );
  }
  const res = await googleFetch(
    `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
  );
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  if (
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values" ||
    mimeType === "text/html" ||
    mimeType === "text/markdown"
  ) {
    const text = await res.text();
    const truncated = text.length > maxChars;
    return {
      format,
      mimeType,
      excerpt: truncated ? text.slice(0, maxChars) + "\n…(잘림)" : text,
      bytes: contentLength || text.length,
      truncated,
    };
  }
  const buf = await res.arrayBuffer();
  return {
    format,
    mimeType,
    excerpt: `[바이너리 ${mimeType}, ${buf.byteLength} bytes — 텍스트 미리보기 없음]`,
    bytes: buf.byteLength,
    truncated: false,
  };
}

export function parseActiveDocIds(url: string): {
  spreadsheetId?: string;
  gid?: string;
  range?: string;
  driveFileId?: string;
} {
  try {
    const u = new URL(url);
    if (u.hostname === "docs.google.com" || u.hostname === "sheets.google.com") {
      const sheetMatch = /\/spreadsheets\/d\/([^/]+)/.exec(u.pathname);
      if (sheetMatch) {
        const frag = new URLSearchParams(u.hash.replace(/^#/, ""));
        return {
          spreadsheetId: sheetMatch[1],
          gid: frag.get("gid") ?? undefined,
          range: frag.get("range") ?? undefined,
        };
      }
    }
    if (u.hostname === "drive.google.com") {
      const m = /\/file\/d\/([^/]+)/.exec(u.pathname);
      if (m) return { driveFileId: m[1] };
    }
  } catch {
    /* ignore */
  }
  return {};
}
