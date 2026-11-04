// 진단 복사(#132)의 공유 전 가리기. 판정에는 쓰지 않고, 복사할 글에서 더 가리는 쪽으로만 쓴다(잘못 가려도 진단 글이 덜 보일 뿐).
// 글을 공백으로 나눈 조각마다 한 번씩 본다(긴 글에서도 선형 — 정규식이 자리마다 되짚지 않게).
// - 주소(scheme://)가 든 조각: 주소 앞은 두고, 주소부터 조각 끝까지를 `scheme://host/…`로(사용자 정보 버림 — 경로·쿼리의 괄호·따옴표·중괄호까지 모두 가림)
// - @가 든 조각(이메일, %40 포함): 조각 전체를 [이메일]
// - 파일 이름(조각이 문서·이미지·압축 확장자로 끝남): 조각 전체를 [파일].확장자 — 공백이 든 파일 이름은 마지막 조각만 가려진다(한계)
// - 그 밖: 24자 이상 영숫자·_- 덩어리는 [긴 값], 6자리 이상 숫자는 [숫자]
// npm test로 시험하므로 다른 모듈을 불러오지 않는다.

export type DiagMaskKind = "url" | "email" | "file" | "token" | "number";

export interface DiagMaskResult {
  text: string;
  counts: Record<DiagMaskKind, number>;
}

const FILE_EXT = new Set(
  "pdf doc docx xls xlsx ppt pptx hwp hwpx odt ods odp csv tsv txt rtf zip 7z rar png jpg jpeg gif webp heic svg mp4 mov".split(" "),
);
const SCHEME_CHAR = /[a-zA-Z0-9+.-]/;
// 호스트(와 :포트, IPv6의 [])에 올 수 있는 글자. 이 밖의 글자(따옴표·괄호 등)에서 호스트가 끝난다.
const AUTHORITY_CHAR = /[A-Za-z0-9.\-:\[\]%_~]/;
// 조각 끝의 문장 부호(파일 확장자 판정에서 뺀다).
const TRAILING = /[)\]}>.,;:!?'"]+$/;

function maskUrlTail(tail: string): string {
  // tail = scheme://나머지(조각 끝까지)
  const sep = tail.indexOf("://");
  const scheme = tail.slice(0, sep + 3);
  const rest = tail.slice(sep + 3);
  // authority 후보: 첫 / ? # 전까지(조각 끝까지일 수 있음). 사용자 정보는 마지막 @까지 통째로 버린다 — 비밀번호에 어떤 글자가 있어도.
  let cut = rest.length;
  for (const ch of ["/", "?", "#"]) {
    const i = rest.indexOf(ch);
    if (i >= 0 && i < cut) cut = i;
  }
  const authority = rest.slice(0, cut);
  const at = authority.lastIndexOf("@");
  const afterUser = at >= 0 ? authority.slice(at + 1) : authority;
  // 호스트는 호스트 글자까지만(뒤에 붙은 선택자의 따옴표·속성 등은 호스트가 아니다).
  let end = 0;
  while (end < afterUser.length && AUTHORITY_CHAR.test(afterUser[end])) end++;
  const host = afterUser.slice(0, end);
  if (!host) return "[주소]";
  // 호스트 뒤에 무엇이든 남으면(경로·쿼리·선택자의 나머지 등) 모두 가린다.
  const leftover = afterUser.slice(end) + rest.slice(cut);
  return `${scheme}${host}${leftover && leftover !== "/" ? "/…" : ""}`;
}

function fileExt(token: string): string | null {
  const core = token.replace(TRAILING, "");
  const dot = core.lastIndexOf(".");
  if (dot <= 0 || dot === core.length - 1) return null;
  const ext = core.slice(dot + 1).toLowerCase();
  return FILE_EXT.has(ext) ? ext : null;
}

function maskToken(token: string, counts: Record<DiagMaskKind, number>): string {
  const sep = token.indexOf("://");
  if (sep > 0) {
    // scheme 시작: :// 앞에서 거꾸로 scheme 글자를 따라간다(첫 글자는 영문자).
    let start = sep;
    while (start > 0 && SCHEME_CHAR.test(token[start - 1])) start--;
    while (start < sep && !/[a-zA-Z]/.test(token[start])) start++;
    if (start < sep) {
      counts.url += 1;
      // 주소 앞 글자도 같은 규칙으로 가린다(검색어 'alice@corp.test|https://…' 등).
      const head = token.slice(0, start);
      return `${head ? maskToken(head, counts) : ""}${maskUrlTail(token.slice(start))}`;
    }
  }
  if (token.includes("@") || /%40/i.test(token)) {
    counts.email += 1;
    return "[이메일]";
  }
  const ext = fileExt(token);
  if (ext) {
    counts.file += 1;
    return `[파일].${ext}`;
  }
  return token
    .replace(/[A-Za-z0-9_-]{24,}/g, () => {
      counts.token += 1;
      return "[긴 값]";
    })
    .replace(/\d{6,}/g, () => {
      counts.number += 1;
      return "[숫자]";
    });
}

export function maskDiagnostics(text: string): DiagMaskResult {
  const counts: Record<DiagMaskKind, number> = { url: 0, email: 0, file: 0, token: 0, number: 0 };
  // 공백(줄바꿈 포함)은 그대로 두고 조각만 바꾼다.
  const out = text
    .split(/(\s+)/)
    .map((part) => (part && !/^\s+$/.test(part) ? maskToken(part, counts) : part))
    .join("");
  return { text: out, counts };
}

const KIND_LABELS: Record<DiagMaskKind, string> = { url: "주소", email: "이메일", file: "파일 이름", token: "긴 값", number: "긴 숫자" };

// "주소 3 · 이메일 1"(가린 것이 없으면 "가린 것 없음").
export function maskSummary(counts: Record<DiagMaskKind, number>): string {
  const parts = (Object.keys(KIND_LABELS) as DiagMaskKind[]).filter((k) => counts[k] > 0).map((k) => `${KIND_LABELS[k]} ${counts[k]}`);
  return parts.length ? parts.join(" · ") : "가린 것 없음";
}
