import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_LIMITS,
  downloadFailReason,
  downloadKey,
  downloadOutcome,
  extFromMime,
  pickDownloadCandidates,
  saveFileName,
  savedLocation,
  urlFileName,
} from "../src/lib/downloadPick.ts";

const PAGE = "https://board.example.go.kr/view.do?id=7";
const img = (url, label = "", listed = true) => ({ url, label, meta: "", listed });
const link = (url, label = "", listed = true) => ({ url, label, meta: "", listed });

test("downloadKey: http(s)만, 파일 링크는 해시를 뺀다", () => {
  assert.equal(downloadKey("file", "https://a.com/f.pdf#page=2"), "https://a.com/f.pdf");
  assert.equal(downloadKey("image", "https://a.com/i.png#x"), "https://a.com/i.png#x");
  assert.equal(downloadKey("file", "javascript:alert(1)"), null);
  assert.equal(downloadKey("file", "data:text/plain,hi"), null);
  assert.equal(downloadKey("file", "not a url"), null);
});

test("urlFileName: 경로·쿼리의 이름, 서버 처리기 확장자는 이름이 아님", () => {
  assert.equal(urlFileName("https://a.com/files/%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf"), "보고서.pdf");
  assert.equal(urlFileName("https://a.com/download.do?fileName=%EC%98%88%EC%82%B0.xlsx&id=1"), "예산.xlsx");
  assert.equal(urlFileName("https://a.com/download.do?fileId=123"), null);
  assert.equal(urlFileName("https://a.com/files/attach"), null);
  assert.equal(urlFileName("https://a.com/view.php?no=3"), null);
});

test("후보 고정: 페이지에 없는 주소는 거부, 모델이 고른 것만 기본 선택, 나머지는 선택 해제로 함께", () => {
  const page = [
    link("https://board.example.go.kr/files/a.pdf", "공고문.pdf"),
    link("https://board.example.go.kr/files/b.xlsx", "예산.xlsx"),
    link("https://board.example.go.kr/list.do", "목록", false),
  ];
  const r = pickDownloadCandidates("file", ["https://board.example.go.kr/files/b.xlsx", "https://evil.example/leak?q=secret"], page, PAGE);
  assert.deepEqual(r.rejected, [{ url: "https://evil.example/leak?q=secret", reason: "지금 페이지에 없는 링크" }]);
  // 페이지 순서 그대로: a.pdf(선택 해제로 함께), b.xlsx(모델이 고름). 목록 링크(listed=false)는 보이지 않는다.
  assert.deepEqual(r.candidates.map((c) => [c.url.split("/").pop(), c.requested, c.defaultOn]), [
    ["a.pdf", false, false],
    ["b.xlsx", true, true],
  ]);
  assert.equal(r.candidates[1].label, "예산.xlsx");
});

test("후보 고정: 모델이 고른 것은 listed가 아니어도(일반 링크) 후보, 해시만 다른 주소는 같은 링크", () => {
  const page = [link("https://board.example.go.kr/down?id=9", "다운", false)];
  const r = pickDownloadCandidates("file", ["https://board.example.go.kr/down?id=9#top"], page, PAGE);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].url, "https://board.example.go.kr/down?id=9");
});

test("경고: 결제·개인정보 주소와 다른 사이트 파일은 기본 해제, 확장자 없는 링크는 경고만", () => {
  const page = [
    link("https://board.example.go.kr/order/checkout/receipt.pdf", "영수증"),
    link("https://cdn.other.com/a.pdf", "외부"),
    link("https://board.example.go.kr/download.do?fileId=1", "첨부"),
    link("https://board.example.go.kr/files/ok.hwp", "정상"),
  ];
  const r = pickDownloadCandidates("file", page.map((p) => p.url), page, PAGE);
  const by = Object.fromEntries(r.candidates.map((c) => [c.label, c]));
  assert.equal(by["영수증"].defaultOn, false);
  assert.match(by["영수증"].sub, /⚠ 결제·주문 주소/);
  assert.equal(by["외부"].defaultOn, false);
  assert.match(by["외부"].sub, /다른 사이트/);
  assert.equal(by["첨부"].defaultOn, true);
  assert.match(by["첨부"].sub, /확장자 없는 다운로드 링크/);
  assert.equal(by["정상"].defaultOn, true);
  assert.doesNotMatch(by["정상"].sub, /⚠|다른 사이트|확장자 없는/);
});

