// 한글(HWP 3·5, HWPX)을 kordoc로 읽는다. kordoc는 Node용이라 vendor/kordoc에서 브라우저용으로 묶은 번들을 쓴다.
import type { DocumentJobFailure } from "@/lib/documentJob";

export async function convertHwp(bytes: Uint8Array): Promise<DocumentJobFailure | { ok: true; markdown: string }> {
  const kordoc = await import("kordoc-hwp");
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const detected = kordoc.detectFormat(buffer);
  let parse: typeof kordoc.parseHwp;
  if (detected === "hwpx") parse = kordoc.parseHwpx;
  else if (detected === "hwp3") parse = kordoc.parseHwp3;
  else if (detected === "hwp") {
    // HWP 5와 구형 Office(.doc·.xls·.ppt)는 같은 OLE 서명을 쓴다.
    if (kordoc.detectOle2Format(buffer) !== "hwp") {
      return { ok: false, kind: "convert", message: "한글(HWP) 문서가 아닙니다. 구형 Office(.doc·.xls·.ppt) 파일일 수 있으며, 이 형식은 지원하지 않습니다" };
    }
    parse = kordoc.parseHwp;
  } else {
    return { ok: false, kind: "convert", message: "지원하지 않는 한글 문서 형식입니다" };
  }
  const result = await parse(buffer, { ocr: false });
  if (!result.success) {
    if (result.code === "ENCRYPTED" || result.code === "DRM_PROTECTED") return { ok: false, kind: "encrypted" };
    return { ok: false, kind: "convert", message: result.error };
  }
  // 그림은 내용 없이 자리표시만 남긴다(docling과 같은 표기).
  return { ok: true, markdown: result.markdown.replace(/!\[image\]\([^)]*\)/g, "<!-- image -->") };
}
