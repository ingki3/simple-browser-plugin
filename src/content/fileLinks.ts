import type { FileLink, FileLinkList } from "@/lib/messages";
import { checkFileUrl, extensionOf, formatFromExtension } from "@/lib/fileFormat";
import { getAccessibleRoots } from "./docs";

const DEFAULT_LIMIT = 50;
// 확장자 없는 다운로드 처리기 주소(공공기관·게시판에 흔함).
const DOWNLOAD_URL = /download|filedown|file_down|getfile|fileid|file_id|atchfile|attach|fileno|file_no/i;
const DOWNLOAD_TEXT = /다운로드|내려받기|첨부|download|attachment/i;
const SCRIPT_DOWNLOAD = /down|atch|attach|file/i;

function linkText(el: Element): string {
  const text =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("title")?.trim() ||
    el.getAttribute("aria-label")?.trim() ||
    el.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
    "";
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 120 ? oneLine.slice(0, 119) + "…" : oneLine;
}

// 링크 글자가 "보고서.hwp"처럼 파일 이름이면 그 확장자로 형식을 짐작한다.
function formatFromText(text: string): FileLink["format"] {
  const m = text.match(/[^\s()[\]]+\.([a-z0-9]{2,5})(?=$|[\s()[\]])/i);
  return formatFromExtension(m ? extensionOf(m[0]) : null);
}

export function listFileLinks(args: { query?: string; limit?: number }): FileLinkList {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const query = args.query?.trim().toLowerCase() ?? "";
  const seen = new Set<string>();
  const links: FileLink[] = [];
  let omitted = 0;
  let scriptDownloads = 0;

  for (const root of getAccessibleRoots()) {
    root.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>("a[href], area[href]").forEach((a) => {
      const raw = a.getAttribute("href")?.trim() ?? "";
      const text = linkText(a);
      if (/^javascript:/i.test(raw) || raw === "#" || raw === "") {
        if (SCRIPT_DOWNLOAD.test(raw + " " + (a.getAttribute("onclick") ?? "")) || DOWNLOAD_TEXT.test(text)) {
          scriptDownloads++;
        }
        return;
      }
      const checked = checkFileUrl(a.href);
      if (!checked.ok) return;
      const { url, hint } = checked.target;
      if (seen.has(url)) return;
      const format = hint ?? formatFromText(text);
      const isFile =
        format !== null || a.hasAttribute("download") || DOWNLOAD_URL.test(url) || DOWNLOAD_TEXT.test(text);
      if (!isFile) return;
      seen.add(url);
      if (query && !`${text} ${url}`.toLowerCase().includes(query)) return;
      if (links.length >= limit) {
        omitted++;
        return;
      }
      links.push({ text, url, format });
    });
    // href 없이 onclick으로 내려받는 버튼(fn_download(123) 등).
    root.querySelectorAll<HTMLElement>("button[onclick], input[type=button][onclick], span[onclick], img[onclick]").forEach((el) => {
      if (SCRIPT_DOWNLOAD.test(el.getAttribute("onclick") ?? "") && /down|다운|첨부/i.test(el.getAttribute("onclick") + linkText(el))) {
        scriptDownloads++;
      }
    });
  }
  return { links, omitted, scriptDownloads };
}
