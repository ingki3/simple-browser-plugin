// zip 중앙 디렉터리를 읽어 압축을 풀지 않고 XML 파트의 원본 크기 합계를 구한다.
// Office 문서(docx/xlsx/pptx)는 zip이고 변환 비용은 XML 크기에 비례하므로,
// 압축률이 높은 거대 문서(zip bomb)를 변환 전에 걸러내는 데 쓴다.
//
// 반환: XML 파트 합계(바이트), ZIP64면 "zip64"(크기를 신뢰할 수 없음), zip이 아니면 null.
export function zipXmlUncompressedBytes(bytes: Uint8Array): number | "zip64" | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  // EOCD는 끝에서 22바이트 + 주석(최대 65535바이트) 안에 있다.
  const minPos = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return "zip64";
  if (cdOffset + cdSize > bytes.byteLength) return null;

  const decoder = new TextDecoder();
  let total = 0;
  let pos = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > bytes.byteLength || view.getUint32(pos, true) !== CEN) return null;
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    if (pos + 46 + nameLen > bytes.byteLength) return null;
    if (size === 0xffffffff) return "zip64";
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (/\.(xml|rels)$/i.test(name)) total += size;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return total;
}
