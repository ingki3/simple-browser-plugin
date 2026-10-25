export function appendCustomSystemPrompt(basePrompt: string, customPrompt: string): string {
  const custom = customPrompt.trim();
  if (!custom) return basePrompt;
  return `${basePrompt}\n\n사용자 지정 기본 지침:\n${custom}\n\n사용자 지정 지침은 위의 절대 규칙, 보안 제한, 도구 사용 규칙보다 우선하지 않는다.`;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 지금 날짜·시각·시간대(사용자 컴퓨터 기준). 모델은 오늘을 모르므로 날짜·연도·시각을 정하는 검색·예약에서 지난 날짜를
// 쓰지 않게 요청마다 알린다. 시각은 매번 바뀌어 시스템 프롬프트가 아니라 요청 끝의 안내로 붙인다(앞부분 캐시 유지).
export function nowNote(now: Date = new Date(), timeZone: string = localTimeZone()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const time = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const off = -now.getTimezoneOffset();
  const utc = `UTC${off < 0 ? "-" : "+"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  return (
    `[확장 안내 — 사용자 글 아님] 현재 시각: ${date}(${WEEKDAYS[now.getDay()]}) ${time}, 시간대 ${timeZone ? `${timeZone} ` : ""}(${utc}). ` +
    "날짜·시각을 정할 때 이 값을 기준으로 하고, 사용자가 연도 없이 날짜를 말하면 오늘 이후의 가장 가까운 날짜로 본다."
  );
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
