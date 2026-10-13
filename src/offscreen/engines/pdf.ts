// PDF의 글자 층을 pdf.js로 읽는다. 글자만 뽑고(렌더링·스크립트·글꼴 로딩 없음) 변환 Worker 안에서만 돈다.
// docling.rs의 PDF 변환은 한국어 띄어쓰기와 표가 깨져서 쓰지 않는다.
// 현대 브라우저용 빌드는 Chrome 140에서 생긴 Uint8Array.prototype.toHex()를 쓴다. manifest의 최소 버전(116)에서도
// 돌도록 호환(legacy) 빌드를 쓴다.
import type { DocumentJobResult } from "@/lib/documentJob";
import { PDF_BUDGET_MESSAGE, PDF_DECODE_BUDGET } from "../../../scripts/pdfjsWorkerPatch";

// 압축 해제 한도를 넣은 pdf.js 워커. 빌드 때 vite.config.ts가 만들어 넣는다.
const PDF_WORKER_URL = new URL("/pdfjs/pdf.worker.mjs", self.location.href).href;

// CID 글꼴(한·중·일)의 글자 코드를 유니코드로 바꾸는 표. 빌드 때 확장 안 pdfjs/cmaps/로 복사한다.
const CMAP_URL = new URL("/pdfjs/cmaps/", self.location.href).href;

export async function convertPdf(bytes: Uint8Array, maxChars: number): Promise<DocumentJobResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js는 해석을 자기 Worker에서 한다. 이 변환 Worker 안에 만든 하위 Worker라, 시간 초과·중단으로
  // 변환 Worker가 끝나면 함께 끝난다. workerSrc만 주면 pdf.js가 window.location을 읽다 실패해 같은 스레드에서
  // 돌리는데, 그때 pdf.js 워커 코드가 이 Worker의 부모(offscreen 문서)로 메시지를 보내므로 Worker를 직접 만들어 넘긴다.
  const pdfWorker = new Worker(PDF_WORKER_URL, { type: "module" });
  const budget = { exceeded: false };
  pdfWorker.addEventListener("message", (ev: MessageEvent) => {
    if ((ev.data as { targetName?: unknown } | null)?.targetName === PDF_BUDGET_MESSAGE) budget.exceeded = true;
  });
  const overBudget: DocumentJobResult = {
    ok: false,
    kind: "rejected",
    message: `압축을 풀면 ${PDF_DECODE_BUDGET / 1024 / 1024}MB를 넘습니다`,
    tooLarge: true,
  };
  try {
    const result = await extract(pdfjs, pdfWorker, bytes, maxChars, budget);
    return budget.exceeded ? overBudget : result;
  } catch (err) {
    if (budget.exceeded) return overBudget;
    throw err;
  } finally {
    pdfWorker.terminate();
  }
}

async function extract(
  pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"),
  pdfWorker: Worker,
  bytes: Uint8Array,
  maxChars: number,
  budget: { exceeded: boolean },
): Promise<DocumentJobResult> {
  const worker = pdfjs.PDFWorker.create({ port: pdfWorker });

  const task = pdfjs.getDocument({
    data: bytes,
    worker,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    // CMap은 pdf.js Worker가 직접 fetch로 읽게 한다. 기본값이면 이 Worker에서 document.baseURI를 쓰는 로더로 읽다가
    // 실패해, 글꼴을 내장하지 않은 한국어 PDF의 글자가 빠진다.
    useWorkerFetch: true,
    // 글자만 뽑으므로 글꼴 로딩·XFA가 필요 없다. CVE-2024-4367(글꼴 경로의 eval)은 pdf.js 6에서 eval 경로가
    // 없어졌고, 확장 CSP도 eval을 막는다.
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "PasswordException") return { ok: false, kind: "encrypted" };
    return { ok: false, kind: "convert", message: err instanceof Error ? err.message : String(err) };
  }

  const pages = doc.numPages;
  let out = "";
  let read = 0;
  for (let n = 1; n <= pages && out.length <= maxChars && !budget.exceeded; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
    }
    page.cleanup();
    read = n;
    text = text.trim();
    if (text) out += `${out ? "\n\n" : ""}[${n}쪽]\n${text}`;
  }
  await task.destroy();

  if (!out.replace(/\[\d+쪽\]/g, "").trim()) return { ok: false, kind: "empty" };
  const truncated = out.length > maxChars || read < pages;
  return {
    ok: true,
    markdown: out.length > maxChars ? out.slice(0, maxChars) : out,
    totalChars: out.length,
    truncated,
    note: read < pages ? `전체 ${pages}쪽 중 ${read}쪽까지 읽었습니다.` : `전체 ${pages}쪽.`,
  };
}
