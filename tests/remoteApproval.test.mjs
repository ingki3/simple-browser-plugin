// 원격 승인 질문(#185): 모델에 보낸 글·고정 문구로만 만들고, 만들 수 없으면 null(묻지 않고 거절).
import test from "node:test";
import assert from "node:assert/strict";

import { REMOTE_QUESTION_MAX, REMOTE_TASK_REQUEST_MAX, REMOTE_URL_MAX, remoteActionLines, remoteHopQuestion, remoteRefusal, remoteTaskQuestion, remoteToolQuestion } from "../src/lib/remoteApproval.ts";
import { sameBase } from "../src/lib/actionTarget.ts";
import { askCallbackData, newAskId, parseAskCallback } from "../src/lib/telegram.ts";

const base = { guarded: false, block: null, chatGrantReason: null };
const target = (over = {}) => ({
  tag: "button",
  role: "",
  name: "원문 이름 비밀값",
  modelName: "구매하기",
  href: "",
  region: "main",
  inFrame: false,
  fieldType: "",
  sensitive: null,
  context: "원문 행 글자 사용자가 입력한 메모",
  modelContext: "상품 A · 구매하기",
  ...over,
});

test("이동: 전체 주소·출처·승인 효과를 보이고 너무 긴 주소는 묻지 않는다", () => {
  const q = remoteToolQuestion({ ...base, toolName: "navigate_to_url", url: "https://news.naver.com/section/101?x=1" });
  assert.ok(q);
  assert.match(q.text, /주소: https:\/\/news\.naver\.com\/section\/101\?x=1/);
  assert.match(q.text, /사이트: https:\/\/news\.naver\.com/);
  assert.match(q.text, /결제·삭제·개인정보 등은 계속 묻습니다/);
  const long = `https://a.example/?q=${"x".repeat(REMOTE_URL_MAX)}`;
  assert.equal(remoteToolQuestion({ ...base, toolName: "navigate_to_url", url: long }), null);
  assert.equal(remoteToolQuestion({ ...base, toolName: "navigate_to_url", url: "javascript:alert(1)" }), null);
});

test("클릭: 원문 name·context를 넣지 않고 모델용 글만 쓴다", () => {
  const q = remoteToolQuestion({ ...base, toolName: "click_element", target: target(), linkHrefs: [], pageUrl: "https://shop.example/cart" });
  assert.ok(q);
  assert.match(q.text, /페이지: https:\/\/shop\.example/);
  assert.match(q.text, /'구매하기'/);
  assert.match(q.text, /상품 A · 구매하기/);
  assert.doesNotMatch(q.text, /원문|비밀값|메모/);
});

test("클릭: 잘린 대상·이름 없음·출처 없음·다른 목적지가 섞이면 묻지 않는다", () => {
  const ok = { ...base, toolName: "click_element", linkHrefs: [], pageUrl: "https://shop.example/" };
  assert.equal(remoteToolQuestion({ ...ok, target: target({ modelNameClipped: true }) }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target({ modelContextClipped: true }) }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target({ modelName: "" }) }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: undefined }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target(), pageUrl: "chrome://newtab/" }), null);
  assert.equal(remoteToolQuestion({ ...ok, target: target({ href: "https://shop.example/a" }), linkHrefs: ["https://shop.example/a", "https://evil.example/?q=1"] }), null);
  assert.ok(remoteToolQuestion({ ...ok, target: target({ href: "https://shop.example/a" }), linkHrefs: ["https://shop.example/a"] }));
});

test("클릭: 체크 상태·대리 라벨·묻는 이유를 보인다(외부 본문 보호는 block 없이도)", () => {
  const q = remoteToolQuestion({
    ...base,
    guarded: true,
    toolName: "click_element",
    target: target({ states: { checked: "false" }, proxy: true }),
    linkHrefs: [],
    pageUrl: "https://shop.example/",
  });
  assert.ok(q);
  assert.match(q.text, /체크 안 됨 \(누르면 바뀝니다\)/);
  assert.match(q.text, /대신 보여 주는 라벨/);
  assert.match(q.text, /외부 문서 내용을 읽은 대화라 자동 실행하지 않음/);
  const b = remoteToolQuestion({ ...base, block: "결제 신호", toolName: "click_element", target: target(), linkHrefs: [], pageUrl: "https://shop.example/" });
  // 사유 글에는 원문 이름이 섞일 수 있어 그대로 보내지 않는다(#192).
  assert.match(b.text, /자동 실행 예외가 있어 묻습니다/);
  assert.ok(!b.text.includes("결제 신호"));
});

