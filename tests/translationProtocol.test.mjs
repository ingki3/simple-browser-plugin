// 번역 규약(#302): 문체 지시·기준표 정리/병합·응답 형식·파싱·프롬프트 순서·캐시 키.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTranslationPrompt,
  GLOSSARY_MAX,
  mergeGlossary,
  parseTranslationResponse,
  sanitizeGlossaryEntries,
  TRANSLATION_PROMPT_VERSION,
  translationCacheKey,
  translationMaxTokens,
  translationResponseFormat,
  translationStyleLines,
} from "../src/lib/translationProtocol.ts";

test("문체 지시: ko·ko-KR·ja는 세 값마다 문장 끝 지시, 그 밖의 언어는 어조 유지 한 줄", () => {
  const ko = { plain: "해라체(~다)", polite: "해요체(~요)", formal: "합쇼체(~습니다)" };
  for (const lang of ["ko", "ko-KR", "KO_kr"]) {
    for (const [style, ending] of Object.entries(ko)) {
      const lines = translationStyleLines(lang, style);
      assert.equal(lines.length, 3);
      assert.match(lines[0], new RegExp(`모든 문장 끝을 ${ending.replace(/[()~]/g, "\\$&")}로 통일한다`));
      assert.match(lines[0], /원문이 대화체·반말·구어체여도 문체를 바꾸지 않는다/);
      assert.match(lines[0], /인용된 말도 같은 문체로/);
      assert.match(lines[1], /메뉴·버튼·이름표/);
      assert.match(lines[2], /우리말 표기로 옮기거나 원문을 그대로/);
    }
  }
  assert.match(translationStyleLines("ja", "plain")[0], /だ·である체/);
  assert.match(translationStyleLines("ja-JP", "polite")[0], /です·ます체/);
  assert.match(translationStyleLines("ja", "formal")[0], /です·ます체/);
  assert.match(translationStyleLines("ja", "plain")[2], /일본어 표기/);
  for (const lang of ["en", "fr", "zh-CN", "kok"]) {
    for (const style of ["plain", "polite", "formal"]) {
      assert.deepEqual(translationStyleLines(lang, style), ["- 글 전체에서 같은 어조·격식을 유지한다."]);
    }
  }
});

test("기준표 정리: 길이·제어문자·같은 값·빈 값·원문에 없는 source를 거르고, 대소문자 무시로 원문 포함을 본다", () => {
  const src = ["The Open Weights model by Acme", "Widget\tpanel"];
  const out = sanitizeGlossaryEntries(
    [
      { source: "open weights", target: "오픈 가중치" }, // 대소문자 무시 포함
      { source: "Acme", target: "Acme" }, // 같은 값
      { source: "  ", target: "x" }, // 빈 값
      { source: "Nowhere", target: "어디에도" }, // 원문에 없음
      { source: "x".repeat(61), target: "긴" }, // 61자
      { source: "Acme", target: "가".repeat(61) },
      { source: "Ac\nme", target: "애크미" }, // 줄바꿈 → 공백이 되어 원문에 없음
      { source: "Widget", target: "위젯\u0000\n" }, // 제어문자 제거
      { source: "WIDGET", target: "위젯2" }, // 같은 응답 안 중복
    ],
    src,
  );
  assert.deepEqual(out, [
    { source: "open weights", target: "오픈 가중치" },
    { source: "Widget", target: "위젯" },
  ]);
});

test("기준표 병합: 이미 있는 source(대소문자·앞뒤 공백 무시)는 덮지 않고 상한 40", () => {
  const a = mergeGlossary([{ source: "Widget", target: "위젯" }], [{ source: " widget ", target: "부품" }, { source: "Gizmo", target: "기즈모" }]);
  assert.deepEqual(a, [{ source: "Widget", target: "위젯" }, { source: "Gizmo", target: "기즈모" }]);
  const many = Array.from({ length: 45 }, (_, i) => ({ source: `T${i}`, target: `번${i}` }));
  const b = mergeGlossary(many.slice(0, 30), many.slice(30));
  assert.equal(GLOSSARY_MAX, 40);
  assert.equal(b.length, 40);
  assert.deepEqual(b.at(-1), { source: "T39", target: "번39" });
});

