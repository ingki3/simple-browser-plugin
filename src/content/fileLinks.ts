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

// 링크가 파일 링크로 보이는지(list_file_links의 목록 기준). 목록에 보일지만 정하고 승인에는 쓰지 않는다.
function looksLikeFile(a: HTMLAnchorElement | HTMLAreaElement, url: string, format: FileLink["format"], text: string): boolean {
  return format !== null || a.hasAttribute("download") || DOWNLOAD_URL.test(url) || DOWNLOAD_TEXT.test(text);
}

const MAX_PAGE_LINKS = 3_000;

// download_files(#48): 지금 문서(최상위 + 접근 가능한 같은 출처 프레임 + 열린 shadow root, list_file_links와 같은 범위)의
// http(s) 링크 전부. 백그라운드가 모델이 넘긴 주소가 이 안에 있는지 구조로 확인해 후보를 고정한다.
// listed는 모델이 고르지 않은 링크를 카드에 선택 해제로 함께 보일지(파일 링크로 보이는 것만)다.
export function pageDownloadLinks(): Array<{ url: string; label: string; meta: string; listed: boolean }> {
  const out: Array<{ url: string; label: string; meta: string; listed: boolean }> = [];
  const seen = new Set<string>();
  for (const root of getAccessibleRoots()) {
    for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>("a[href], area[href]"))) {
      if (out.length >= MAX_PAGE_LINKS) return out;
      let key: string;
      try {
        const u = new URL(a.href);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        u.hash = "";
        key = u.href;
      } catch {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const text = linkText(a);
      const checked = checkFileUrl(key);
      const format = checked.ok ? (checked.target.hint ?? formatFromText(text)) : null;
      out.push({ url: key, label: text, meta: format ?? "", listed: looksLikeFile(a, key, format, text) });
    }
  }
  return out;
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
      if (!looksLikeFile(a, url, format, text)) return;
      // 같은 URL의 다른 링크("다운로드" 뒤의 "보고서.hwp" 등)가 검색어와 맞을 수 있으므로, 검색어를 통과한 뒤에 등록한다.
      if (query && !`${text} ${url}`.toLowerCase().includes(query)) return;
      seen.add(url);
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