test("작업 맡기기: 요청·할 일·위험·효과를 보이고, 요청만 500자에서 자르며 넘치면 묻지 않는다", () => {
  const q = remoteTaskQuestion({ request: " SRT 수서→부산 예매해줘 ", plan: "SRT에서 11월 3일 표를 조회하고 예매", risks: ["결제", " "] });
  assert.ok(q);
  const lines = q.text.split("\n");
  assert.equal(lines[0], "승인이 필요합니다: 작업 맡기기");
  assert.equal(lines[1], "요청: SRT 수서→부산 예매해줘");
  assert.equal(lines[2], "할 일: SRT에서 11월 3일 표를 조회하고 예매");
  assert.deepEqual(lines.slice(3, 5), ["이 작업의 위험:", "- 결제"]);
  assert.match(q.text, /이 요청이 끝날 때까지 .*묻지 않고 실행합니다\(결제·삭제·다른 사이트로 이동도 묻지 않습니다\)/);
  assert.match(remoteTaskQuestion({ request: "a", plan: "b", risks: [] }).text, /이 작업의 위험: 모델이 따로 적지 않음/);
  const long = remoteTaskQuestion({ request: "가".repeat(REMOTE_TASK_REQUEST_MAX + 50), plan: "b", risks: [] });
  assert.ok(long.text.includes(`요청: ${"가".repeat(REMOTE_TASK_REQUEST_MAX)}…\n`));
  // 할 일·위험은 자르지 않는다.
  assert.equal(remoteTaskQuestion({ request: "a", plan: "x".repeat(REMOTE_QUESTION_MAX), risks: [] }), null);
});

test("작업 맡기기: 맡기지 않고 부른 첫 동작은 원격 질문 줄로만(원문 대상 글자 없음), 만들 수 없으면 null", () => {
  const input = { ...base, toolName: "click_element", target: target(), linkHrefs: [], pageUrl: "https://shop.example/" };
  const first = remoteActionLines(input);
  assert.equal(first.title, "클릭");
  const q = remoteTaskQuestion({ request: "구매해 줘", plan: "", risks: [], firstAction: first });
  assert.match(q.text, /첫 동작: 클릭\n페이지: https:\/\/shop\.example\n대상: .*'구매하기'/);
  assert.doesNotMatch(q.text, /할 일:|원문|비밀값|메모/);
  assert.equal(remoteActionLines({ ...input, target: target({ modelNameClipped: true }) }), null);
  assert.equal(remoteActionLines({ ...base, toolName: "fill_form_fields" }), null);
  const nav = remoteActionLines({ ...base, toolName: "navigate_to_url", url: "https://etk.srail.kr/main.do" });
  assert.deepEqual(nav.lines, ["주소: https://etk.srail.kr/main.do", "사이트: https://etk.srail.kr"]);
});

test("그 밖의 도구는 원격으로 묻지 않는다", () => {
  for (const toolName of ["fill_form_fields", "select_option", "sign_in", "read_linked_pages", "download_images"]) {
    assert.equal(remoteToolQuestion({ ...base, toolName, target: target(), pageUrl: "https://a.example/" }), null);
  }
});

test("한도 질문은 수치와 도구별 횟수만", () => {
  const q = remoteHopQuestion({ used: 12, extra: 12, total: 12, failed: 1, cancelled: 0, byTool: [{ tool: "click_element", count: 7 }] });
  assert.match(q.text, /12번 더 진행할까요/);
  assert.match(q.text, /click_element 7회/);
});

test("결과별 기록 문구", () => {
  assert.equal(remoteRefusal("denied").error, "remote_user_denied");
  assert.equal(remoteRefusal("cancelled").error, "remote_approval_cancelled");
  assert.equal(remoteRefusal("expired").error, "remote_approval_expired");
  assert.equal(remoteRefusal("unavailable").error, "remote_needs_approval");
});

test("잘림 플래그가 바뀌면 다른 대상으로 본다(표시 글자가 같아도)", () => {
  const a = target();
  assert.equal(sameBase(a, { ...a }), true);
  assert.equal(sameBase(a, { ...a, modelContextClipped: true }), false);
  assert.equal(sameBase(a, { ...a, modelNameClipped: true }), false);
});

