// 자동 실행(승인 없이 진행) 옵션의 예외 판정. 자동 실행을 켜도 결제와 개인정보 제출은 승인 카드를 띄운다.
// 여기에는 DOM 없이 계산하는 부분만 둔다. 칸·버튼의 성격(개인정보 칸인지, 개인정보가 든 양식을 제출하는지)은
// content script가 대상 확인 때 TargetInfo에 담아 준다(src/content/forms.ts, src/content/clickables.ts).

import type { TargetInfo } from "./actionTarget.ts";

// 자동 실행 대상: 페이지 이동·클릭·입력.
// 이미지 저장(모델이 고른 주소로 요청)·파일 읽기(쿠키를 실어 요청)·Google 문서 쓰기는 자동 실행을 켜도 늘 묻는다.
export const AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "navigate_to_url",
  "click_element",
  "fill_form_fields",
]);

// 돈이 나가는 버튼: 결제·구매·주문·송금 등.
export const PAYMENT_TEXT_RE =
  /(결제|구매|구입|주문|송금|이체|충전|후원|기부|입금|\bpay\b|payment|checkout|check\s*out|\bbuy\b|purchase|place\s*order|order\s*now|donate)/i;
// 개인정보를 내보내는 버튼: 가입·신청·제출·인증 등.
const SUBMIT_TEXT_RE =
  /(가입|신청|제출|접수|본인\s*인증|인증\s*(번호|요청|하기)|예약\s*하기|문의\s*(하기|등록)|sign\s*up|register|submit|verify)/i;

// 자동 실행하면 안 되는 이유. 없으면 null(자동 실행 가능).
export function autoApproveBlock(tool: string, targets: TargetInfo[]): string | null {
  if (!AUTO_APPROVE_TOOLS.has(tool)) return "자동 실행 대상이 아닌 도구";
  if (tool === "fill_form_fields") {
    for (const t of targets) {
      if (t.sensitive === "password") return "비밀번호 칸 입력";
      if (t.sensitive === "payment") return "결제 정보 칸 입력";
      if (t.personal) return `개인정보 칸 입력('${t.name.slice(0, 30) || t.fieldType}')`;
    }
    return null;
  }
  if (tool === "click_element") {
    for (const t of targets) {
      if (PAYMENT_TEXT_RE.test(t.name)) return "결제·주문 버튼";
      if (t.paymentContext) return "결제 화면의 버튼";
      if (t.submitsPersonal) return "개인정보가 채워진 양식 제출";
      if (SUBMIT_TEXT_RE.test(t.name)) return "가입·신청·제출 버튼";
    }
    return null;
  }
  return null;
}

// 이동은 모델이 만든 주소라 대화 내용(개인정보)을 주소·호스트 이름에 실어 밖으로 보낼 수 있다.
// 사용자가 고른 출처(요청을 시작한 탭의 사이트, 승인 카드로 이동을 허락한 사이트) 안에서만 자동 실행한다.
// 자동 이동·클릭으로 들어간 사이트는 신뢰 출처가 되지 않는다(두 단계로 나눠 보내는 우회를 막음).
export function navigateAutoBlock(trustedOrigins: ReadonlySet<string>, targetUrl: string): string | null {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return "주소를 해석할 수 없음";
  }
  if (!/^https?:$/.test(target.protocol)) return "웹 주소가 아님";
  if (trustedOrigins.has(target.origin)) return null;
  return "요청을 시작한 사이트 밖으로 이동";
}
