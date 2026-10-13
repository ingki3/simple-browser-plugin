// HWP 경로는 PDF를 쓰지 않는다. kordoc가 가져오는 이름만 채운다(PDF 변환은 확장의 pdf.js가 따로 맡는다).
const no = () => { throw new Error("이 번들은 PDF를 지원하지 않습니다."); };
export const OPS = {}, ImageKind = {}, GlobalWorkerOptions = {}, getDocument = no, normalizeUnicode = (s) => s;
export const WorkerMessageHandler = {};
export default {};