test("텔레그램 버튼 데이터: 만들기·풀기, 모양이 틀리면 null", () => {
  const id = newAskId(new Uint8Array(16).fill(255));
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(parseAskCallback(askCallbackData(id, true)), { askId: id, approve: true });
  assert.deepEqual(parseAskCallback(askCallbackData(id, false)), { askId: id, approve: false });
  assert.ok(askCallbackData(id, true).length <= 64);
  assert.equal(parseAskCallback(`a:${id}:yes`), null);
  assert.equal(parseAskCallback("a:short:y"), null);
  assert.equal(parseAskCallback(`x:${id}:y`), null);
});

import { sanitizeFilenameSegment } from "../src/lib/sanitize.ts";

test("sanitizeFilenameSegment(#192): 반복해도 같은 값(미리보기 폴더 = 실행 폴더)", () => {
  for (const raw of [" .reports", "보고서/원본", "..a..b", "  ", "x".repeat(100) + " ", ".", "a: b?"]) {
    const once = sanitizeFilenameSegment(raw);
    assert.equal(sanitizeFilenameSegment(once), once, JSON.stringify(raw));
  }
  assert.equal(sanitizeFilenameSegment(" .reports"), "reports");
});

// ---- #192: 입력·파일 읽기·캡처·선택 카드, 고정 사유, 앞 줄 ----
import { REMOTE_ASKS_PER_JOB, withPrefix } from "../src/lib/remoteApproval.ts";

const field = (over = {}) => target({ tag: "input", role: "textbox", fieldType: "text", modelName: "이름", name: "원문 라벨 SECRET_LABEL", context: "원문 행 PAGE_TYPED", modelContext: "행 글자", ...over });

test("입력(#192): 페이지 출처·칸 이름(모델용)·넣을 값, 원문 이름·지금 값 없음, 비밀번호는 글자 수만", () => {
  const q = remoteToolQuestion({
    ...base,
    toolName: "fill_form_fields",
    pageUrl: "https://shop.example/order",
    linkHrefs: [],
    fields: [
      { target: field(), value: "홍길동" },
      { target: field({ modelName: "비밀번호", fieldType: "password", sensitive: "password" }), value: "hunter22" },
    ],
  });
  assert.ok(q);
  assert.match(q.text, /승인이 필요합니다: 입력/);
  assert.match(q.text, /페이지: https:\/\/shop\.example/);
  assert.match(q.text, /• '이름' \(text, 본문\): 홍길동/);
  assert.match(q.text, /'비밀번호' \(password, 본문\): ●\(8자\)/);
  for (const bad of ["hunter22", "SECRET_LABEL", "PAGE_TYPED", "원문"]) assert.ok(!q.text.includes(bad), bad);
  // 출처가 다르면 다른 질문(같은 칸·값이어도 어느 사이트에 주는지 보인다).
  const other = remoteToolQuestion({ ...base, toolName: "fill_form_fields", pageUrl: "https://evil.example/x", linkHrefs: [], fields: [{ target: field(), value: "홍길동" }] });
  assert.match(other.text, /페이지: https:\/\/evil\.example/);
});

test("입력(#192): 묻지 않는 경우 — 결제 칸, 이름 없음·잘림, 제출 주소, 행 문맥이 필요한데 없음, 출처 없음, 체크 값이 참·거짓이 아님", () => {
  const q = (fields, extra = {}) => remoteToolQuestion({ ...base, toolName: "fill_form_fields", pageUrl: "https://shop.example/", linkHrefs: [], fields, ...extra });
  assert.equal(q([{ target: field({ sensitive: "payment" }), value: "4111" }]), null);
  assert.equal(q([{ target: field({ modelName: "" }), value: "x" }]), null);
  assert.equal(q([{ target: field({ modelNameClipped: true }), value: "x" }]), null);
  assert.equal(q([{ target: field({ modelContextClipped: true }), value: "x" }]), null);
  assert.equal(q([{ target: field(), value: "x" }], { linkHrefs: ["https://shop.example/submit"] }), null);
  assert.equal(q([{ target: field({ fieldType: "checkbox", modelContext: "" }), value: "true" }]), null);
  assert.equal(q([{ target: field() , value: "x" }], { pageUrl: undefined }), null);
  assert.equal(q([{ target: field({ fieldType: "checkbox" }), value: "maybe" }]), null);
  // 체크박스는 한 칸만 채워도 행 문맥을 보인다(이름이 같은 여러 행 중 어느 것인지).
  const box = q([{ target: field({ fieldType: "checkbox", modelName: "선택", modelContext: "메일 A · 받은 시각" }), value: "true" }]);
  assert.match(box.text, /'선택' — 행: '메일 A · 받은 시각' \(checkbox, 본문\): ☑ 체크/);
  // 이름이 겹치는 두 칸은 행 문맥을 보이고, 없으면 묻지 않는다.
  assert.equal(q([{ target: field({ modelContext: "" }), value: "a" }, { target: field({ modelContext: "" }), value: "b" }]), null);
});