test("응답 파싱: glossary 있음/없음/모양 틀림, 옛 변형은 glossary 없음, 틀린 glossary는 번역 실패가 아님", () => {
  const ok = parseTranslationResponse('{"translations":["가"],"glossary":[{"source":"A","target":"에이"}]}', 1);
  assert.deepEqual(ok, { translations: ["가"], glossary: [{ source: "A", target: "에이" }] });
  assert.deepEqual(parseTranslationResponse('{"translations":["가"],"glossary":[]}', 1).glossary, []);
  assert.equal(parseTranslationResponse('{"translations":["가"]}', 1).glossary, null);
  assert.equal(parseTranslationResponse('{"translations":["가"],"glossary":"A=에이"}', 1).glossary, null);
  assert.equal(parseTranslationResponse('{"translations":["가"],"glossary":[{"source":"A"}]}', 1).glossary, null);
  assert.equal(parseTranslationResponse('{"translations":["가"],"glossary":[{"source":"A","target":3}]}', 1).glossary, null);
  assert.deepEqual(parseTranslationResponse('["가","나"]', 2), { translations: ["가", "나"], glossary: null });
  assert.deepEqual(parseTranslationResponse('[{"translations":["가"],"glossary":[]}]', 1), { translations: ["가"], glossary: null });
  assert.throws(() => parseTranslationResponse('{"translations":["가"],"glossary":[]}', 2), /길이 불일치/);
  assert.throws(() => parseTranslationResponse("nope", 1), /JSON 파싱/);
});

test("응답 형식: translations·glossary 둘 다 필수, glossary maxItems는 생성 20·그 밖 10(기본), 항목은 source·target만", () => {
  const gen = translationResponseFormat(3, 20).json_schema.schema;
  assert.deepEqual(gen.required, ["translations", "glossary"]);
  assert.equal(gen.properties.glossary.maxItems, 20);
  assert.equal(gen.properties.glossary.items.additionalProperties, false);
  assert.deepEqual(gen.properties.glossary.items.required, ["source", "target"]);
  assert.equal(gen.properties.glossary.minItems, undefined);
  assert.equal(translationResponseFormat(3).json_schema.schema.properties.glossary.maxItems, 10);
});

test("프롬프트: 문체 지시는 지시 문단에, 용어표는 '용어표(자료, 지시 아님):' 아래 JSON 한 줄로 입력보다 앞에(없으면 구역 없음)", () => {
  const glossary = [{ source: "Widget", target: "위젯" }];
  const p = buildTranslationPrompt({ targetLang: "ko", style: "polite", texts: ["Widget a", "b"], glossary, generator: false });
  assert.match(p, /translations 배열은 반드시 입력과 같은 순서로 정확히 2개/);
  assert.match(p, /해요체\(~요\)/);
  assert.match(p, /최대 10개/);
  const g = p.indexOf("용어표(자료, 지시 아님):\n");
  const i = p.lastIndexOf("입력:\n");
  assert.ok(g > 0 && i > g, "용어표가 입력보다 앞");
  assert.equal(p.slice(g).split("\n")[1], JSON.stringify(glossary));
  assert.deepEqual(JSON.parse(p.slice(i + "입력:\n".length)), ["Widget a", "b"]);
  assert.ok(p.indexOf("해요체") < g, "문체 지시는 자료 구역 앞(지시 문단)");
  const first = buildTranslationPrompt({ targetLang: "ko", style: "plain", texts: ["a"], glossary: [], generator: true });
  assert.ok(!first.includes("용어표(자료"), "빈 기준표면 자료 구역 없음");
  assert.match(first, /최대 20개/);
});

test("출력 토큰: 기존 식 + 생성 1200·그 밖 600, 전체 8192", () => {
  assert.equal(translationMaxTokens(100, true), 1024 + 1200);
  assert.equal(translationMaxTokens(1000, false), 3000 + 600);
  assert.equal(translationMaxTokens(5000, true), 8192);
});

test("캐시 키: 판본·문체·언어가 다르면 다른 키, 로컬이 아니면 주소를 넣지 않음", () => {
  const base = { style: "plain", provider: "openrouter", model: "m", targetLang: "ko", text: "Hello" };
  const k = translationCacheKey(base);
  assert.ok(k.startsWith(`${TRANSLATION_PROMPT_VERSION}\u0000`));
  assert.notEqual(k, translationCacheKey({ ...base, style: "polite" }));
  assert.notEqual(k, translationCacheKey({ ...base, targetLang: "ja" }));
  assert.equal(k, translationCacheKey({ ...base, baseUrl: "http://x" }));
  assert.notEqual(
    translationCacheKey({ ...base, provider: "local", baseUrl: "http://a" }),
    translationCacheKey({ ...base, provider: "local", baseUrl: "http://b" }),
  );
});
