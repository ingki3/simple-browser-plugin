// find_clickables 결과에 싣는 주소·역할 글자(#164). 등록한 대상의 원래 주소(승인·클릭 확인·원격 질문에 쓰는 값)는 바꾸지 않고,
// 모델에 보내는 결과만 길이를 정한다. 긴 주소는 앞부분만 주지 않고 비운다 — 잘린 주소를 이동·읽기 도구에 쓰면 다른 곳으로 간다.
export const HREF_MAX = 2000;
export const ROLE_MAX = 40;

export interface HrefTooLong {
  length: number;
  // 주소 앞의 scheme(구조 검사로 짧은 것만, 소문자). 맞지 않으면 없다.
  scheme?: string;
}

const SCHEME_RE = /^([a-z][a-z0-9+.-]{0,19}:)/i;

export function resultHref(href: string): { href: string; hrefTooLong?: HrefTooLong } {
  if (href.length <= HREF_MAX) return { href };
  const m = SCHEME_RE.exec(href);
  return { href: "", hrefTooLong: { length: href.length, ...(m ? { scheme: m[1].toLowerCase() } : {}) } };
}

// role 속성은 페이지가 정한 원문이라 길이를 정한다(넘으면 앞부분만 — 판정에 쓰지 않는 표시용).
export function resultRole(role: string): string {
  return role.length > ROLE_MAX ? role.slice(0, ROLE_MAX) : role;
}
