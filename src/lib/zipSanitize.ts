// Office 문서(zip)를 실제로 압축 해제하며 크기를 세고, 검증된 내용만 담은 비압축(stored) zip을 다시 만든다.
// zip 중앙 디렉터리의 크기 값은 파일 작성자가 꾸밀 수 있으므로 믿지 않는다. 변환기(docling.rs-wasm)는
// 다시 만든 zip만 받으므로, 여기서 센 바이트보다 많은 데이터를 풀 수 없다.
//
// 파트 이름(확장자·경로)도 작성자가 정하므로 종류 판단에 쓰지 않는다. 내용 앞부분이 이미지·영상 등
// 알려진 바이너리 형식이면 비워서 넘기고(변환기는 그림을 자리표시로만 출력한다), 나머지는 모두
// 변환기가 해석할 수 있는 파트로 보고 maxXmlBytes에 넣는다. XML 앞에 PNG 서명을 붙여 위장해도
// 비워지므로 해석되지 않는다.

export interface SanitizeLimits {
  // 변환기에 넘기는 파트(알려진 바이너리를 뺀 전부)의 실제 압축 해제 합계 상한. 변환 비용이 여기에 비례한다.
  maxXmlBytes: number;
  // 모든 파트(이미지 등 포함)의 실제 압축 해제 합계 상한. 압축 해제 작업량을 묶는다.
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
  crc: number;
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
    const crc = view.getUint32(pos + 16, true);
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
    entries.push({ name, nameText: decoder.decode(name), method, flags, crc, compressedSize, localOffset });
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

function startsWith(data: Uint8Array, sig: number[], at = 0): boolean {
  if (data.length < at + sig.length) return false;
  return sig.every((b, i) => data[at + i] === b);
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

// 문서에 흔히 들어가는 이미지·영상·소리·포함 개체의 서명.
const BINARY_SIGNATURES: { sig: number[]; at?: number }[] = [
  { sig: [0x89, 0x50, 0x4e, 0x47] }, // PNG
  { sig: [0xff, 0xd8, 0xff] }, // JPEG
  { sig: ascii("GIF8") },
  { sig: ascii("BM") },
  { sig: [0x49, 0x49, 0x2a, 0x00] }, // TIFF(LE)
  { sig: [0x4d, 0x4d, 0x00, 0x2a] }, // TIFF(BE)
  { sig: ascii(" EMF"), at: 40 },
  { sig: [0xd7, 0xcd, 0xc6, 0x9a] }, // WMF(placeable)
  { sig: [0x01, 0x00, 0x09, 0x00] }, // WMF
  { sig: [0x02, 0x00, 0x09, 0x00] }, // WMF
  { sig: [0x1f, 0x8b] }, // gzip(EMZ·WMZ)
  { sig: [0x00, 0x00, 0x01, 0x00] }, // ICO
  { sig: ascii("RIFF") }, // WebP·WAV·AVI
  { sig: ascii("ftyp"), at: 4 }, // MP4·MOV·M4A
  { sig: ascii("ID3") }, // MP3
  { sig: [0x1a, 0x45, 0xdf, 0xa3] }, // WebM·MKV
  { sig: ascii("PK") }, // 포함된 Office 파일 등
  { sig: [0xd0, 0xcf, 0x11, 0xe0] }, // OLE(포함 개체)
  { sig: ascii("%PDF") },
];

function isKnownBinary(data: Uint8Array): boolean {
  return BINARY_SIGNATURES.some(({ sig, at }) => startsWith(data, sig, at));
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

// 형식 판별용으로 zip 목차의 항목 이름과 mimetype 항목(OpenDocument·HWPX가 압축 없이 맨 앞에 둔다)을 읽는다.
// 압축을 풀지 않으므로 큰 파일에도 비용이 거의 없다. zip이 아니거나 목차가 손상됐으면 ZipRejected.
export function peekZip(bytes: Uint8Array): { names: string[]; mimetype: string | null } {
  const entries = readEntries(bytes);
  const mimeEntry = entries.find((e) => e.nameText === "mimetype" && e.method === 0 && e.compressedSize <= 200);
  let mimetype: string | null = null;
  if (mimeEntry) {
    try {
      mimetype = new TextDecoder().decode(compressedData(bytes, mimeEntry));
    } catch {
      mimetype = null;
    }
  }
  return { names: entries.map((e) => e.nameText), mimetype };
}

export async function sanitizeOfficeZip(bytes: Uint8Array, limits: SanitizeLimits): Promise<SanitizedZip> {
  const entries = readEntries(bytes);
  const files: { name: Uint8Array; data: Uint8Array }[] = [];
  let xmlBytes = 0;
  let totalBytes = 0;
  const overXml = (): never => {
    throw new ZipRejected(`압축을 풀면 본문 XML이 ${limits.maxXmlBytes / 1024 / 1024}MB를 넘습니다`, true);
  };
  const overTotal = (): never => {
    throw new ZipRejected(`압축을 풀면 전체가 ${limits.maxTotalBytes / 1024 / 1024}MB를 넘습니다`, true);
  };
  for (const e of entries) {
    if (e.flags & 0x1) throw new ZipRejected("암호가 걸린 문서는 읽을 수 없습니다");
    if (e.nameText.endsWith("/")) continue; // 디렉터리 항목
    const budget = limits.maxTotalBytes - totalBytes;
    const raw = compressedData(bytes, e);
    let data: Uint8Array;
    if (e.method === 0) {
      if (raw.length > budget) overTotal();
      data = raw;
    } else if (e.method === 8) {
      data = await inflateCapped(raw, budget, overTotal);
    } else {
      throw new ZipRejected(`지원하지 않는 압축 방식(${e.method})입니다`);
    }
    // 다시 만든 zip에는 새 CRC가 들어가므로, 원본 CRC와 여기서 맞춰 봐야 손상을 놓치지 않는다.
    if (crc32(data) !== e.crc) throw new ZipRejected(`zip 항목의 내용이 손상됐습니다(CRC 불일치): ${e.nameText}`);
    totalBytes += data.length;
    if (isKnownBinary(data)) {
      // 그림 등은 변환 결과에 자리표시로만 나오므로 내용 없이 이름만 남긴다.
      data = new Uint8Array(0);
    } else {
      xmlBytes += data.length;
      if (xmlBytes > limits.maxXmlBytes) overXml();
    }
    files.push({ name: e.name, data });
  }
  return { bytes: buildStoredZip(files), xmlBytes, totalBytes };
}
