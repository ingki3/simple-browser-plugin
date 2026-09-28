// 한 블록(문단) 안에 흩어진 여러 텍스트 노드를 하나의 번역 단위로 묶기 위한 인코딩.
// <strong>, <a>, 드롭캡 span 등으로 쪼개진 문장을 문맥째 번역하고, 결과를
// 원래 노드 자리에 다시 나눠 넣는다.

export function encodeSegments(texts: string[]): string {
  if (texts.length === 1) return texts[0];
  return texts.map((t, i) => `<s${i}>${t}</s${i}>`).join("");
}

// 세그먼트가 하나라도 빠지면 null. 호출부가 폴백 방식을 고른다.
// 모델이 태그를 새로 만들거나(단일 노드 조각을 배열 순번 태그로 감싸는 경우) 중첩시키면
// 남은 태그가 화면에 그대로 드러나므로, 각 결과에서 태그는 모두 걷어낸다.
export function decodeSegments(raw: string, count: number): string[] | null {
  if (count === 1) return [stripSegmentTags(raw)];
  const out: Array<string | undefined> = new Array(count);
  const re = /<s(\d+)>([\s\S]*?)<\/s\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const idx = Number(m[1]);
    if (idx < count && out[idx] === undefined) out[idx] = stripSegmentTags(m[2]);
  }
  for (let i = 0; i < count; i += 1) if (out[i] === undefined) return null;
  return out as string[];
}

export function stripSegmentTags(raw: string): string {
  return raw.replace(/<\/?s\d+>/g, "");
}

// 대상 언어 고유 문자가 있는 언어는 결과에 그 문자가 있는지로 번역 여부를 판단.
const TARGET_SCRIPT: Record<string, RegExp> = {
  ko: /\p{Script=Hangul}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  ar: /\p{Script=Arabic}/u,
  he: /\p{Script=Hebrew}/u,
  th: /\p{Script=Thai}/u,
  hi: /\p{Script=Devanagari}/u,
  el: /\p{Script=Greek}/u,
};

const normalize = (s: string) => stripSegmentTags(s).replace(/\s+/g, " ").trim();

// 모델이 번역하지 않고 원문을 그대로 돌려준 것으로 보이는지.
// 이런 결과를 "번역 완료"로 확정·캐시하면 새로고침해도 같은 문단이 영어로 남는다.
export function looksUntranslated(source: string, output: string, targetLang: string): boolean {
  const src = normalize(source);
  const out = normalize(output);
  const letters = src.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 4) return false;
  const script = TARGET_SCRIPT[targetLang.toLowerCase().split(/[-_]/)[0]];
  if (script) {
    // 원문부터 대상 문자로 쓰여 있으면 그대로 두는 게 정답.
    if (script.test(src)) return false;
    return !script.test(out);
  }
  return out === src && src.split(" ").length >= 3;
}

// 원문에 들어 있는 세그먼트 태그 개수. 태그가 없으면 단일 노드 단위라 1.
export function segmentCount(source: string): number {
  return source.match(/<s\d+>/g)?.length || 1;
}

// 확정·캐시해도 되는 번역 결과인지. 아니면 다시 요청할 가치가 있다.
export function isUsableTranslation(source: string, output: string, targetLang: string): boolean {
  if (!output.trim()) return true;
  // 원문에 없던 태그가 붙어 왔으면 형식을 오해한 응답이라 캐시하지 않는다.
  if (!/<s\d+>/.test(source) && /<\/?s\d+>/.test(output)) return false;
  if (decodeSegments(output, segmentCount(source)) === null) return false;
  return !looksUntranslated(source, output, targetLang);
}
