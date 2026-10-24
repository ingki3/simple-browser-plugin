// 자동 실행(승인 없이 진행) 옵션의 예외 판정. 자동 실행을 켜도 결제·개인정보 제출·되돌리기 어려운 동작(삭제·스팸)은
// 승인 카드를 띄운다.
// 여기에는 DOM 없이 계산하는 부분만 둔다. 칸·버튼의 성격(개인정보 칸인지, 개인정보가 든 양식을 제출하는지)은
// content script가 대상 확인 때 TargetInfo에 담아 준다(src/content/forms.ts, src/content/clickables.ts).

import type { TargetInfo } from "./actionTarget.ts";

// 자동 실행 대상: 페이지 이동·클릭·입력.
// 이미지 저장(모델이 고른 주소로 요청)·파일 읽기(쿠키를 실어 요청)·Google 문서 쓰기는 자동 실행을 켜도 늘 묻는다.
export const AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  "navigate_to_url",
  "click_element",
  "fill_form_fields",
]);

// 돈이 나가는 버튼: 결제·구매·주문·송금 등. 영문 order는 단어로 따로 본다(Confirm order, Place your order).
export const PAYMENT_TEXT_RE =
  /(결제|구매|구입|주문|송금|이체|충전|후원|기부|입금|\bpay\b|payment|checkout|check\s*out|\bbuy\b|purchase|\border\b|donate|\btransfer\b|\bwire\b|remit|send\s*money)/i;
// 개인정보를 내보내는 버튼: 가입·신청·제출·인증 등.
const SUBMIT_TEXT_RE =
  /(가입|신청|제출|접수|본인\s*인증|인증\s*(번호|요청|하기)|예약\s*하기|문의\s*(하기|등록)|sign\s*up|register|submit|verify)/i;

// 되돌리기 어려운 동작(#62): 삭제·휴지통·스팸·차단 등. 결제 문구처럼 더 묻는 쪽으로만 쓴다(잘못 걸려도 카드가 한 번 더 뜰 뿐).
// 영문은 낱말 앞을 끊어 본다(undelete·Restore는 아님, deleted·Removes는 걸림).
export const DESTRUCTIVE_TEXT_RE =
  /(삭제|지우기|지워|지움|제거|휴지통|스팸|차단|영구|비우기|버리기|폐기|탈퇴|\bdelete|\bremove|\btrash|\bspam|\bjunk\b|\bdiscard|\berase|\bpurge|\bblock\b|\bbin\b|\bdel\b)/i;
export const DESTRUCTIVE_REASON = "되돌리기 어려운 동작(삭제·스팸)";
// htmx 요청을 확인할 수 없음(#62 — htmx는 허용 목록 방식: 허용 목록 속성만 쓰는 GET 요청만 자동 실행, 그 밖은 늘 묻는다).
export const OPAQUE_REQUEST_REASON = "htmx 요청(GET 아님·확인할 수 없음)";

// 클릭·입력이 되돌리기 어려운 동작인지(#62). 자동 실행·이번 요청 링크 이동 허락·이번 대화 허락 어느 것으로도 건너뛰지 않는다
// (src/background/openrouter.ts가 ToolPreview.alwaysAsk로 받아 늘 카드를 띄운다).
// 구조 선언 밖의 신호는 낱말·경로 단서라 더 묻는 쪽의 최선일 뿐 완전할 수 없다(글자·주소에 단서가 없는 삭제는 놓친다).
// - 구조: 삭제 요청을 선언한 대상(deleteMethod — data-method="delete", hx-delete, 양식의 _method=DELETE).
// - 실릴 값: 누른 제출 버튼·체크·라디오 자신의 name=value, 양식의 숨은 칸, htmx 요청 주소(deleteParam — content script가 본다).
//   사용자가 입력한 칸의 값은 보지 않는다.
// - 글자: 버튼 자신과 실제로 작동하는 바깥 버튼·링크의 글자·aria-label·title·alt(name·outerText)만 본다. 행 문맥
//   (context·modelContext)은 보지 않는다 — 제목에 '삭제'가 든 메일 행의 체크박스·열기 버튼까지 묻지 않게.
// - 주소: 누르면 가는 링크·양식 제출 주소(action·formaction)·ping·선택지 주소의 경로 낱말(/cart/remove/3, delete.php, ?action=trash).
export function destructiveClickBlock(targets: TargetInfo[]): string | null {
  for (const t of targets) {
    if (t.deleteMethod || t.deleteParam) return DESTRUCTIVE_REASON;
    const raw = `${t.name} ${t.outerText ?? ""}`;
    if (DESTRUCTIVE_TEXT_RE.test(`${raw} ${splitIdentifier(raw)}`)) return DESTRUCTIVE_REASON;
    // 양식 제출은 action(submitTo)만 본다. 칸 값까지 합친 주소(submitUrl)는 검색어 '스팸 차단'으로도 걸려 보지 않는다
    // (누른 제출 버튼이 더하는 name=value는 deleteParam이 따로 본다).
    // 링크의 ping 주소(쿠키를 실은 POST)와 선택지가 가리키는 주소도 본다. 범위 안 다른 양식·다른 제출 버튼의 주소
    // (scopeFormActions 등 — 누르지 않은 제출 버튼의 name=value가 붙어 있다)는 보지 않는다: 목록 양식에 '삭제' 제출 버튼이
    // 하나만 있어도 그 화면의 모든 체크·열기가 걸린다. 처리기가 다른 양식을 대신 제출하는 삭제는 놓친다(한계).
    for (const url of [
      t.href,
      t.ancestorHref ?? "",
      t.submitTo ?? "",
      ...(t.pingUrls ?? []),
      ...(t.choiceUrls ?? []),
      // 클릭·입력이 일으킬 htmx GET 요청의 목적지.
      ...(t.requestUrls ?? []),
    ]) {
      if (url && destructiveRoute(url)) return DESTRUCTIVE_REASON;
    }
    // 확인할 수 없는 htmx 요청(GET 아님·from: 리스너·요청 변형 속성 — content script가 구조로 본다). 삭제 단서가 있으면 위의
    // 이유가 먼저다.
    if (t.opaqueRequest) return OPAQUE_REQUEST_REASON;
  }
  return null;
}

