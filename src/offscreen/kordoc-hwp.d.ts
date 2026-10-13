// vendor/kordoc/dist/kordoc-hwp.js(vite.config.ts의 별칭)에서 쓰는 부분만 적는다.
declare module "kordoc-hwp" {
  type ParseResult =
    | { success: true; markdown: string; warnings?: { code: string; message: string }[] }
    | { success: false; error: string; code?: string };
  type Parser = (buffer: ArrayBuffer, options?: { ocr?: boolean }) => Promise<ParseResult>;
  export function detectFormat(buffer: ArrayBuffer): string;
  export function detectOle2Format(buffer: ArrayBuffer): "hwp" | "xls" | "unknown";
  export const parseHwp: Parser;
  export const parseHwp3: Parser;
  export const parseHwpx: Parser;
}
