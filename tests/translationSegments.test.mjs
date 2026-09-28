import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeSegments,
  encodeSegments,
  isUsableTranslation,
  looksUntranslated,
} from "../src/lib/translationSegments.ts";

test("single-node units are sent without segment tags", () => {
  assert.equal(encodeSegments(["Hello world"]), "Hello world");
  assert.deepEqual(decodeSegments("안녕하세요", 1), ["안녕하세요"]);
});

test("multi-node units round-trip through segment tags, in any order", () => {
  const src = encodeSegments(["I", "thought I understood RAG.", "My first pipeline"]);
  assert.equal(src, "<s0>I</s0><s1>thought I understood RAG.</s1><s2>My first pipeline</s2>");
  assert.deepEqual(decodeSegments("<s2>첫 파이프라인</s2><s0>나는</s0> <s1>RAG를 이해했다고 생각했다.</s1>", 3), [
    "나는",
    "RAG를 이해했다고 생각했다.",
    "첫 파이프라인",
  ]);
});

test("missing segments are reported as undecodable", () => {
  assert.equal(decodeSegments("<s0>나는</s0> RAG를 이해했다고 생각했다.", 2), null);
});

test("English echoed back for a Korean target counts as untranslated", () => {
  const src = "But once your documents get messy, your questions get harder.";
  assert.equal(looksUntranslated(src, src, "ko"), true);
  assert.equal(looksUntranslated(src, "하지만 문서가 지저분해지면 질문도 어려워집니다.", "ko"), false);
  assert.equal(looksUntranslated(src, src, "ko-KR"), true);
});

test("text already in the target language or too short is left alone", () => {
  assert.equal(looksUntranslated("이미 한국어 문장입니다", "이미 한국어 문장입니다", "ko"), false);
  assert.equal(looksUntranslated("RAG", "RAG", "ko"), false);
});

test("latin targets only flag identical multi-word output", () => {
  const src = "Das ist ein langer deutscher Satz.";
  assert.equal(looksUntranslated(src, src, "en"), true);
  assert.equal(looksUntranslated(src, "This is a long German sentence.", "en"), false);
});

test("usable translation requires intact segments and a real translation", () => {
  const src = "<s0>That was when I realized:</s0><s1>retrieval is the hard part.</s1>";
  assert.equal(isUsableTranslation(src, "<s0>그때 깨달았습니다:</s0><s1>검색이 어려운 부분입니다.</s1>", "ko"), true);
  assert.equal(isUsableTranslation(src, "그때 깨달았습니다: 검색이 어려운 부분입니다.", "ko"), false);
  assert.equal(isUsableTranslation(src, src, "ko"), false);
  assert.equal(isUsableTranslation(src, "", "ko"), true);
});

test("stray tags the model invents around single-node items are stripped", () => {
  // 모델이 배치 배열 순번으로 태그를 새로 만들어 감싼 경우 (실제 관측: <s3>Docling 파이프라인</s3>)
  assert.deepEqual(decodeSegments("<s3>Docling 파이프라인</s3>", 1), ["Docling 파이프라인"]);
  assert.equal(isUsableTranslation("Docling Pipeline", "<s3>Docling 파이프라인</s3>", "ko"), false);
  assert.equal(isUsableTranslation("Docling Pipeline", "Docling 파이프라인", "ko"), true);
});

test("tags nested inside a decoded segment are stripped", () => {
  assert.deepEqual(
    decodeSegments("<s0>문서 <s1>처리</s1></s0><s1>처리</s1>", 2),
    ["문서 처리", "처리"],
  );
});
