// 공용 인증 층(#319): chrome.identity 접근. 기본 빌드에서 identity는 선택 권한이라 받기 전에는 API가 없고, 받거나 회수되면
// 워커가 도는 중에도 생기거나 사라진다. 그래서 모듈 최상위에서 붙잡아 두지 않고 부를 때마다 읽는다.
// 이 모듈은 권한을 요청하지 않는다(요청은 사용자 동작 안에서 설정 화면이 한다). 권한이 없을 때의 안내 문구도 부르는 쪽이 정한다.

// 지금의 chrome.identity. 권한이 없으면 null.
export function identityApi(): typeof chrome.identity | null {
  return (chrome as { identity?: typeof chrome.identity }).identity ?? null;
}

// 콘솔에 등록할 리다이렉트 URI(확장 ID 기반). identity 권한이 없어도 설정 화면이 보여 줄 수 있는 값이다.
export function expectedRedirectUri(): string {
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}
