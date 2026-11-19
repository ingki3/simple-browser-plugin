// send_to_kakao(#310)의 인자 스키마. 받는 곳 인자는 없다(strict — 받는 사람·링크 주소 같은 키는 거절). 받는 곳은 로그인한 사용자 자신.
// schemas.ts는 확장자 없는 import가 있어 npm test로 불러오지 못하므로 따로 둔다(zod만 쓴다).
import { z } from "zod";

// 모델이 넘길 수 있는 글의 상한. 가린 뒤의 상한(SEND_TO_KAKAO_MAX, lib/kakao.ts — 200자 × 5개)과 같은 값이다.
export const SEND_TO_KAKAO_ARG_MAX = 1000;

export const sendToKakaoArgs = z
  .object({
    text: z
      .string()
      .max(SEND_TO_KAKAO_ARG_MAX, `글이 ${SEND_TO_KAKAO_ARG_MAX}자를 넘습니다. 카카오톡은 한 메시지 200자, 5개(1000자)까지입니다. 요약해서 다시 보내세요.`)
      .refine((t) => t.trim().length > 0, "보낼 글이 비어 있습니다."),
  })
  .strict();