test("이미지: 다른 사이트(CDN)는 표시만 하고 기본 선택 유지, 결제·개인정보 주소는 해제", () => {
  const page = [img("https://cdn.other.com/p1.jpg", "상품1"), img("https://board.example.go.kr/pay/checkout.png", "x")];
  const r = pickDownloadCandidates("image", page.map((p) => p.url), page, PAGE);
  assert.equal(r.candidates[0].defaultOn, true);
  assert.match(r.candidates[0].sub, /다른 사이트/);
  assert.equal(r.candidates[1].defaultOn, false);
});

test("이미지: 지정 범위만 기본 선택(3~5번째), 나머지는 선택 해제로 함께", () => {
  const page = Array.from({ length: 7 }, (_, i) => img(`https://board.example.go.kr/img/${i + 1}.png`, `사진${i + 1}`));
  const r = pickDownloadCandidates("image", page.slice(2, 5).map((p) => p.url), page, PAGE);
  assert.deepEqual(r.candidates.filter((c) => c.defaultOn).map((c) => c.label), ["사진3", "사진4", "사진5"]);
  assert.equal(r.candidates.length, 7);
});

test("함께 보이는 페이지 항목 수에는 한도가 있고, 모델이 고른 것은 한도와 관계없이 들어감", () => {
  const n = DOWNLOAD_LIMITS.file.maxExtra + 10;
  const page = Array.from({ length: n }, (_, i) => link(`https://board.example.go.kr/f/${i}.pdf`));
  const r = pickDownloadCandidates("file", [page[n - 1].url], page, PAGE);
  assert.equal(r.candidates.length, DOWNLOAD_LIMITS.file.maxExtra + 1);
  assert.ok(r.candidates.at(-1).requested);
});

test("계정 정보가 실린 주소·http(s)가 아닌 주소는 거부", () => {
  const page = [link("https://u:p@board.example.go.kr/a.pdf")];
  const r = pickDownloadCandidates("file", ["https://u:p@board.example.go.kr/a.pdf", "ftp://x/a.pdf"], page, PAGE);
  assert.deepEqual(r.rejected.map((x) => x.reason), ["계정 정보가 실린 주소", "http(s) 주소가 아님"]);
  assert.equal(r.candidates.length, 0);
});

test("saveFileName: 서버 이름(Content-Disposition) → 주소 이름 → 형식 기반", () => {
  // 브라우저가 Content-Disposition으로 정한 이름을 먼저.
  assert.equal(saveFileName({ kind: "file", suggested: "2024 예산.xlsx", url: "https://a.com/download.do?fileId=1", mime: "application/octet-stream", index: 0 }), "2024 예산.xlsx");
  // 서버 처리기 이름(download.do)은 이름으로 쓰지 않고 받은 형식으로 확장자를 붙인다.
  assert.equal(saveFileName({ kind: "file", suggested: "download.do", url: "https://a.com/download.do?fileId=1", mime: "application/pdf", index: 0 }), "download.pdf");
  // 이름도 형식도 모르면 순번.
  assert.equal(saveFileName({ kind: "file", suggested: "", url: "https://a.com/", mime: "", index: 2 }), "file-3");
  assert.equal(saveFileName({ kind: "image", suggested: null, url: "https://a.com/", mime: "image/png", index: 0 }), "image-1.png");
  // 주소의 쿼리 이름.
  assert.equal(saveFileName({ kind: "file", suggested: "", url: "https://a.com/get?name=%ED%95%9C%EA%B8%80.hwp", mime: null, index: 0 }), "한글.hwp");
  // 경로 구분자·금지 문자·앞 점은 정리, 긴 이름은 확장자를 지킨다.
  assert.equal(saveFileName({ kind: "file", suggested: "../../.evil:name?.pdf", url: "https://a.com/x", index: 0 }), "evil_name_.pdf");
  const long = saveFileName({ kind: "file", suggested: `${"가".repeat(300)}.pdf`, url: "https://a.com/x", index: 0 });
  assert.ok(long.endsWith(".pdf") && long.length <= 115, long);
});

