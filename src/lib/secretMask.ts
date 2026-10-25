// 비밀 값 가리기(자동 로그인, docs/design/login-automation.md). sign_in이 페이지에 넣은 아이디·비밀번호·일회용 코드를 모델로 가는
// 글자에서 지운다. 페이지가 채운 값을 일반 글자·접근성 이름·주소로 옮겨도(같은 값과 흔한 표현) 다음 관측에 실려 가지 않게 한다.
// 낱말 뜻으로 판단하지 않고, 우리가 넣은 값 그대로만 찾는다(더 가리는 쪽).
// 한계: 페이지 스크립트가 값을 마음대로 바꿔 쓰면(뒤집기·나눠 쓰기) 찾지 못한다 — 그런 스크립트는 값을 자기 서버로 바로 보낼 수도
// 있어, 그 사이트를 믿고 값을 맡기는 모든 비밀번호 관리자의 공통 한계다.

export const MASK = "[가린 값]";

// 너무 짧은 값은 다른 글자와 우연히 겹치기 쉬워도 가린다(일회용 코드 6자리 등). 다만 1~2글자는 문장 전체를 망가뜨려 넣지 않는다.
const MIN_SECRET_LENGTH = 3;

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 값 하나를 찾을 표현들: 그대로, URL 인코딩(encodeURIComponent·폼 인코딩의 +), HTML 엔티티, base64(패딩 있음·없음, URL용 글자).
export function secretForms(value: string): string[] {
  if (value.length < MIN_SECRET_LENGTH) return [];
  const forms = new Set<string>([value]);
  const uri = encodeURIComponent(value);
  forms.add(uri);
  forms.add(uri.replace(/%20/g, "+"));
  forms.add(encodeURI(value));
  forms.add(htmlEscape(value));
  const b = utf8Base64(value);
  forms.add(b);
  forms.add(b.replace(/=+$/, ""));
  forms.add(b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  // URL 인코딩은 대소문자를 섞어 쓸 수 있다(%2f).
  forms.add(uri.toLowerCase());
  // JSON 문자열 안에 든 모양(따옴표·역슬래시·제어 문자가 이스케이프됨). 도구 결과는 JSON으로 직렬화해 기록에 넣는다.
  forms.add(JSON.stringify(value).slice(1, -1));
  forms.add(JSON.stringify(htmlEscape(value)).slice(1, -1));
  return [...forms].filter((f) => f.length >= MIN_SECRET_LENGTH);
}

// 긴 표현부터 바꾼다(짧은 것이 긴 것의 일부일 때 긴 것을 먼저 지우게).
export function maskText(text: string, secrets: Iterable<string>): { text: string; masked: boolean } {
  const forms = new Set<string>();
  for (const s of secrets) for (const f of secretForms(s)) forms.add(f);
  if (!forms.size || !text) return { text, masked: false };
  let out = text;
  let masked = false;
  for (const f of [...forms].sort((a, b) => b.length - a.length)) {
    if (!out.includes(f)) continue;
    out = out.split(f).join(MASK);
    masked = true;
  }
  return { text: out, masked };
}

// JSON 모양의 값 안의 모든 글자를 가린다(객체 키도). 원본은 바꾸지 않는다.
export function maskDeep<T>(value: T, secrets: readonly string[]): { value: T; masked: boolean } {
  if (!secrets.length) return { value, masked: false };
  let masked = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = maskText(v, secrets);
      if (r.masked) masked = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const key = walk(k) as string;
        out[key] = walk(x);
      }
      return out;
    }
    return v;
  };
  const next = walk(value) as T;
  return { value: masked ? next : value, masked };
}
