// 설정 메시지를 보낸 곳이 설정 페이지(옵션 페이지)인지 판정한다(#310 카카오 연결·시험 전송, #319 공용 인증 층).
// 판정은 구조(확장 ID와 주소)로만 한다. 순수 함수 — chrome을 읽지 않고, 부르는 쪽이 지금 값을 넘긴다.

export interface MessageSenderLike {
  id?: string;
  url?: string;
}

// sender가 이 확장(runtimeId)의 설정 페이지에서 보낸 것인지. optionsUrl은 chrome.runtime.getURL(manifest.options_page)이고
// manifest에 설정 페이지가 없으면 undefined(그러면 늘 거절). 발신 주소는 해시만 떼고 전체를 비교한다 — 사이드 패널, 웹 문서의
// content script(경로만 같은 웹 주소 포함), 쿼리를 붙여 연 설정 페이지는 아니다.
export function isOptionsPageSender(sender: MessageSenderLike, runtimeId: string, optionsUrl: string | undefined): boolean {
  if (sender.id !== runtimeId || !optionsUrl || typeof sender.url !== "string") return false;
  return sender.url.split("#")[0] === optionsUrl;
}
