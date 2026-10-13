import * as pako from "pako";
import { Buffer } from "buffer/index.js";
// kordoc는 Node Buffer 메서드(readUInt16LE, toString("utf16le") 등)를 쓴다.
const B = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
const wrap = (f) => (d, opts) => {
  try { return B(f(d)); }
  catch (e) {
    // Node는 끝이 잘린 스트림도 finishFlush 옵션이면 읽은 만큼 돌려준다.
    if (opts && opts.finishFlush !== undefined) {
      const inf = new pako.Inflate({ raw: f === pako.inflateRaw });
      inf.push(d, false);
      if (inf.result && inf.result.length) return B(inf.result);
    }
    throw e;
  }
};
export const inflateRawSync = wrap(pako.inflateRaw);
export const inflateSync = wrap(pako.inflate);
export const deflateRawSync = (d) => B(pako.deflateRaw(d));
export const deflateSync = (d) => B(pako.deflate(d));
export default { inflateRawSync, inflateSync, deflateRawSync, deflateSync };
