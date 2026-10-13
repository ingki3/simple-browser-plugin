// pdf.js 워커(legacy 빌드)에 압축 해제 한도를 넣는다. 빌드 때 vite.config.ts가 적용하고, tests/pdf.test.mjs가 검사한다.
//
// pdf.js는 스트림(FlateDecode 등)을 풀 때 실제로 풀린 양을 제한하지 않아서, 수십 KB짜리 PDF가 수백 MB를 할당하게
// 만들 수 있다. 변환 Worker의 10초 시간 제한은 그 전에 생기는 메모리 고갈을 막지 못한다. 풀린 데이터가 늘어나는
// 두 곳(동기 디코더의 버퍼 확장, 브라우저 DecompressionStream 경로)에서 합계를 세다가 한도를 넘으면 오류를 던지고,
// 부모(변환 Worker)에 한 번 알린다. pdf.js는 오류 일부를 삼키고 계속하므로, 알림을 받은 쪽이 실패로 처리한다.

// pdf.js 워커 하나(문서 한 건)가 풀 수 있는 합계. 동기 디코더는 버퍼를 두 배씩 늘리므로 실제 데이터의 최대 약 2배로 센다.
export const PDF_DECODE_BUDGET = 128 * 1024 * 1024;
// 한도를 넘었을 때 워커가 보내는 메시지의 targetName. pdf.js의 메시지 처리기는 자기 이름이 아니면 무시한다.
export const PDF_BUDGET_MESSAGE = "decode-budget-exceeded";

const PRELUDE = `let __decodeUsed = 0, __decodeReported = false;
function __decodeCharge(n) {
  __decodeUsed += n;
  if (__decodeUsed <= ${PDF_DECODE_BUDGET}) return;
  if (!__decodeReported && typeof self !== "undefined" && typeof self.postMessage === "function") {
    __decodeReported = true;
    try { self.postMessage({ targetName: ${JSON.stringify(PDF_BUDGET_MESSAGE)} }); } catch {}
  }
  throw new Error("PDF decode budget exceeded");
}
`;

const PATCHES: [string, string][] = [
  [
    "    const buffer2 = new Uint8Array(size);\n    buffer2.set(buffer);\n    return this.buffer = buffer2;",
    "    __decodeCharge(size);\n    const buffer2 = new Uint8Array(size);\n    buffer2.set(buffer);\n    return this.buffer = buffer2;",
  ],
  [
    "      for await (const chunk of readable) {\n        chunks.push(chunk);\n        totalLength += chunk.byteLength;",
    "      for await (const chunk of readable) {\n        __decodeCharge(chunk.byteLength);\n        chunks.push(chunk);\n        totalLength += chunk.byteLength;",
  ],
];

export function patchPdfWorker(source: string): string {
  let out = source;
  for (const [from, to] of PATCHES) {
    const count = out.split(from).length - 1;
    // pdf.js를 올려 코드가 바뀌면 빌드를 멈춘다(한도 없이 배포되지 않도록).
    if (count !== 1) throw new Error(`pdf.js 워커 패치 위치를 찾지 못했습니다(${count}곳): ${from.split("\n")[0].trim()}`);
    out = out.replace(from, to);
  }
  return PRELUDE + out;
}