// 입력이 되돌리기 어려운 동작인지(#62): 칸에 대한 판정(destructiveClickBlock)에 더해, 고를 선택지의 글자·value를 본다.
// select는 모델이 선택지의 보이는 글자로 고르므로(optionByLabel), 그 글자가 삭제 단서가 있는 선택지(deleteChoices —
// content script가 글자·value로 고른 것)이거나 그 글자 자체에 단서가 있으면 묻는다(change 처리기가 '동작: 삭제'를 바로 실행).
// 글자 칸에 넣을 값(입력값)은 보지 않는다(검색어 '스팸'으로 묻지 않게).
export function destructiveFillBlock(targets: TargetInfo[], values: ReadonlyArray<string | undefined> = []): string | null {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const why = destructiveClickBlock([t]);
    if (why) return why;
    const v = values[i];
    if (t.fieldType !== "select" || v === undefined) continue;
    const want = v.replace(/\s+/g, " ").trim();
    if ((t.deleteChoices ?? []).includes(want)) return DESTRUCTIVE_REASON;
    if (DESTRUCTIVE_TEXT_RE.test(`${want} ${splitIdentifier(want)}`)) return DESTRUCTIVE_REASON;
  }
  return null;
}

// 주소의 경로·쿼리·해시 낱말에 삭제·스팸 단서가 있는지(결제 경로 판정과 같은 방식으로 나눠 본다).
// navigate_to_url도 같은 판정을 쓴다(GET으로 지우는 사이트에서 클릭 대신 주소로 이동해 카드를 건너뛰지 못하게).
export function destructiveRoute(url: string): boolean {
  let u: URL;
  try {
    u = new URL(normalizeUrlText(url));
  } catch {
    // 주소로 풀리지 않으면 글자 그대로 낱말을 본다(모르는 값을 통과시키지 않게).
    const raw = decodeDeepText(url);
    return DESTRUCTIVE_TEXT_RE.test(raw) || DESTRUCTIVE_TEXT_RE.test(splitIdentifier(raw).replace(/[/?#&=+]+/g, " "));
  }
  const route = [u.pathname, u.search, u.hash].map(decodeDeepText).join(" ");
  return DESTRUCTIVE_TEXT_RE.test(route) || DESTRUCTIVE_TEXT_RE.test(splitIdentifier(route).replace(/[/?#&=+]+/g, " "));
}

// 자동 실행하면 안 되는 이유. 없으면 null(자동 실행 가능).
// values: fill_form_fields에서 칸마다 넣을 값(select 선택지 판정용, destructiveFillBlock).
// 사용자가 카드에서 "이 주소는 이번 대화에서 다시 묻지 않기"로 고를 수 있는 주소 신호(개인정보 모양만 걸린 주소).
export const PERSONAL_URL_REASON = "개인정보가 실린 주소";

// deferPersonalUrls: 주어지면 개인정보 모양만 걸린 주소(personalOnlyUrl)는 막지 않고 그 열쇠와 함께 모은 뒤 나머지 검사를 계속한다.
// 결과가 null이면 "모은 주소를 사용자가 허용했을 때의 판정"이다. 값을 합치는 htmx 요청 주소(requestUrls)는 모으지 않는다
// (요소의 지금 값이 요청에 붙을 수 있어 같은 주소 글자가 같은 요청을 뜻하지 않는다).
// 열쇠(personalUrlKey) → 카드에 보일 주소(처음 본 것).
export interface AutoApproveOptions {
  deferPersonalUrls?: Map<string, string>;
}

export function autoApproveBlock(
  tool: string,
  targets: TargetInfo[],
  values: ReadonlyArray<string | undefined> = [],
  opts: AutoApproveOptions = {},
): string | null {
  // 같은 대상의 양식 action들(제출 주소의 허용 열쇠, personalUrlKey). urlBlock을 부르기 전에 대상마다 정한다.
  let actions: string[] = [];
  // mode: "exact"면 주소 글자 그대로 모으고, "submission"(양식이 칸 값을 덧붙여 만든 제출 주소 — submitUrl·scopeSubmitUrls)이면
  // 같은 대상의 action에 묶어 모을 수 있고, "never"면 모으지 않는다.
  const urlBlock = (url: string, mode: "exact" | "submission" | "never"): string | null => {
    if (!url) return null;
    if (mode !== "never" && opts.deferPersonalUrls && personalOnlyUrl(url)) {
      const key = mode === "submission" ? personalUrlKey(url, actions) : url;
      if (!opts.deferPersonalUrls.has(key)) opts.deferPersonalUrls.set(key, key);
      return null;
    }
    return sensitiveUrlReason(url);
  };
  if (!AUTO_APPROVE_TOOLS.has(tool)) return "자동 실행 대상이 아닌 도구";
  if (tool === "fill_form_fields") {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      actions = [t.submitTo ?? "", ...(t.scopeFormActions ?? []), ...(t.aroundFormActions ?? [])];
      // 숨긴 checkbox·radio를 보이는 label로 표시하는 칸(#56)은 늘 묻는다. 사용자가 보는 label과 그 주변의 위험 신호를
      // 그 위험 신호를 칸 쪽에서 빠짐없이 모으기 어렵다(구조 판정 — 더 묻는 쪽).
      if (t.proxy) return "보이지 않는 칸(보이는 라벨로 표시) 입력";
      if (t.sensitive === "password") return "비밀번호 칸 입력";
      if (t.sensitive === "payment") return "결제 정보 칸 입력";
      if (t.personal) return `개인정보 칸 입력('${t.name.slice(0, 30) || t.fieldType}')`;
      // 결제 문구가 붙은 칸이나 결제 화면의 칸(change 처리기가 결제하는 '구매 확정' 체크박스 등).
      const label = `${t.name} ${t.outerText ?? ""}`;
      if (PAYMENT_TEXT_RE.test(`${label} ${splitIdentifier(label)}`)) return "결제 문구가 붙은 칸 입력";
      if (t.paymentContext) return "결제 화면의 칸 입력";
      // 체크·선택의 change 처리기가 삭제를 실행하는 페이지가 있어 칸에도 같은 판정을 쓴다(#62 — 클릭 대신 입력으로 우회 방지).
      const fillDestructive = destructiveFillBlock([t], [values[i]]);
      if (fillDestructive) return fillDestructive;
      // checkbox·radio 채우기는 그 칸을 실제로 누른다(페이지의 click 처리기가 돈다). 그 칸을 click_element로 누를 때
      // 자동 실행하지 않는 경우(감싼 링크의 결제·개인정보 주소, 내려받기 링크, 가입·제출 문구 등)는 채우기로도 자동 실행하지
      // 않는다. 칸의 위험 신호에는 클릭 신호가 합쳐져 있다(content script forms.ts toggleClickRisk).
      if (t.fieldType === "checkbox" || t.fieldType === "radio") {
        const clickWhy = autoApproveBlock("click_element", [t], [], opts);
        if (clickWhy) return `체크·선택은 칸을 누르는 동작이라 클릭과 같이 묻습니다(${clickWhy})`;
      }
      // 입력의 change 처리기가 양식을 바로 제출하는 페이지가 있어, 개인정보가 채워진 양식의 칸도 묻는다.
      if (t.submitsPersonal) return "개인정보가 채워진 양식의 칸 입력";
      // 같은 이유로 결제·개인정보 주소로 제출되는(지금 값까지 합친 제출 주소 포함) 양식의 칸,
      // 결제·개인정보 주소를 가리키는 선택지가 있는 칸도 묻는다.
      for (const url of [t.submitTo ?? "", ...(t.choiceUrls ?? []), ...(t.scopeFormActions ?? []), ...(t.aroundFormActions ?? [])]) {
        const why = urlBlock(url, "exact");
        if (why) return `${why}로 이어지는 칸 입력`;
      }
      for (const url of [t.submitUrl ?? "", ...(t.scopeSubmitUrls ?? [])]) {
        const why = urlBlock(url, "submission");
        if (why) return `${why}로 이어지는 칸 입력`;
      }
      // 값을 바꾸거나 누르면 일으킬 htmx GET 요청의 목적지.
      for (const url of t.requestUrls ?? []) {
        const why = urlBlock(url, "never");
        if (why) return `${why}로 이어지는 칸 입력`;
      }
    }
    return null;
  }
  if (tool === "click_element") {
    for (const t of targets) {
      actions = [t.submitTo ?? "", ...(t.scopeFormActions ?? []), ...(t.aroundFormActions ?? [])];
      // 화면에서 숨긴 checkbox·radio를 대신 보여 주는 label을 누르는 클릭(#56)은 채우기의 대리 label 칸과 같이 늘 묻는다.
      if (t.proxy) return "보이지 않는 칸을 대신 보여 주는 라벨 클릭";
      // 실제로 작동하는 바깥 버튼·링크의 글자도 본다(<button>구매 <span>확인</span></button>의 span).
      // 붙여 쓴 이름(PayNow, BuyNow, pay_now)도 낱말로 나눠 본다.
      const raw = `${t.name} ${t.outerText ?? ""}`;
      const text = `${raw} ${splitIdentifier(raw)}`;
      if (PAYMENT_TEXT_RE.test(text)) return "결제·주문 버튼";
      if (t.paymentContext) return "결제 화면의 버튼";
      // 삭제·휴지통·스팸 같은 되돌리기 어려운 동작(#62). 선택지의 트리거도 같은 목록(targets)으로 들어온다.
      const clickDestructive = destructiveClickBlock([t]);
      if (clickDestructive) return clickDestructive;
      // 중첩 메뉴의 항목은 바로 위 트리거의 위험만 보고 그 위 트리거들은 보지 않는다(구조로 따라가지 않음).
      if (t.nestedPopup) return "중첩 메뉴의 항목";
      // 파일을 내려받는 링크(download 속성)는 이미지 저장처럼 묻는다.
      if (t.download) return "파일 내려받기 링크";
      // 누르면 가는 링크·양식 제출 주소에 결제 경로나 개인정보가 실려 있으면 묻는다.
      for (const href of [
        t.href,
        t.ancestorHref ?? "",
        t.submitTo ?? "",
        ...(t.choiceUrls ?? []),
        ...(t.scopeFormActions ?? []),
        ...(t.aroundFormActions ?? []),
        // 링크의 ping 주소(쿠키를 실은 POST)도 결제·개인정보 주소인지 본다.
        ...(t.pingUrls ?? []),
      ]) {
        const why = urlBlock(href, "exact");
        if (why) return `${why}로 가는 링크`;
      }
      for (const href of [t.submitUrl ?? "", ...(t.scopeSubmitUrls ?? [])]) {
        const why = urlBlock(href, "submission");
        if (why) return `${why}로 가는 링크`;
      }
      // 누르면 일으킬 htmx GET 요청의 목적지(hx-get hx-trigger="click").
      for (const href of t.requestUrls ?? []) {
        const why = urlBlock(href, "never");
        if (why) return `${why}로 가는 링크`;
      }
      if (t.submitsPersonal) return "개인정보가 채워진 양식 제출";
      if (SUBMIT_TEXT_RE.test(text)) return "가입·신청·제출 버튼";
    }
    return null;
  }
  return null;
}

// 주소의 쿼리·해시 값에 실린 다른 주소(리다이렉트 매개변수 ?url=https%3A…, ?next=//host/…).
// 신뢰 사이트의 열린 리다이렉트를 거쳐 밖으로 나가는 것을 막으려고 그 목적지도 경계 안이어야 한다.
function embeddedUrls(u: URL, maxValues = Infinity): string[] {
  const values: string[] = [];
  u.searchParams.forEach((v) => values.push(v));
  if (u.hash.length > 1) {
    const h = u.hash.slice(1);
    values.push(h);
    try {
      new URLSearchParams(h.includes("?") ? h.slice(h.indexOf("?") + 1) : h).forEach((v) => values.push(v));
    } catch {
      /* ignore */
    }
  }
  const out: string[] = [];
  if (values.length > maxValues) return [OVER_BUDGET];
  // 경로에 감싼 목적지(/out/https%3A%2F%2Fhost/…, /proxy/https://host/…). 리다이렉트·프록시 경로로 밖에 보낼 수 있다.
  const path = normalizeUrlText(decodeDeepText(u.pathname));
  if (/%3a|%2f%2f|%5c/i.test(path)) out.push(UNDECODABLE);
  else {
    const at = path.search(/https?:[/\\]/i);
    if (at >= 0) out.push(path.slice(at));
  }
  for (const raw of values) {
    // 잘못된 %ZZ가 섞여도 올바른 %XX는 풀어 본다(decodeDeepText). 다 풀고도 인코딩된 주소 흔적(%3A%2F%2F)이 남으면
    // 목적지를 확인하지 못한 것으로 본다(사이트 경계 판정에서 늘 밖 → 묻기).
    const v = normalizeUrlText(decodeDeepText(normalizeUrlText(raw)));
    if (/%3a|%2f%2f|%5c/i.test(v)) {
      out.push(UNDECODABLE);
      continue;
    }
    // 글 속에 박힌 절대 주소("see https://…").
    const mid = v.search(/https?:[/\\]{2}/i);
    if (mid > 0) out.push(v.slice(mid));
    // 주소로 쓰일 수 있는 값(/·\·?·#·=·:·% 포함)은 이 주소 기준으로 브라우저처럼 풀어 본다
    // (//host, /\host, ?next=//host, 스킴 있는 주소). 평범한 글자는 같은 사이트 경로로 풀려 통과한다.
    if (/[/\\?#=:%]/.test(v)) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
      // 브라우저가 이동에 쓰는 스킴이 아니면(date:desc 같은 값) 상대 경로로 본다.
      const text = scheme && !NAV_SCHEMES.has(scheme) ? `./${v}` : v;
      try {
        out.push(new URL(text, u).href);
      } catch {
        /* 주소가 아님 */
      }
    }
  }
  return out;
}

const NAV_SCHEMES = new Set(["http", "https", "javascript", "vbscript", "data", "blob", "file", "ftp", "filesystem", "about"]);

// 브라우저는 주소의 탭·줄바꿈을 지우고 앞뒤의 제어 문자·공백을 잘라 낸다(ht\ttps://… → https://…). 같은 규칙으로 정리한다.
function normalizeUrlText(v: string): string {
  return v.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

// 주소와 그 안에 감싼 주소들을 모두 펼친다(깊이 3, 같은 주소는 한 번만, 전체 MAX_EXPANDED개까지).
// 한도를 넘거나 깊이 3에서도 감싼 주소가 남으면 overflow — 끝까지 확인하지 못했으니 묻는다.
const MAX_EXPANDED = 200;
// 펼치면서 살펴볼 매개변수 값의 총량. 넘으면 끝까지 확인하지 못한 것으로 본다(서비스 워커가 오래 멈추지 않게).
const MAX_VALUES_TOTAL = 2000;
const OVER_BUDGET = "about:over-budget";
const UNDECODABLE = "about:undecodable";

export function expandUrls(url: string): { urls: URL[]; overflow: boolean } {
  const urls: URL[] = [];
  const seen = new Set<string>();
  const queue: Array<{ text: string; depth: number }> = [{ text: url, depth: 0 }];
  let overflow = false;
  let budget = 0;
  while (queue.length) {
    const { text, depth } = queue.shift()!;
    let u: URL;
    try {
      u = new URL(normalizeUrlText(text));
    } catch {
      if (depth === 0) return { urls: [], overflow: false };
      continue;
    }
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    if (seen.size > MAX_EXPANDED) return { urls, overflow: true };
    urls.push(u);
    if (!/^https?:$/.test(u.protocol)) continue;
    const inners = embeddedUrls(u, MAX_VALUES_TOTAL - budget);
    if (inners[0] === OVER_BUDGET) return { urls, overflow: true };
    budget += Array.from(u.searchParams).length + 2;
    if (!inners.length) continue;
    if (depth >= 3) {
      overflow = true;
      continue;
    }
    for (const inner of inners) queue.push({ text: inner, depth: depth + 1 });
  }
  return { urls, overflow };
}

// 값을 여러 번 인코딩해 숨긴 경우까지 풀어 본다(alice%2540example.com).
// 잘못된 %ZZ가 섞여 있어도 나머지 올바른 %XX는 하나씩 푼다(한 군데 오류로 전체 해석을 포기하지 않게).
export function decodeDeepText(v: string): string {
  let s = v;
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
    let next: string;
    try {
      next = decodeURIComponent(s);
    } catch {
      next = s.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
        try {
          return decodeURIComponent(seq);
        } catch {
          return seq.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
        }
      });
    }
    if (next === s) break;
    s = next;
  }
  return s;
}

// 칸 이름·주소 매개변수 이름의 단서(입력 칸과 주소가 같은 규칙을 쓴다). 대상 글자는 splitIdentifier로 나눈 뒤 검사한다.
export const SECRET_HINT_RE =
  /(password|passwd|\bpwd\b|passcode|비밀\s*번호|암호|\botp\b|one[\s_-]*time|인증\s*(번호|코드)|보안\s*번호|verification[\s_-]*code|auth[\s_-]*code|\bpin\b|api[\s_-]*key|access[\s_-]*key|secret|\btoken\b|bearer|authorization|credential|private[\s_-]*key|session[\s_-]*(id|key)|\bsid\b)/i;
export const FIELD_PAYMENT_HINT_RE = /(card.?(num|no)|cardnumber|cvc|cvv|카드\s*번호|보안\s*코드)/i;
export const PERSONAL_HINT_RE =
  /(이름|성명|성함|휴대\s*폰|핸드폰|전화|연락처|이메일|메일\s*주소|주소|우편\s*번호|생년월일|생일|주민|외국인\s*등록|여권|계좌|e[\s-]?mail|phone|mobile|\btel\b|address|\bzip\b|postal|birth|ssn|passport|account|full\s*name|first\s*name|last\s*name|user\s*name|nick\s*name|(?<![a-z])name(?![a-z]))/i;

// 주소 자체가 개인정보를 싣거나 결제로 가는지: 경로·쿼리·해시에 결제 단서, 매개변수 이름에 개인정보·비밀 단서,
// 값에 이메일·전화번호·카드 번호 모양. 같은 사이트 안이라도 이런 주소로의 이동·링크 클릭은 묻는다
// (이메일이 든 GET 가입 양식 주소로 바로 이동, 결제를 확정하는 GET 링크).
const PAYMENT_ROUTE_RE = /(checkout|payment|\bpay\b|\border\b|\btransfer\b|remit|결제|구매|주문|송금|이체)/i;
const PERSONAL_PARAM_RE =
  /(e[\s-]?mail|phone|mobile|\btel\b|address|\bzip\b|postal|birth|ssn|passport|account|password|passwd|\bpwd\b|\botp\b|card|cvc|cvv|(?<![a-z])name(?![a-z])|username|이름|성명|전화|휴대|연락처|이메일|주소|생년|주민|계좌|비밀번호|카드|인증)/i;
// 휴대전화(01x)·구분자 있는 일반 전화·카드 번호·주민등록번호 모양. 기사 번호 같은 긴 숫자와 헷갈리지 않게 좁게 잡는다.
const PERSONAL_VALUE_RE =
  /(?<!\d)01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)|(?<!\d)0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}(?!\d)|(?<!\d)\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?!\d)|(?<!\d)\d{6}[-\s][1-4]\d{6}(?!\d)/;
const EMAIL_AROUND_AT_RE = /[^\s@/?#&=]{1,64}@[^\s@/?#&=]{1,253}\.[^\s@/?#&=]{1,63}/;
// 이메일 모양이 있는지. 긴 값에서 정규식이 위치마다 다시 훑어 오래 걸리지 않게 '@' 주변(최대 100곳)만 본다.
// 100곳을 넘기면 끝까지 확인하지 못한 것이니 개인정보가 있는 것으로 본다(묻기).
const EMAIL_RE = {
  test(v: string): boolean {
    let from = 0;
    for (let n = 0; n < 100; n++) {
      const at = v.indexOf("@", from);
      if (at < 0) return false;
      if (EMAIL_AROUND_AT_RE.test(v.slice(Math.max(0, at - 64), at + 320))) return true;
      from = at + 1;
    }
    return v.indexOf("@", from) >= 0;
  },
};

// 구분자 없이 이어 쓴 카드 번호(13~19자리, Luhn 검사 통과).
function hasCardNumber(v: string): boolean {
  for (const m of v.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) {
    let sum = 0;
    const digits = m[0];
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

// 식별자 단서(name·id·매개변수 이름)를 낱말로 나눈다: otp_code → "otp code", userPin → "user Pin".
// \b 경계가 _를 단어 글자로 보는 문제를 피한다.
export function splitIdentifier(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.[\]:]+/g, " ");
}

// 값 자체가 개인정보 모양인지(이메일·휴대전화·구분자 있는 전화·카드·주민번호). 인코딩된 값은 풀어 본다.
// 흔한 API 키·토큰 모양(sk-…, ghp_…, xoxb-…, AKIA…, JWT).
const SECRET_VALUE_RE =
  /(?<![A-Za-z0-9])(sk|pk|rk)[-_][A-Za-z0-9][-_A-Za-z0-9]{12,}|(?<![A-Za-z0-9])(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}|(?<![A-Za-z0-9])xox[abpr]-[A-Za-z0-9-]{10,}|(?<![A-Z0-9])AKIA[A-Z0-9]{16}/;

// JWT(eyJ….eyJ….): 정규식 되짚기로 긴 값에서 느려지지 않게 점으로 나눈 조각을 차례로 본다.
function hasJwt(v: string): boolean {
  if (!v.includes("eyJ")) return false;
  for (const run of v.match(/[A-Za-z0-9_.-]+/g) ?? []) {
    if (!run.includes(".")) continue;
    const parts = run.split(".");
    for (let i = 0; i + 1 < parts.length; i++) {
      const a = parts[i].slice(parts[i].lastIndexOf("eyJ"));
      if (a.startsWith("eyJ") && a.length >= 13 && parts[i + 1].startsWith("eyJ") && parts[i + 1].length >= 13 && i + 2 < parts.length) {
        return true;
      }
    }
  }
  return false;
}

export function looksPersonalValue(raw: string): boolean {
  const test = (v: string) =>
    PERSONAL_VALUE_RE.test(v) || EMAIL_RE.test(v) || hasCardNumber(v) || SECRET_VALUE_RE.test(v) || hasJwt(v);
  const v = decodeDeepText(raw);
  // 한 줄 입력 칸은 브라우저가 줄바꿈을 지워 넣는다(alice@\nexample.com → alice@example.com). 지운 값도 본다.
  return test(v) || test(v.replace(/[\r\n]+/g, ""));
}

// ignorePayment: 결제 단서(경로 낱말)는 보지 않고 개인정보·계정 정보·끝까지 못 본 주소만 본다
// (사용자가 이번 요청 동안 링크 이동을 허락한 경우, grantableLink).
export function sensitiveUrlReason(url: string, opts: { ignorePayment?: boolean } = {}): string | null {
  return urlReasons(url, opts).first;
}

// 펼친 주소 모두에서 개인정보 모양 말고는 걸리는 신호가 없고 개인정보 모양은 걸리는 주소(사용자가 허용할 수 있는 주소).
// 감싼 주소 안의 계정 정보·결제 경로·끝까지 못 본 주소가 하나라도 있으면 false.
export function personalOnlyUrl(url: string): boolean {
  const r = urlReasons(url, {});
  return r.personal && r.other === null;
}

// 매개변수 하나에 개인정보·비밀 단서(이름)나 개인정보 모양(값)이 있는지.
function personalParam(k: string, raw: string): boolean {
  const v = decodeDeepText(raw);
  const name = splitIdentifier(decodeDeepText(k));
  return (
    !!v.trim() &&
    (PERSONAL_PARAM_RE.test(name) ||
      SECRET_HINT_RE.test(name) ||
      PERSONAL_HINT_RE.test(name) ||
      FIELD_PAYMENT_HINT_RE.test(name) ||
      looksPersonalValue(v))
  );
}

// 사용자가 허용하는 단위(personalOnlyUrl인 주소의 열쇠)는 주소 글자 그대로다. 예외는 양식 제출 주소 하나: 같은 대상의
// 양식 action(actions — submitTo·scopeFormActions·aroundFormActions) 주소 뒤에 칸 값(name=value)만 덧붙인 주소
// (formSubmissionUrl)이고 덧붙은 매개변수에 개인정보 신호가 없으면 그 action의 열쇠를 쓴다. 양식이 자기 칸 값으로 만든
// 주소라 값이 바뀌어도 같은 양식으로 본다(신호가 없는 양식의 제출처럼). 링크 주소 등 나머지는 한 글자만 달라도 다시 묻는다.
export function personalUrlKey(url: string, actions: readonly string[] = []): string {
  for (const action of actions) {
    if (action && action !== url && extendsAction(url, action) && personalOnlyUrl(action)) return action;
  }
  return url;
}

// url이 action 주소 뒤에 매개변수만 덧붙인 것인지: 출처·경로·해시가 같고, 쿼리가 action의 매개변수 그대로로 시작한다.
// 덧붙은 매개변수에 개인정보 신호가 있으면 false.
function extendsAction(url: string, action: string): boolean {
  let u: URL;
  let a: URL;
  try {
    u = new URL(url);
    a = new URL(action);
  } catch {
    return false;
  }
  if (u.origin !== a.origin || u.pathname !== a.pathname || u.hash !== a.hash || u.username || u.password) return false;
  const up = [...u.searchParams];
  const ap = [...a.searchParams];
  if (up.length <= ap.length) return false;
  for (let i = 0; i < ap.length; i++) {
    if (up[i][0] !== ap[i][0] || up[i][1] !== ap[i][1]) return false;
  }
  return up.slice(ap.length).every(([k, v]) => !personalParam(k, v));
}

// first: 펼친 순서대로 처음 걸린 이유(sensitiveUrlReason). other: 개인정보 모양이 아닌 이유 중 처음. personal: 개인정보 모양이 걸렸는지.
function urlReasons(
  url: string,
  { ignorePayment = false }: { ignorePayment?: boolean },
): { first: string | null; other: string | null; personal: boolean } {
  let first: string | null = null;
  let personalHit = false;
  // 펼친 주소 중 끝까지 풀지 못한 표시(about:undecodable 등). 사이트 경계 판정이 따로 막으므로 first(sensitiveUrlReason)는
  // 바꾸지 않고, 사용자 허용(personalOnlyUrl)에서만 면제할 수 없는 이유로 쓴다.
  let unverified: string | null = null;
  const other = (why: string) => ({ first: first ?? why, other: why, personal: personalHit });
  // content script가 넣는 "끝까지 보지 못함" 표시(about:too-many-…, about:undecodable).
  if (/^about:(too-many|undecodable|over-budget)/.test(url)) return other("끝까지 확인하지 못한 주소");
  // 리다이렉트 매개변수에 감싼 주소도 같은 기준으로 본다.
  const { urls, overflow } = expandUrls(url);
  if (overflow) return other("끝까지 확인하지 못한 복잡한 주소");
  for (const u of urls) {
    if (u.protocol === "about:" && /^(too-many|undecodable|over-budget)/.test(u.pathname)) {
      unverified ??= "끝까지 확인하지 못한 주소";
      continue;
    }
    // 경로·쿼리·해시를 따로 풀어 본다(한 부분의 잘못된 인코딩이 다른 부분 해석을 막지 않게).
    const route = [u.pathname, u.search, u.hash].map(decodeDeepText).join("");
    // 이어 붙인 표기(pay_now, confirm_order, placeOrder)도 낱말로 나눠 보고, 버튼 문구와 같은 금전 단서
    // (donate, purchase, buy, 충전 등)도 경로 낱말에 적용한다.
    const words = splitIdentifier(route).replace(/[/?#&=+]+/g, " ");
    if (!ignorePayment && (PAYMENT_ROUTE_RE.test(route) || PAYMENT_ROUTE_RE.test(words) || PAYMENT_TEXT_RE.test(words))) {
      return other("결제·주문 주소");
    }
    if (u.username || u.password) return other("계정 정보가 실린 주소");
    // 쿼리와 해시(#a=b, #/path?a=b — 해시 값을 읽는 SPA) 매개변수 모두 본다.
    const params: Array<[string, string]> = [...u.searchParams];
    if (u.hash.length > 1) {
      const h = u.hash.slice(1);
      try {
        params.push(...new URLSearchParams(h.includes("?") ? h.slice(h.indexOf("?") + 1) : h));
      } catch {
        /* ignore */
      }
    }
    const personal = params.some(([k, raw]) => personalParam(k, raw));
    // 경로에서는 이메일·키·토큰과, 구분 기호가 있는 전화·주민·카드 번호와 휴대전화 번호, Luhn이 맞는 카드 번호를 본다
    // (평범한 기사·상품 번호는 대개 이 모양이 아니다).
    if (
      personal ||
      EMAIL_RE.test(route) ||
      SECRET_VALUE_RE.test(route) ||
      hasJwt(route) ||
      PERSONAL_VALUE_RE.test(route) ||
      hasCardNumber(route)
    ) {
      first ??= PERSONAL_URL_REASON;
      personalHit = true;
    }
  }
  return { first, other: unverified, personal: personalHit };
}

// 승인 카드에서 "이번 요청 동안 링크 이동은 묻지 않기"를 고른 뒤 카드 없이 누를 수 있는 링크인지.
// 글자·주소의 뜻(결제 문구 등)은 보지 않고 구조만 본다: 최상위 문서에서 다른 문서의 http(s) 주소로 가는 링크
// 역할의 <a>(role="button" 같은 다른 역할은 아님)이며 버튼·인라인 클릭 처리기 안에 있지 않고, 감싼 다른 링크·양식 제출·값이 바뀐 범위 안 양식·선택지 주소·
// 내려받기·ping(누르면 이동과 별도로 그 주소에 POST를 보낸다)이 없고, 개인정보가 채워진 양식과 무관하며,
// 주소(주변 양식의 제출 주소 포함)에 개인정보·계정 정보가 실려 있지 않다. iframe 안의 링크는 같은 문서인지 견줄 그 문서 주소를 모르므로 대상이 아니다.
// 사이트 경계는 호출하는 쪽(pageActionSiteBlock)이 본다.
// 링크에 붙은 클릭 처리기가 이동 대신 다른 동작을 할 수는 있어, 이 허락은 사용자가 고른 요청 하나에만 쓴다.
export function grantableLink(t: TargetInfo, pageUrl: string | undefined): boolean {
  if (t.tag !== "a" || t.role !== "link" || t.inFrame || !t.href) return false;
  let dest: URL;
  try {
    dest = new URL(t.href);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(dest.protocol)) return false;
  if (t.ancestorHref || t.submitTo || t.submitUrl || t.download || t.submitsPersonal) return false;
  if (t.pingUrls?.length) return false;
  // 버튼·버튼 역할·인라인 클릭 처리기 안의 링크는 바깥 처리기가 이동을 취소하고 다른 동작(결제)을 할 수 있다.
  if (t.insideControl) return false;
  if (t.choiceUrls?.length || t.scopeSubmitUrls?.length) return false;
  // 누르면 htmx 요청도 보내는 링크는 이동만 하는 링크가 아니다.
  if (t.requestUrls?.length) return false;
  // 같은 문서 안 위치만 바꾸는 링크(#…)는 이동하지 않고 페이지 처리기만 부르는 경우가 많다.
  if (pageUrl) {
    try {
      const page = new URL(pageUrl);
      page.hash = "";
      const to = new URL(dest.href);
      to.hash = "";
      if (page.href === to.href) return false;
    } catch {
      return false;
    }
  }
  // 링크 처리기가 주변 양식을 제출할 수도 있어, 그 양식들의 제출 주소에도 개인정보가 실려 있지 않아야 한다.
  return [t.href, ...(t.scopeFormActions ?? []), ...(t.aroundFormActions ?? [])].every(
    (u) => sensitiveUrlReason(u, { ignorePayment: true }) === null,
  );
}
