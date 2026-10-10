export function translationResponseFormat(expectedCount: number): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "translation_batch",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          translations: {
            type: "array",
            description: "입력과 같은 순서와 개수의 번역 문자열",
            items: { type: "string" },
            minItems: expectedCount,
            maxItems: expectedCount,
          },
        },
        required: ["translations"],
      },
    },
  };
}

// json_schema를 무시하는 모델이 있다 (예: deepseek). 개수가 맞는 번역을 버리지 않도록
// 흔한 변형을 모두 받아준다: {"translations":[…]}, 맨 배열 […], [{"translations":[…]}].
function extractTranslations(parsed: unknown): unknown {
  if (Array.isArray(parsed)) {
    if (parsed.length === 1 && parsed[0] && typeof parsed[0] === "object") {
      const inner = (parsed[0] as { translations?: unknown }).translations;
      if (Array.isArray(inner)) return inner;
    }
    return parsed;
  }
  if (parsed && typeof parsed === "object") {
    return (parsed as { translations?: unknown }).translations;
  }
  return undefined;
}

export function parseTranslationResponse(raw: string, expectedCount: number): string[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("번역 응답 JSON 파싱 실패");
  }

  const values = extractTranslations(parsed);
  if (!Array.isArray(values) || values.length !== expectedCount) {
    throw new Error(
      `번역 응답 길이 불일치: 기대 ${expectedCount}, 실제 ${Array.isArray(values) ? values.length : "?"}`,
    );
  }
  return values.map((value) => (typeof value === "string" ? value : String(value)));
}
