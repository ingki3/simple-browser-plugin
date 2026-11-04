// 진단 복사(#132)의 공유 전 가리기. 판정에는 쓰지 않고, 복사할 글에서 더 가리는 쪽으로만 쓴다(잘못 가려도 진단 글이 덜 보일 뿐).
// 가릴 범위는 원문에서 한 번에(정규식 하나의 왼쪽부터) 정한다 — 앞에서 바꾼 글을 다시 훑지 않으므로 긴 토큰 안의 숫자처럼 겹치는 것이
// 조각으로 남지 않는다. 같은 자리에서는 주소 → 이메일 → 파일 이름 → 긴 값 → 숫자 순으로 고른다. npm test로 시험하므로 다른 모듈을 불러오지 않는다.

export type DiagMaskKind = "url" | "email" | "file" | "token" | "number";

export interface DiagMaskResult {
  text: string;
  counts: Record<DiagMaskKind, number>;
}

const FILE_EXT = "pdf|docx?|xlsx?|pptx?|hwpx?|odt|ods|odp|csv|tsv|txt|rtf|zip|7z|rar|png|jpe?g|gif|webp|heic|svg|mp4|mov";
const PATTERN = new RegExp(
  [
    // 주소: scheme://… (공백·큰따옴표·꺾쇠 전까지 — IPv6 호스트의 [], 경로의 ()·작은따옴표도 주소로 본다. 뒤에 붙은 문장 부호까지 먹어도 더 가릴 뿐)
    String.raw`(?<url>[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"<>{}]+)`,
    String.raw`(?<email>[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)`,
    // 파일 이름은 120자까지만 본다(긴 글에서 자리마다 끝까지 되짚지 않게 — 선형에 가깝게).
    String.raw`(?<file>[^\s/\\'"<>()\[\]{}:|]{1,120}\.(?:${FILE_EXT}))(?![A-Za-z0-9])`,
    String.raw`(?<token>[A-Za-z0-9_-]{24,})`,
    String.raw`(?<number>\d{6,})`,
  ].join("|"),
  "giu",
);

// scheme://host만 남긴다(사용자 정보는 버리고, 경로·쿼리·해시가 있으면 /…).
function maskUrl(url: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)(.*)$/.exec(url);
  if (!m) return "[주소]";
  const host = m[2].includes("@") ? m[2].slice(m[2].lastIndexOf("@") + 1) : m[2];
  const rest = m[3];
  return `${m[1]}${host}${rest && rest !== "/" ? "/…" : ""}`;
}

export function maskDiagnostics(text: string): DiagMaskResult {
  const counts: Record<DiagMaskKind, number> = { url: 0, email: 0, file: 0, token: 0, number: 0 };
  const out = text.replace(PATTERN, (...args) => {
    const groups = args[args.length - 1] as Record<DiagMaskKind, string | undefined>;
    if (groups.url !== undefined) {
      counts.url += 1;
      return maskUrl(groups.url);
    }
    if (groups.email !== undefined) {
      counts.email += 1;
      return "[이메일]";
    }
    if (groups.file !== undefined) {
      counts.file += 1;
      return `[파일].${groups.file.slice(groups.file.lastIndexOf(".") + 1)}`;
    }
    if (groups.token !== undefined) {
      counts.token += 1;
      return "[긴 값]";
    }
    counts.number += 1;
    return "[숫자]";
  });
  return { text: out, counts };
}

const KIND_LABELS: Record<DiagMaskKind, string> = { url: "주소", email: "이메일", file: "파일 이름", token: "긴 값", number: "긴 숫자" };

// "주소 3 · 이메일 1"(가린 것이 없으면 "가린 것 없음").
export function maskSummary(counts: Record<DiagMaskKind, number>): string {
  const parts = (Object.keys(KIND_LABELS) as DiagMaskKind[]).filter((k) => counts[k] > 0).map((k) => `${KIND_LABELS[k]} ${counts[k]}`);
  return parts.length ? parts.join(" · ") : "가린 것 없음";
}