test("사유 줄(#192): 자동 실행 예외·이번 대화 허락 예외의 글(원문 이름이 섞일 수 있음)은 넣지 않고 고정 문구만", () => {
  const q = remoteToolQuestion({ ...base, toolName: "fill_form_fields", pageUrl: "https://shop.example/", linkHrefs: [], fields: [{ target: field(), value: "x" }], block: "개인정보 칸 입력('원문 라벨 SECRET_LABEL')", chatGrantReason: "허락 예외 원문" });
  assert.match(q.text, /자동 실행 예외가 있어 묻습니다/);
  assert.ok(!q.text.includes("SECRET_LABEL") && !q.text.includes("허락 예외 원문"));
});

test("파일 읽기·캡처·선택 카드(#192): 고정 안내와 기본 선택만, 묻지 않는 경우", () => {
  const doc = remoteToolQuestion({ ...base, toolName: "read_document", document: { url: "https://files.example/a.pdf", hasExtension: true } });
  assert.match(doc.text, /파일 읽기/);
  assert.match(doc.text, /로그인 쿠키와 함께 받아 읽고/);
  assert.match(remoteToolQuestion({ ...base, toolName: "read_document", document: { url: "https://files.example/dl?id=1", hasExtension: false } }).text, /확장자가 없는 링크/);
  assert.equal(remoteToolQuestion({ ...base, toolName: "read_document", document: { url: `https://f.example/${"x".repeat(REMOTE_URL_MAX)}`, hasExtension: true } }), null);
  const cap = remoteToolQuestion({ ...base, toolName: "capture_page", capture: { where: "지금 탭", host: "shop.example", fullPage: true, folder: "reports" } });
  assert.match(cap.text, /지금 탭\(shop\.example\)의 페이지 전체를 캡처해 'reports\/'/);
  assert.match(cap.text, /입력한 값·개인정보 포함/);
  const files = remoteToolQuestion({ ...base, toolName: "download_files", choices: { kind: "file", folder: "dl", picks: [{ url: "https://a.example/x.pdf", note: "" }] } });
  assert.match(files.text, /파일 받기/);
  assert.match(files.text, /로그인 쿠키와 함께 받아 'dl\/'/);
  assert.match(files.text, /기본 선택 1개만/);
  const images = remoteToolQuestion({ ...base, toolName: "download_images", choices: { kind: "image", folder: "img", picks: [{ url: "https://a.example/i.png", note: "" }] } });
  assert.match(images.text, /로그인 쿠키와 함께 받아\(리다이렉트를 따를 수 있음\)/);
  const links = remoteToolQuestion({ ...base, toolName: "read_linked_pages", choices: { kind: "link", picks: [{ url: "https://b.example/p", note: "다른 사이트" }] } });
  assert.match(links.text, /로그인 쿠키 없이 받아 본문을 읽고/);
  assert.match(links.text, /https:\/\/b\.example\/p \(다른 사이트\)/);
  assert.equal(remoteToolQuestion({ ...base, toolName: "read_linked_pages", choices: { kind: "link", picks: [] } }), null);
  // 원격 질문을 만들지 않는 도구.
  for (const t of ["read_other_tabs", "sign_in", "open_saved_link", "schedule_repeat_task", "google_sheets_write_range"]) assert.equal(remoteToolQuestion({ ...base, toolName: t }), null, t);
});

test("앞 줄(#192): 채널의 고정 줄을 붙인 최종 글이 상한을 넘으면 묻지 않음", () => {
  const q = { text: "승인이 필요합니다: 이동" };
  assert.equal(withPrefix(q, undefined), q);
  assert.equal(withPrefix(q, ["[MCP 요청]", "요청: 날씨"]).text, "[MCP 요청]\n요청: 날씨\n승인이 필요합니다: 이동");
  assert.equal(withPrefix({ text: "x".repeat(REMOTE_QUESTION_MAX - 5) }, ["[MCP 요청]"]), null);
  assert.equal(REMOTE_ASKS_PER_JOB, 20);
});
