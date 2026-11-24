// 공용 인증 층(#319): 설정 화면이 보내는 인증 메시지 처리. index.ts의 메시지 리스너가 부른다.
// 응답 모양·거절 문구·돌려주는 값은 index.ts에 있던 때와 같다.
import { isOptionsPageSender } from "@/lib/optionsSender";
import { kakaoClear, kakaoConnect, kakaoDisconnect, kakaoSaveKeys, kakaoStatus, kakaoTestSend } from "../kakao";

// 설정 페이지(옵션 페이지, 해시 제외 전체 URL)에서 보낸 메시지인지(#310 카카오 연결·시험 전송). 사이드 패널·웹 문서(content script)는 아니다.
function fromOptionsPage(sender: chrome.runtime.MessageSender): boolean {
  const page = chrome.runtime.getManifest().options_page;
  return isOptionsPageSender(sender, chrome.runtime.id, page ? chrome.runtime.getURL(page) : undefined);
}

// 인증 설정 메시지면 처리하고 리스너가 돌려줄 값(true: 나중에 응답, false: 이미 응답)을 돌려준다. 아니면 undefined(다른 처리기로).
export function handleAuthSettingsMessage(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as { kind?: string };

  // 카카오톡 나에게 보내기(#310, 설정 화면). 설정 페이지에서만 받는다(패널·content script 거절 — OAuth·전송 호출 없이).
  // 키·시크릿·토큰·링크 주소는 돌려주지 않는다(허용한 상태 필드만).
  if (
    m.kind === "kakao_status" ||
    m.kind === "kakao_save_keys" ||
    m.kind === "kakao_connect" ||
    m.kind === "kakao_disconnect" ||
    m.kind === "kakao_clear" ||
    m.kind === "kakao_test_send"
  ) {
    if (!fromOptionsPage(sender)) {
      sendResponse({ ok: false, error: "허용되지 않은 요청" });
      return false;
    }
    const p = msg as { restKey?: unknown; clientSecret?: unknown; linkUrl?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const job =
      m.kind === "kakao_save_keys"
        ? kakaoSaveKeys({ restKey: str(p.restKey), clientSecret: str(p.clientSecret), linkUrl: str(p.linkUrl) })
        : m.kind === "kakao_connect"
          ? kakaoConnect()
          : m.kind === "kakao_disconnect"
            ? kakaoDisconnect()
            : m.kind === "kakao_clear"
              ? kakaoClear()
              : m.kind === "kakao_test_send"
                ? kakaoTestSend()
                : kakaoStatus();
    job
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  return undefined;
}
