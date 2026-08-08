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

export function parseTranslationResponse(raw: string, expectedCount: number): string[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("번역 응답 JSON 파싱 실패");
  }

  const values =
    parsed && typeof parsed === "object"
      ? (parsed as { translations?: unknown }).translations
      : undefined;
  if (!Array.isArray(values) || values.length !== expectedCount) {
    throw new Error(
      `번역 응답 길이 불일치: 기대 ${expectedCount}, 실제 ${Array.isArray(values) ? values.length : "?"}`,
    );
  }
  return values.map((value) => (typeof value === "string" ? value : String(value)));
}
