// send_to_telegram(#210)의 인자 스키마. 받는 곳 인자는 없다(strict — chat_id·to 같은 키는 거절). 받는 곳은 설정에서 연결한 채팅 하나.
// schemas.ts는 확장자 없는 import가 있어 npm test로 불러오지 못하므로 따로 둔다(zod만 쓴다).
import { z } from "zod";

// 모델이 넘길 수 있는 글의 상한. 가린 뒤의 상한(SEND_TO_TELEGRAM_MAX, lib/telegram.ts)과 같은 값이다.
export const SEND_TO_TELEGRAM_ARG_MAX = 8000;

export const sendToTelegramArgs = z
  .object({
    text: z
      .string()
      .max(SEND_TO_TELEGRAM_ARG_MAX, `글이 ${SEND_TO_TELEGRAM_ARG_MAX}자를 넘습니다. 더 짧게 나눠 보내세요.`)
      .refine((t) => t.trim().length > 0, "보낼 글이 비어 있습니다."),
  })
  .strict();
