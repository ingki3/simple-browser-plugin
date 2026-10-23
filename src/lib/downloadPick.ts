// 지정한 이미지·첨부 파일 내려받기(#48)의 판정. DOM·chrome API 없이 계산하는 부분만 둔다.
//
// 카드를 띄우기 전에 모델이 넘긴 주소가 지금 페이지에 실제로 있는 이미지·링크인지 구조로 확인해 후보를 고정하고,
// 사용자가 카드에서 고른 후보만 받는다. 어느 것을 받을지(“PDF만”, “3~5번째”)는 모델이 관측 결과로 정해 주소를
// 넘기고, 여기서는 넘긴 주소가 페이지에 있는지만 본다(낱말 규칙으로 고르지 않는다).
// 결제·개인정보 주소 신호(sensitiveUrlReason)와 다른 사이트 표시는 경고와 기본 해제(더 묻는 쪽)로만 쓴다.

import { sensitiveUrlReason } from "./autoApprove.ts";
import { extensionOf } from "./fileFormat.ts";
import { siteOf, withinSite } from "./siteTrust.ts";

export type DownloadKind = "image" | "file";

// 한 번에 고를 수 있는 수와, 모델이 고르지 않았지만 카드에 선택 해제로 함께 보일 페이지 항목 수.
export const DOWNLOAD_LIMITS: Record<DownloadKind, { maxPick: number; maxExtra: number }> = {
  image: { maxPick: 200, maxExtra: 30 },
  file: { maxPick: 20, maxExtra: 30 },
};

// 페이지에서 모은 항목 하나(이미지: list_page_images와 같은 수집, 파일: 페이지의 a[href]·area[href]).
export interface PageDownloadItem {
  url: string;
  // 화면 글자(이미지 alt, 링크 글자). 입력값은 담지 않는다.
  label: string;
  // 카드에 덧붙일 짧은 정보(이미지 크기, 짐작한 형식).
  meta?: string;
  // 모델이 고르지 않았을 때 카드에 선택 해제로 함께 보일지(이미지는 전부, 링크는 파일 링크로 보이는 것만).
  listed: boolean;
}

export interface DownloadCandidate {
  url: string;
  label: string;
  // 카드의 둘째 줄(정보·주소·경고).
  sub: string;
  // 모델이 넘긴 주소인지.
  requested: boolean;
  // 카드에서 처음부터 체크해 둘지. 모델이 고른 것만, 경고(결제·개인정보 주소, 다른 사이트 파일)가 붙으면 해제.
  defaultOn: boolean;
}

export interface DownloadPick {
  candidates: DownloadCandidate[];
  // 받지 않는 주소와 이유(카드·모델에 알린다).
  rejected: Array<{ url: string; reason: string }>;
}

// 주소 비교 열쇠. 이미지는 수집한 주소 그대로(URL 정규화만), 파일 링크는 해시만 다른 주소를 같은 링크로 본다
// (read_linked_pages의 link_lookup과 같은 기준).
export function downloadKey(kind: DownloadKind, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (kind === "file") u.hash = "";
  return u.href;
}

// 주소에서 내려받을 파일 이름으로 쓸 수 있는 것: 마지막 경로 조각이나 쿼리 값(download.do?fileName=보고서.hwp)에서
// 확장자가 있는 이름. 서버 처리기(.do·.php 등)는 파일 이름이 아니다. 없으면 null(확장자 없는 다운로드 링크).
const HANDLER_EXT = new Set([
  "do", "php", "php3", "php5", "jsp", "jspx", "asp", "aspx", "cgi", "action", "nhn", "html", "htm", "shtml", "pl",
]);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function realExt(name: string): string | null {
  const ext = extensionOf(name);
  return ext && !HANDLER_EXT.has(ext) ? ext : null;
}

export function urlFileName(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const last = safeDecode(u.pathname.split("/").filter(Boolean).pop() ?? "");
  if (last && realExt(last)) return last;
  for (const value of u.searchParams.values()) {
    const name = value.split(/[\\/]/).pop() ?? "";
    if (name && realExt(name)) return name;
  }
  return null;
}

const EXTENSIONLESS_WARNING =
  "확장자 없는 다운로드 링크 — 파일이 아닌 다른 동작(로그아웃·삭제·신청 등)을 하는 주소일 수도 있음";

