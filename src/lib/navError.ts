// 주소가 열리지 않아 탭에 Chrome 오류 화면이 떠 있을 때 모델에게 알릴 말.
// 판단은 Chrome이 webNavigation.onErrorOccurred로 준 오류 코드(net 오류 목록)로만 한다. 페이지 글자는 보지 않는다.

export interface NavigationError {
  url: string;
  error: string;
}

// 새 이동이 앞 이동을 끊을 때 나는 코드. 오류 화면이 뜨지 않으니 기록하지 않는다.
export const ABORTED_NAV_ERROR = "net::ERR_ABORTED";

export const NAV_ERROR_CODE_MAX = 80;

export type NavErrorKind = "name" | "cert" | "connection" | "other";

export function navErrorKind(error: string): NavErrorKind {
  if (error === "net::ERR_NAME_NOT_RESOLVED" || error === "net::ERR_NAME_RESOLUTION_FAILED") return "name";
  if (error.startsWith("net::ERR_CERT_") || error === "net::ERR_SSL_PROTOCOL_ERROR") return "cert";
  if (
    error.startsWith("net::ERR_CONNECTION_") ||
    error === "net::ERR_TIMED_OUT" ||
    error === "net::ERR_ADDRESS_UNREACHABLE" ||
    error === "net::ERR_INTERNET_DISCONNECTED"
  ) {
    return "connection";
  }
  return "other";
}

// 주소는 출처(scheme://host)만 알린다. 경로·쿼리에 실린 값은 넘기지 않는다.
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

const REASON: Record<NavErrorKind, string> = {
  name: "이 도메인을 찾을 수 없습니다(없는 주소일 수 있습니다).",
  cert: "사이트 인증서가 이 주소와 맞지 않거나 올바르지 않아 Chrome이 연결을 막았습니다(공식 주소가 아닐 수 있습니다). 이 경고 화면을 건너뛰어 접속하지 마세요.",
  connection: "서버에 연결하지 못했습니다.",
  other: "페이지를 열지 못했습니다.",
};

export function describeNavigationError(nav: NavigationError): string {
  const code = /^net::ERR_[A-Z0-9_]+$/.test(nav.error) ? nav.error.slice(0, NAV_ERROR_CODE_MAX) : "알 수 없는 오류";
  const origin = originOf(nav.url);
  const where = origin ? `${origin} ` : "";
  return (
    `${where}주소가 열리지 않아 탭에 Chrome 오류 화면이 떠 있습니다(${code}). ${REASON[navErrorKind(nav.error)]} ` +
    "이 화면에서는 관측·조작 도구를 쓸 수 없습니다. 짐작한 주소를 바꿔 가며 다시 시도하지 말고, " +
    "공식 주소를 확신하지 못하면 검색 엔진에서 공식 사이트를 찾거나 사용자에게 주소를 물어보세요."
  );
}
