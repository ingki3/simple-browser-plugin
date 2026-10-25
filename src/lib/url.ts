// 주소의 출처(#91). 판정에 쓰는 것은 http(s)만 인정하고, 표시에 쓰는 것은 실패해도 무언가를 보여 준다.

// http(s) 주소의 출처(scheme://host:port). 웹 주소가 아니거나 해석할 수 없으면 null.
export function httpOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

// 표시용 출처: 해석되면 출처(scheme 무관), 아니면 앞 40자.
export function originLabel(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.slice(0, 40);
  }
}
