import { GoogleGenAI, Type } from "@google/genai";
import { getSettings } from "./storage";

export async function translateBatch(texts: string[], targetLang: string): Promise<string[]> {
  const { apiKey, model } = await getSettings();
  if (!apiKey) throw new Error("API 키가 설정되지 않았습니다.");
  const ai = new GoogleGenAI({ apiKey });

  const prompt = [
    `다음은 웹 페이지에서 추출한 텍스트 조각 배열이다. 각 조각을 ${targetLang} 언어로 자연스럽게 번역해라.`,
    "- 입력 배열과 동일한 길이의 JSON 문자열 배열만 출력한다.",
    "- 짧은 공백·숫자·기호만 있는 조각은 원문을 그대로 둔다.",
    "- 이미 해당 언어이면 그대로 둔다.",
    "- HTML 태그가 보이면 구조를 망가뜨리지 말고 텍스트만 번역한다.",
    "",
    "입력:",
    JSON.stringify(texts),
  ].join("\n");

  const res = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
    },
  });

  const raw = res.text ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("번역 응답 JSON 파싱 실패");
  }
  if (!Array.isArray(parsed) || parsed.length !== texts.length) {
    throw new Error(
      `번역 응답 길이 불일치: 기대 ${texts.length}, 실제 ${Array.isArray(parsed) ? parsed.length : "?"}`,
    );
  }
  return parsed.map((v) => (typeof v === "string" ? v : String(v)));
}