export function pickDownloadCandidates(
  kind: DownloadKind,
  requested: readonly string[],
  page: readonly PageDownloadItem[],
  pageUrl: string,
): DownloadPick {
  const { maxExtra } = DOWNLOAD_LIMITS[kind];
  const present = new Set<string>();
  for (const item of page) {
    const k = downloadKey(kind, item.url);
    if (k) present.add(k);
  }
  const want = new Set<string>();
  const rejected: DownloadPick["rejected"] = [];
  for (const raw of requested) {
    const k = downloadKey(kind, raw);
    let reason: string | null = null;
    if (!k) reason = "http(s) 주소가 아님";
    else if (new URL(k).username || new URL(k).password) reason = "계정 정보가 실린 주소";
    else if (!present.has(k)) reason = kind === "image" ? "지금 페이지에 없는 이미지" : "지금 페이지에 없는 링크";
    if (reason) rejected.push({ url: raw, reason });
    else if (k) want.add(k);
  }
  const pageSite = siteOf(pageUrl);
  const seen = new Set<string>();
  const candidates: DownloadCandidate[] = [];
  let extras = 0;
  for (const item of page) {
    const k = downloadKey(kind, item.url);
    if (!k || seen.has(k)) continue;
    const isRequested = want.has(k);
    if (!isRequested && (!item.listed || extras >= maxExtra)) continue;
    // 계정 정보가 실린 주소는 함께 보이지도 않는다.
    const parsed = new URL(k);
    if (parsed.username || parsed.password) continue;
    seen.add(k);
    if (!isRequested) extras += 1;
    const notes: string[] = [];
    let warned = false;
    const why = sensitiveUrlReason(k);
    if (why) {
      notes.push(`⚠ ${why} — 열기만 해도 동작하는 주소일 수 있음`);
      warned = true;
    }
    const otherSite = !pageSite || !withinSite(pageSite, k);
    if (otherSite) {
      notes.push("다른 사이트");
      // 첨부 파일은 로그인 쿠키를 싣고 받으므로 다른 사이트 링크는 기본 해제한다. 이미지는 페이지가 이미 그 사이트에서
      // 불러와 보여 준 것(CDN)이 대부분이라 표시만 한다.
      if (kind === "file") warned = true;
    }
    if (kind === "file" && !urlFileName(k)) notes.push(EXTENSIONLESS_WARNING);
    const name = urlFileName(k);
    const label = item.label.trim() || name || k;
    const info = [item.meta ?? "", k].filter(Boolean).join(" · ");
    candidates.push({
      url: k,
      label: label.length > 120 ? `${label.slice(0, 119)}…` : label,
      sub: notes.length ? `${info} (${notes.join(" · ")})` : info,
      requested: isRequested,
      defaultOn: isRequested && !warned,
    });
  }
  return { candidates, rejected };
}

// ── 저장 이름 ──

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/x-hwp": "hwp",
  "application/haansofthwp": "hwp",
  "application/vnd.hancom.hwp": "hwp",
  "application/hwp+zip": "hwpx",
  "application/haansofthwpx": "hwpx",
  "application/vnd.hancom.hwpx": "hwpx",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/plain": "txt",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  return MIME_EXT[mime.split(";")[0].trim().toLowerCase()] ?? null;
}

// 파일 이름 하나로 쓸 수 있게 정리한다. 확장자는 지키고 앞부분만 줄인다.
function cleanName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .replace(/[:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!base) return "";
  const ext = extensionOf(base);
  if (!ext) return base.slice(0, 120);
  const stem = base.slice(0, base.length - ext.length - 1).slice(0, 110).trim();
  return stem ? `${stem}.${ext}` : "";
}

function stemOf(name: string): string {
  const ext = extensionOf(name);
  return ext ? name.slice(0, name.length - ext.length - 1) : name;
}

// 저장할 파일 이름. suggested는 브라우저가 정한 이름(Content-Disposition → 주소 순)이나 이미지 주소의 이름.
// 확장자가 있는 이름(서버 처리기 .do·.php 제외)을 먼저 쓰고, 없으면 그 이름이나 순번에 받은 형식(MIME)의 확장자를 붙인다.
export function saveFileName(o: {
  kind: DownloadKind;
  suggested?: string | null;
  url: string;
  mime?: string | null;
  index: number;
}): string {
  const fromUrl = urlFileName(o.url);
  for (const raw of [o.suggested ?? "", fromUrl ?? ""]) {
    const name = cleanName(raw);
    if (name && realExt(name)) return name;
  }
  let stem = "";
  for (const raw of [o.suggested ?? "", safeDecode(new URL(o.url).pathname.split("/").filter(Boolean).pop() ?? "")]) {
    stem = cleanName(stemOf(cleanName(raw)));
    if (stem) break;
  }
  if (!stem) stem = `${o.kind === "image" ? "image" : "file"}-${o.index + 1}`;
  const ext = extFromMime(o.mime);
  return ext ? `${stem}.${ext}` : stem;
}

// 저장한 전체 경로에서 사용자 폴더 경로를 빼고 '폴더/이름'만 남긴다(모델에 보낼 저장 위치 — 사용자 이름이 든
// 다운로드 폴더 경로는 보내지 않는다). 바로 위 폴더가 고른 폴더가 아니면(이름 정하기를 거치지 못함) 이름만.
export function savedLocation(folder: string, fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (!name) return "";
  return parts.at(-2) === folder ? `${folder}/${name}` : name;
}

// ── 결과 ──