test("extFromMime", () => {
  assert.equal(extFromMime("application/pdf; charset=binary"), "pdf");
  assert.equal(extFromMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "xlsx");
  assert.equal(extFromMime("application/x-hwp"), "hwp");
  assert.equal(extFromMime("application/octet-stream"), null);
  assert.equal(extFromMime(null), null);
});

test("savedLocation: 사용자 폴더 경로를 빼고 폴더/이름만", () => {
  assert.equal(savedLocation("shop", "/Users/kim/Downloads/shop/a (1).pdf"), "shop/a (1).pdf");
  assert.equal(savedLocation("shop", "C:\\Users\\kim\\Downloads\\shop\\a.pdf"), "shop/a.pdf");
  // 고른 폴더가 아닌 곳에 저장됐으면 이름만(사용자 경로는 보내지 않는다).
  assert.equal(savedLocation("shop", "/Users/kim/Downloads/a.pdf"), "a.pdf");
  assert.equal(savedLocation("shop", ""), "");
});

test("downloadOutcome: 항목별 성공·실패 이유·확인할 점", () => {
  const url = "https://a.com/f.pdf";
  assert.deepEqual(downloadOutcome({ kind: "file", state: "complete", mime: "application/pdf", url, finalUrl: url }), { ok: true });
  assert.deepEqual(downloadOutcome({ kind: "file", state: "interrupted", error: "SERVER_UNAUTHORIZED", url }), { ok: false, reason: "로그인이 필요함(401)" });
  assert.equal(downloadOutcome({ kind: "file", state: "in_progress", url }).ok, false);
  assert.deepEqual(downloadOutcome({ kind: "file", state: "not_started", startError: "x", url }), { ok: false, reason: "x" });
  const html = downloadOutcome({ kind: "file", state: "complete", mime: "text/html; charset=utf-8", url });
  assert.ok(html.ok && /로그인 화면/.test(html.note));
  const redirected = downloadOutcome({ kind: "file", state: "complete", mime: "application/pdf", url, finalUrl: "https://files.other.net/f.pdf" });
  assert.match(redirected.note, /다른 사이트\(files\.other\.net\)로 리다이렉트/);
  // 같은 사이트 안의 리다이렉트는 알리지 않는다.
  assert.equal(downloadOutcome({ kind: "file", state: "complete", mime: "application/pdf", url, finalUrl: "https://cdn.a.com/f.pdf" }).note, undefined);
  assert.match(downloadOutcome({ kind: "image", state: "complete", mime: "application/json", url: "https://a.com/i.png" }).note, /이미지가 아닌 응답/);
  // 허락 경로(data:)는 쿠키 없이 받은 이미지 바이트라 형식 검사를 다시 하지 않는다.
  assert.equal(downloadOutcome({ kind: "image", state: "complete", mime: "image/png", url: "data:image/png;base64,AA" }).ok, true);
});

test("downloadFailReason", () => {
  assert.equal(downloadFailReason("SERVER_FORBIDDEN"), "접근 거부(403)");
  assert.equal(downloadFailReason("WEIRD"), "중단됨(WEIRD)");
  assert.equal(downloadFailReason(undefined), "알 수 없는 이유로 중단됨");
});
