// Office 문서(zip)를 실제로 압축 해제하며 크기를 세고, 검증된 내용만 담은 비압축(stored) zip을 다시 만든다.
// zip 중앙 디렉터리의 크기 값은 파일 작성자가 꾸밀 수 있으므로 믿지 않는다. 변환기(docling.rs-wasm)는
// 다시 만든 zip만 받으므로, 여기서 센 바이트보다 많은 데이터를 풀 수 없다.

export interface SanitizeLimits {
  // .xml/.rels 파트의 실제 압축 해제 합계 상한. 변환 비용이 여기에 비례한다.
  maxXmlBytes: number;
  // 모든 파트(이미지 등 포함)의 실제 압축 해제 합계 상한.
  maxTotalBytes: number;
}

export interface SanitizedZip {
  bytes: Uint8Array;
  xmlBytes: number;
  totalBytes: number;
}

export class ZipRejected extends Error {
  // 크기 한도 초과로 거부했는지(손상·미지원 형식과 안내를 나누기 위해).
  readonly tooLarge: boolean;
  // node --experimental-strip-types는 생성자 매개변수 속성을 지원하지 않아 필드를 따로 둔다.
  constructor(message: string, tooLarge = false) {
    super(message);
    this.tooLarge = tooLarge;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

interface Entry {
  name: Uint8Array;
  nameText: string;
  method: number;
  flags: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(bytes: Uint8Array): Entry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minPos = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipRejected("zip 형식이 아닙니다");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipRejected("ZIP64 형식은 지원하지 않습니다");
  }
  if (cdOffset + cdSize > bytes.byteLength) throw new ZipRejected("zip 목차가 손상됐습니다");

  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.byteLength || view.getUint32(pos, true) !== SIG_CEN) {
      throw new ZipRejected("zip 목차가 손상됐습니다");
    }
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipRejected("ZIP64 형식은 지원하지 않습니다");
    }
    if (pos + 46 + nameLen > bytes.byteLength) throw new ZipRejected("zip 목차가 손상됐습니다");
    const name = bytes.slice(pos + 46, pos + 46 + nameLen);
    entries.push({ name, nameText: decoder.decode(name), method, flags, compressedSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function compressedData(bytes: Uint8Array, e: Entry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (e.localOffset + 30 > bytes.byteLength || view.getUint32(e.localOffset, true) !== SIG_LOC) {
    throw new ZipRejected(`zip 항목이 손상됐습니다: ${e.nameText}`);
  }
  const start = e.localOffset + 30 + view.getUint16(e.localOffset + 26, true) + view.getUint16(e.localOffset + 28, true);
  const end = start + e.compressedSize;
  if (end > bytes.byteLength) throw new ZipRejected(`zip 항목이 손상됐습니다: ${e.nameText}`);
  return bytes.subarray(start, end);
}

// deflate 데이터를 풀면서 budget을 넘는 순간 중단한다.
async function inflateCapped(data: Uint8Array, budget: number, onOver: () => never): Promise<Uint8Array> {
  // data는 fetch로 받은 일반 ArrayBuffer의 일부다(SharedArrayBuffer 아님).
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > budget) {
        await reader.cancel().catch(() => {});
        onOver();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ZipRejected) throw err;
    throw new ZipRejected("zip 항목의 압축 데이터가 손상됐습니다");
  }
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoredZip(files: { name: Uint8Array; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + f.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOC, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, f.name.length, true);
    local.set(f.name, 30);

    const central = new Uint8Array(46 + f.name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CEN, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, f.name.length, true);
    cv.setUint32(42, offset, true);
    central.set(f.name, 46);

    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, eocd];
  return concat(parts, parts.reduce((s, p) => s + p.length, 0));
}

export async function sanitizeOfficeZip(bytes: Uint8Array, limits: SanitizeLimits): Promise<SanitizedZip> {
  const entries = readEntries(bytes);
  const files: { name: Uint8Array; data: Uint8Array }[] = [];
  let xmlBytes = 0;
  let totalBytes = 0;
  for (const e of entries) {
    if (e.flags & 0x1) throw new ZipRejected("암호가 걸린 문서는 읽을 수 없습니다");
    if (e.nameText.endsWith("/")) continue; // 디렉터리 항목
    const isXml = /\.(xml|rels)$/i.test(e.nameText);
    const budget = Math.min(
      limits.maxTotalBytes - totalBytes,
      isXml ? limits.maxXmlBytes - xmlBytes : Number.POSITIVE_INFINITY,
    );
    const over = (): never => {
      throw new ZipRejected(
        isXml
          ? `압축을 풀면 본문 XML이 ${limits.maxXmlBytes / 1024 / 1024}MB를 넘습니다`
          : `압축을 풀면 전체가 ${limits.maxTotalBytes / 1024 / 1024}MB를 넘습니다`,
        true,
      );
    };
    const raw = compressedData(bytes, e);
    let data: Uint8Array;
    if (e.method === 0) {
      if (raw.length > budget) over();
      data = raw;
    } else if (e.method === 8) {
      data = await inflateCapped(raw, budget, over);
    } else {
      throw new ZipRejected(`지원하지 않는 압축 방식(${e.method})입니다`);
    }
    if (isXml) xmlBytes += data.length;
    totalBytes += data.length;
    files.push({ name: e.name, data });
  }
  return { bytes: buildStoredZip(files), xmlBytes, totalBytes };
}