const INTERRUPT_REASONS: Record<string, string> = {
  FILE_FAILED: "파일을 쓰지 못함",
  FILE_ACCESS_DENIED: "저장 폴더에 쓸 권한이 없음",
  FILE_NO_SPACE: "저장 공간 부족",
  FILE_NAME_TOO_LONG: "파일 이름이 너무 김",
  FILE_TOO_LARGE: "파일이 너무 큼",
  FILE_VIRUS_INFECTED: "바이러스 검사에서 막힘",
  FILE_BLOCKED: "브라우저 정책으로 막힘",
  FILE_SECURITY_CHECK_FAILED: "보안 검사 실패",
  NETWORK_FAILED: "네트워크 오류",
  NETWORK_TIMEOUT: "네트워크 시간 초과",
  NETWORK_DISCONNECTED: "네트워크 연결 끊김",
  NETWORK_SERVER_DOWN: "서버에 연결하지 못함",
  NETWORK_INVALID_REQUEST: "잘못된 요청",
  SERVER_FAILED: "서버 오류",
  SERVER_NO_RANGE: "서버 오류(이어 받기 불가)",
  SERVER_BAD_CONTENT: "서버에 파일이 없음(404 등)",
  SERVER_UNAUTHORIZED: "로그인이 필요함(401)",
  SERVER_CERT_PROBLEM: "서버 인증서 문제",
  SERVER_FORBIDDEN: "접근 거부(403)",
  SERVER_UNREACHABLE: "서버에 연결하지 못함",
  SERVER_CONTENT_LENGTH_MISMATCH: "받은 크기가 맞지 않음",
  SERVER_CROSS_ORIGIN_REDIRECT: "다른 출처로 리다이렉트되어 막힘",
  USER_CANCELED: "사용자가 취소함",
  USER_SHUTDOWN: "브라우저 종료로 중단",
  CRASH: "브라우저 오류로 중단",
};

export function downloadFailReason(code: string | null | undefined): string {
  if (!code) return "알 수 없는 이유로 중단됨";
  // 표에 없는 값은 그대로 싣지 않고 고정 문구로만 알린다.
  return INTERRUPT_REASONS[code] ?? "중단됨(기타 이유)";
}

export interface DownloadOutcome {
  ok: boolean;
  // 실패 이유(ok=false).
  reason?: string;
  // 저장은 했지만 확인할 점(받은 것이 웹 페이지 등).
  note?: string;
}

// 한 항목의 결과. state는 chrome.downloads의 상태, 시작조차 못 했으면 "not_started".
// 모델로 가는 글자에는 서버가 정한 문자열(MIME·리다이렉트 목적지 호스트·오류 문구)을 싣지 않고 고정된 분류만 쓴다
// (download_images는 외부 본문 보호를 켜지 않는 도구라, 서버 문자열에 숨긴 지시문이 들어가면 안 된다).
export function downloadOutcome(o: {
  kind: DownloadKind;
  state: "complete" | "interrupted" | "in_progress" | "not_started";
  error?: string | null;
  mime?: string | null;
  url: string;
  finalUrl?: string | null;
}): DownloadOutcome {
  if (o.state === "not_started") return { ok: false, reason: "내려받기를 시작하지 못함" };
  if (o.state === "interrupted") return { ok: false, reason: downloadFailReason(o.error) };
  if (o.state === "in_progress") return { ok: false, reason: "아직 받는 중(완료를 기다리지 못함)" };
  const notes: string[] = [];
  const mime = (o.mime ?? "").split(";")[0].trim().toLowerCase();
  // 첨부 대신 로그인 화면·오류 페이지를 받는 경우가 많다(구조: 받은 형식).
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    notes.push("받은 것이 웹 페이지(HTML)입니다. 로그인 화면이나 오류 페이지일 수 있습니다");
  } else if (o.kind === "image" && mime && !mime.startsWith("image/") && !o.url.startsWith("data:")) {
    notes.push("이미지가 아닌 응답");
  }
  if (o.finalUrl && o.finalUrl !== o.url && /^https?:/i.test(o.finalUrl)) {
    const site = siteOf(o.url);
    if (!site || !withinSite(site, o.finalUrl)) notes.push("다른 사이트로 리다이렉트되어 받음");
  }
  return notes.length ? { ok: true, note: notes.join(" / ") } : { ok: true };
}

// 이미지 저장 위치: 확장이 정한 이름(주소의 이름)과 브라우저의 uniquify 꼬리표(" (1)")만 모델에 보낸다. 브라우저가
// 받은 형식에 따라 이름을 바꿨으면(서버가 정한 값이 섞일 수 있음) 확장이 정한 이름만 알리고 renamed로 표시한다.
export function imageSavedLocation(
  folder: string,
  requestedName: string,
  fullPath: string,
): { savedAs: string; renamed: boolean } {
  const actual = fullPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const ext = extensionOf(requestedName);
  const stem = ext ? requestedName.slice(0, requestedName.length - ext.length - 1) : requestedName;
  const m = actual.match(/ \((\d{1,4})\)(\.[^.]*)?$/);
  const n = m && actual === `${stem} (${m[1]})${ext ? `.${ext}` : ""}` ? m[1] : null;
  if (actual === requestedName) return { savedAs: `${folder}/${requestedName}`, renamed: false };
  if (n) return { savedAs: `${folder}/${stem} (${n})${ext ? `.${ext}` : ""}`, renamed: false };
  return { savedAs: `${folder}/${requestedName}`, renamed: true };
}
