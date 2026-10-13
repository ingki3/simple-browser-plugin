import * as pako from "pako";
import { Buffer } from "buffer/index.js";

// kordoc가 쓰는 zlib 동기 함수를 pako로 흉내 낸다. kordoc는 Node Buffer 메서드(readUInt16LE, toString("utf16le") 등)를
// 쓰므로 결과를 Buffer로 감싼다.
const B = (u) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

// kordoc는 압축 폭탄을 막으려고 maxOutputLength(HWP 스트림당 100MB 등)를 넘긴다. Node처럼 풀면서 세다가 넘는 순간
// ERR_BUFFER_TOO_LARGE로 멈춘다. 여기에 더해, 변환 Worker 하나(문서 한 건)가 푸는 양의 합계도 묶는다.
const TOTAL_BUDGET = 256 * 1024 * 1024;
let used = 0;

function tooLarge(limit) {
  const err = new RangeError(`Cannot create a Buffer larger than ${limit} bytes`);
  err.code = "ERR_BUFFER_TOO_LARGE";
  return err;
}

function inflateWith(raw, data, opts = {}) {
  const max = typeof opts.maxOutputLength === "number" ? opts.maxOutputLength : Infinity;
  const limit = Math.min(max, TOTAL_BUDGET - used);
  const inflator = new pako.Inflate({ raw });
  const chunks = [];
  let size = 0;
  inflator.onData = (chunk) => {
    size += chunk.length;
    // push() 안에서 던지면 그대로 빠져나와 더 풀지 않는다.
    if (size > limit) throw tooLarge(limit);
    chunks.push(chunk.slice());
  };
  inflator.onEnd = () => {};
  try {
    inflator.push(data, true);
  } finally {
    used += size;
  }
  // Node는 finishFlush 옵션이 있으면 끝이 잘린 스트림도 읽은 만큼 돌려준다.
  if (inflator.err && !(opts.finishFlush !== undefined && size > 0)) throw new Error(inflator.msg);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return B(out);
}

export const inflateRawSync = (d, opts) => inflateWith(true, d, opts);
export const inflateSync = (d, opts) => inflateWith(false, d, opts);
export const deflateRawSync = (d) => B(pako.deflateRaw(d));
export const deflateSync = (d) => B(pako.deflate(d));
export const constants = { Z_SYNC_FLUSH: 2, Z_FINISH: 4 };
export default { inflateRawSync, inflateSync, deflateRawSync, deflateSync, constants };
