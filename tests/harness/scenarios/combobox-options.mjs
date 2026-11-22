// 누를 때(mousedown) 목록을 여는 조합 상자(react-select 5.x 형태, #316).
// - 열기 표시기("Show options")를 실제 입력으로 누르면 mousedown에서 목록이 열리며 표시기 이름이 바뀌어 떼기에서 막힌다 →
//   "누르기 전달·관측 구간 변화 — 다시 관측"으로 따로 알린다(가드는 그대로 막음).
// - 선택지와 트리거의 관계: aria-controls(5.8+ 그대로), aria-activedescendant 연결, 종류 추정(연결 없음·포털 — 늘 카드),
//   충돌·숨김·근거 변화에서는 빼거나 누르지 않는다.
// react-select 실제 마크업(5.10): input role=combobox aria-haspopup=true aria-autocomplete=list aria-expanded
// aria-activedescendant(Apple 기기는 없음) aria-controls=<id>-listbox(열렸을 때만), MenuList role=listbox id=<id>-listbox,
// Option role=option id=<id>-option-N. menuPortalTarget이면 Menu를 body 쪽에 그린다.
import { expect, lastTool, okResult } from "../lib.mjs";

const SECRET = "비밀값-316";
const NAMES = ["Everyone", "Emails", "Email domain", "IP ranges", "Country", "Login methods", "Service token", "Any service token", "Valid certificate", "Common name"];
const LB = "react-select-3-listbox";
const OPT = (i) => `react-select-3-option-${i}`;

// opts:
//  open: 처음부터 목록을 연다(표시기를 누르지 않는 시나리오). controls: "list"(있는 목록 id) | "dangling"(없는 id) | "" | 그 밖 id 목록.
//  active: activedescendant로 가리킬 항목 번호(null이면 없음). portal: body 쪽 #portal에 그림. listRole·listId: 목록 div의 role·id.
//  label: 입력 칸 이름 속성(문자열). menu: 공통 메뉴 버튼(펼침·aria-controls 연결)을 둔다. menuRole: 목록을 role=menu·menuitem으로.
//  wrapCtl: 컨트롤을 감싸는 요소의 여는·닫는 태그. around: 메뉴 목록을 감싸는 여는·닫는 태그(포털 안). extra: main 끝에 넣는 HTML.
//  script: 끝에 덧붙이는 스크립트.
function page(o = {}) {
  const {
    open = true,
    controls = "list",
    active = null,
    portal = true,
    listRole = true,
    listId = true,
    label = 'aria-label="Include"',
    menu = true,
    menuRole = false,
    wrapCtl = ["", ""],
    around = ["", ""],
    extra = "",
    script = "",
    // formMode: "" 기본(컨트롤이 양식 f 안) | "outside"(트리거·목록은 대화상자 안, 트리거가 form=f로 대화상자 밖 양식 f(메일 값 있음)에 연결)
    //   | "outsideNoAttr"(같은 배치, form 속성 없음 — 대조) | "payment"(컨트롤이 결제 문구가 있는 양식 pay 안, 트리거는 form=b로 빈 양식 b에 연결).
    formMode = "",
  } = o;
  const formOpen = {
    "": `<form id=f action="/a">`,
    outside: `<form id=f action="/a"><input type=email name=email aria-label=메일 value="me@example.com"></form><div role=dialog>`,
    outsideNoAttr: `<form id=f action="/a"><input type=email name=email aria-label=메일 value="me@example.com"></form><div role=dialog>`,
    payment: `<form id=b action="/b"></form><form id=pay action="/x"><p>결제 금액 10,000원</p>`,
    deleteOuter: `<form id=b action="/b"></form><form id=dl action="/x"><input type=hidden name=_method value=DELETE>`,
    deleteAction: `<form id=b action="/b"></form><form id=dl action="/items/delete">`,
  }[formMode];
  const formClose = { "": "</form>", outside: "</div>", outsideNoAttr: "</div>", payment: "</form>", deleteOuter: "</form>", deleteAction: "</form>" }[formMode];
  const formAttr = formMode === "outside" ? "form=f" : ["payment", "deleteOuter", "deleteAction"].includes(formMode) ? "form=b" : "";
  const choiceRole = menuRole ? "menuitem" : "option";
  const popupRole = menuRole ? "menu" : "listbox";
  return `<title>규칙</title><main>
${formOpen}
${wrapCtl[0]}<div id=ctl style="display:flex;width:320px;border:1px solid #999">
<input id=inp role=combobox aria-expanded=false aria-haspopup=true aria-autocomplete=list ${label} ${formAttr} style="flex:1;height:30px">
<div id=ind role=button aria-label="Show options" style="width:40px;height:32px;background:#ddd"><svg width=20 height=20><path d="M0 0L10 10" stroke=black /></svg></div>
</div>
<div id=inl></div>${wrapCtl[1]}
${formClose}
${menu ? `<button id=mb aria-haspopup=menu aria-expanded=true aria-controls=m>도구</button><ul role=menu id=m><li role=menuitem>도구 항목</li></ul>` : ""}
${extra}
<p id=out></p></main>
<div id=portal style="position:absolute;left:400px;top:10px;width:260px;background:#fff">${around[0]}<div id=menuhost></div>${around[1]}</div>
<div id=portal2 style="position:absolute;left:700px;top:10px;width:200px"></div>
<script>
window.__picks = 0;
const inp = document.getElementById("inp");
inp.value = ${JSON.stringify(SECRET)};
function open() {
  const host = ${portal} ? document.getElementById("menuhost") : document.getElementById("inl");
  const items = ${JSON.stringify(NAMES)}.map((n, i) => '<div role=${choiceRole} id="${OPT("")}' + i + '" tabindex=-1 style="padding:4px">' + n + '</div>').join("");
  host.innerHTML = '<div class=menu><div ${listRole ? `role=${popupRole}` : ""} ${listId ? `id=${LB}` : ""}>' + items + '</div></div>';
  inp.setAttribute("aria-expanded", "true");
  const c = ${JSON.stringify(controls)};
  if (c === "list") inp.setAttribute("aria-controls", "${LB}");
  else if (c === "dangling") inp.setAttribute("aria-controls", "react-select-9-listbox");
  else if (c) inp.setAttribute("aria-controls", c);
  ${active === null ? "" : `inp.setAttribute("aria-activedescendant", "${OPT("")}${active}");`}
  document.getElementById("ind").removeAttribute("aria-label");
  for (const el of host.querySelectorAll("[role=${choiceRole}], .menu [id^=react-select-3-option]")) el.addEventListener("click", () => {
    window.__picks++;
    document.getElementById("out").textContent = el.textContent;
  });
}
window.__open = open;
document.getElementById("ind").addEventListener("mousedown", (e) => { e.preventDefault(); if (inp.getAttribute("aria-expanded") !== "true") open(); });
document.getElementById("ind").addEventListener("click", () => { window.__indClicks = (window.__indClicks || 0) + 1; });
if (${open}) open();
${script}
</script>`;
}

const findC = { tool: "find_clickables", args: {} };
const findItems = { tool: "find_clickables", args: { mode: "items" } };

function found(r) {
  const res = lastTool(r, "find_clickables")?.result;
  return Array.isArray(res) ? res : res?.items ?? [];
}
const options = (r) => found(r).filter((c) => c.role === "option" || c.role === "menuitem");
const optNamed = (r, name) => found(r).find((c) => c.text === name);
const picks = (h) => h.tab.evaluate(() => window.__picks);

// 입력값이 도구 결과·모델 요청·디버그 로그 어디에도 없다(#43).
async function noSecret(h, r, cards = []) {
  const reqs = JSON.stringify(await h.sw.evaluate(() => globalThis.__modelReqs));
  expect(!reqs.includes(SECRET), "입력값이 모델 요청에 없어야 한다");
  expect(!JSON.stringify(r.tools).includes(SECRET), "입력값이 도구 결과에 없어야 한다");
  expect(!r.logs.some((l) => l.includes(SECRET)), "입력값이 디버그 로그에 없어야 한다");
  for (const c of cards) expect(!c.includes(SECRET), `입력값이 카드에 없어야 한다(${c})`);
}

// 카드가 뜨면 before(카드 동안 페이지 바꾸기)를 하고 승인. 카드 글을 모은다.
function approveAfter(h, seen, before) {
  return async (card) => {
    seen.push(await card.innerText());
    if (before) await h.tab.evaluate(before);
    await card.locator(".btn-approve").click();
  };
}

// 고르기 시도 한 번: 찾고 name을 누른다. mode: "auto"·"ask". before: 카드 동안 할 일.
async function pick(h, path, name, { mode = "auto", before } = {}) {
  await h.settings({ runMode: mode });
  const seen = [];
  const r = await h.turn([findC, { click: name }, { text: "끝" }], { path, onCard: approveAfter(h, seen, before) });
  return { r, seen };
}

// 카드가 한 번 떴고(처음엔 클릭 id가 있었음), 카드 동안 바꾼 뒤 승인해도 누르지 않았고 클릭 결과가 실패다.
async function cardThenNoClick(h, path, name, opts) {
  const { r, seen } = await pick(h, path, name, opts);
  expect(seen.length === 1, `카드가 한 번 떠야 한다(cards=${seen.length}, ${JSON.stringify(found(r)).slice(0, 200)})`);
  const c = lastTool(r, "click_element");
  expect(c && (c.error || c.result?.ok === false || c.result?.effect?.dom?.aborted || c.result?.error), `클릭 결과가 실패여야 한다(${JSON.stringify(c).slice(0, 300)})`);
  expect((await picks(h)) === 0, `누르지 않음(out='${r.out}')`);
  return { r, seen };
}

// 뺀 선택지(클릭 id 없음) 확인.
function excluded(r, names, total, { noOptions = false } = {}) {
  const t = lastTool(r, "find_clickables");
  expect(t && !t.error && (Array.isArray(t.result) || Array.isArray(t.result?.items)), `find_clickables가 성공해야 한다(${JSON.stringify(t).slice(0, 300)})`);
  if (noOptions) expect(options(r).filter((o) => o.role === "option").length === 0, `선택지 id가 하나도 없어야 한다(${JSON.stringify(options(r)).slice(0, 300)})`);
  for (const n of names) expect(!optNamed(r, n), `'${n}'은 클릭 대상이 아니어야 한다(${JSON.stringify(found(r)).slice(0, 300)})`);
  if (total !== undefined) {
    const res = lastTool(r, "find_clickables")?.result;
    expect(String(res?.note ?? "").includes(`선택지 ${total}개`), `뺀 선택지 ${total}개 안내(${JSON.stringify(res).slice(0, 300)})`);
  }
}

function unrelatedLine(r) {
  return r.logs.find((l) => l.includes("find_clickables:unrelated")) ?? "";
}

const P = (path, o) => ({ [path]: page(o) });

export default [
  // ---- A. 열기 클릭 보고 ----
  {
    name: "실제 입력으로 'Show options'를 누르면 mousedown에서 목록이 열려 떼기에서 막히고, 누르기 전달·다시 관측으로 알린다",
    pages: P("/a", { open: false, portal: false }),
    async run(h) {
      await h.settings({ runMode: "auto", trustedInput: true });
      const r = await h.turn([findC, { click: "Show options" }, findC, { text: "끝" }], { path: "/a" });
      const c = lastTool(r, "click_element");
      const res = c?.result;
      expect(res && typeof res.error === "string" && res.pressDelivered === true, `누르기 전달 결과(${JSON.stringify(c).slice(0, 500)})`);
      expect(res.error.includes("전달된 입력: pointerdown, mousedown") && res.error.includes("떼기(pointerup)부터는"), `통과 입력·막힌 단계(${res.error})`);
      expect(res.error.includes("find_clickables") && res.error.includes("다시 누르지 마세요"), `다시 관측 안내(${res.error})`);
      expect(res.effect?.dom?.mutations > 0, `관측 변화(${JSON.stringify(res.effect)})`);
      expect((await h.tab.evaluate(() => window.__indClicks ?? 0)) === 0, "표시기 click은 막혀야 한다");
      expect((await h.tab.evaluate(() => document.getElementById("inp").getAttribute("aria-expanded"))) === "true", "목록은 열려 있어야 한다");
      const fail = r.logs.find((l) => l.includes("tool:result") && l.includes(" click_element fail")) ?? "";
      expect(fail.includes("누르기 전달"), `결과 요약 구분(${fail})`);
      const opts = options(r).filter((o) => o.role === "option");
      expect(opts.length === 10 && opts.every((o) => o.listFor === "Include"), `다시 찾은 선택지 10개·listFor(${JSON.stringify(opts).slice(0, 300)})`);
      await noSecret(h, r);
    },
  },

  // ---- B. 관계 ----
  {
    name: "aria-controls 있음(5.8+) + 포털: 연결로 보고 자동 실행으로 카드 없이 고른다",
    pages: P("/b", {}),
    async run(h) {
      const { r, seen } = await pick(h, "/b", "Emails");
      expect(seen.length === 0 && r.out === "Emails", `카드 없이 고름(cards=${seen.length}, out='${r.out}')`);
    },
  },
  {
    name: "activedescendant + 목록 role 있음(id 없음·aria-controls는 없는 id) + 포털: 10개 모두 연결, 카드 없이 고른다",
    pages: P("/c", { controls: "dangling", active: 0, listId: false }),
    async run(h) {
      const { r, seen } = await pick(h, "/c", "Country");
      expect(options(r).filter((o) => o.role === "option").length === 10, `10개(${JSON.stringify(options(r)).slice(0, 200)})`);
      expect(seen.length === 0 && r.out === "Country", `카드 없이 고름(cards=${seen.length}, out='${r.out}')`);
    },
  },
  {
    name: "activedescendant 재계산: 카드 동안 같은 목록의 다른 항목으로 옮기면 누르고, 비우면 누르지 않는다",
    pages: P("/d", { controls: "dangling", active: 0, listId: false }),
    async run(h) {
      const a = await pick(h, "/d", "Country", { mode: "ask", before: () => document.getElementById("inp").setAttribute("aria-activedescendant", "react-select-3-option-5") });
      expect(a.r.out === "Country" && (await picks(h)) === 1, `같은 목록 안 이동은 누름(out='${a.r.out}')`);
      await cardThenNoClick(h, "/d", "Country", { mode: "ask", before: () => document.getElementById("inp").setAttribute("aria-activedescendant", "") });
    },
  },
  {
    name: "연결 전혀 없음(macOS 형태) + 포털: 종류 추정으로 선택지를 보이고 자동 실행에서도 카드로 묻는다",
    pages: P("/e", { controls: "" }),
    async run(h) {
      const { r, seen } = await pick(h, "/e", "Emails");
      const opts = options(r).filter((o) => o.role === "option");
      expect(opts.length === 10 && opts.every((o) => o.listFor === "Include"), `10개·listFor(${JSON.stringify(opts).slice(0, 200)})`);
      expect(seen.length === 1 && seen[0].includes("구조로 추정") && seen[0].includes("'Include'"), `카드(${seen[0]})`);
      expect(r.out === "Emails", `승인하면 고름(out='${r.out}')`);
      await noSecret(h, r, seen);
    },
  },
  {
    name: "근거 변화 6a: 묶음 추정(group) 상태에서 카드 동안 묶음에 대화상자 버튼을 더해 종류 추정(kind)으로 바뀌면 누르지 않는다",
    pages: P("/g", { controls: "", portal: false }),
    async run(h) {
      const { seen } = await cardThenNoClick(h, "/g", "Emails", {
        before: () => document.getElementById("ctl").insertAdjacentHTML("beforeend", "<button type=button aria-haspopup=dialog aria-expanded=true>설정</button>"),
      });
      expect(seen[0].includes("구조로 추정"), `카드(${seen[0]})`);
    },
  },
  {
    name: "근거 변화 6b: 종류 추정 카드 동안 같은 목록을 다른 부모로 옮기면 누르지 않는다",
    pages: P("/g2", { controls: "" }),
    async run(h) {
      await cardThenNoClick(h, "/g2", "Emails", { before: () => document.getElementById("portal2").append(document.querySelector("#menuhost [role=listbox]")) });
    },
  },
  {
    name: "근거 변화 6c: 종류 추정 카드 동안 트리거 양식의 제출 주소가 바뀌면 누르지 않는다",
    pages: P("/g3", { controls: "" }),
    async run(h) {
      await cardThenNoClick(h, "/g3", "Emails", { before: () => document.getElementById("f").setAttribute("action", "/b") });
    },
  },
  {
    name: "근거 변화 6d: 종류 추정 카드 동안 종류가 맞는 펼친 트리거가 하나 더 생기면 누르지 않는다",
    pages: P("/g4", { controls: "" }),
    async run(h) {
      await cardThenNoClick(h, "/g4", "Emails", {
        before: () => document.querySelector("main").insertAdjacentHTML("beforeend", "<button aria-haspopup=listbox aria-expanded=true>필터</button>"),
      });
    },
  },
  {
    name: "근거 변화 6c2: 트리거 입력 칸이 form 속성으로 대화상자 밖 양식에 연결되면 그 양식의 개인정보로 카드를 띄우고(속성 없으면 카드 없음), 카드 동안 제출 주소가 바뀌면 누르지 않는다",
    pages: {
      ...P("/g5", { controls: "dangling", active: 0, listId: false, portal: false, formMode: "outside" }),
      ...P("/g6", { controls: "dangling", active: 0, listId: false, portal: false, formMode: "outsideNoAttr" }),
    },
    async run(h) {
      const { seen } = await cardThenNoClick(h, "/g5", "Emails", { before: () => document.getElementById("f").setAttribute("action", "/b") });
      expect(seen[0].includes("개인정보"), `개인정보 양식이라 자동 실행에서도 카드(${seen[0]})`);
      const c = await pick(h, "/g6", "Emails");
      expect(c.seen.length === 0 && c.r.out === "Emails", `대조: form 속성이 없으면 카드 없이 고름(cards=${c.seen.length}, out='${c.r.out}')`);
    },
  },
  {
    name: "6c3: form 속성으로 다른 양식에 딸린 트리거라도 화면상 감싼 결제 양식의 위험을 보아 aria-controls 연결 선택지도 카드로 묻는다",
    pages: P("/g7", { portal: true, formMode: "payment" }),
    async run(h) {
      const { r, seen } = await pick(h, "/g7", "Emails");
      expect(seen.length === 1 && r.out === "Emails", `결제 양식이라 자동 실행에서도 카드(cards=${seen.length}, ${seen[0]}, out='${r.out}')`);
    },
  },
  {
    name: "6c4: form 속성으로 다른 양식에 딸린 트리거라도 화면상 감싼 양식의 삭제 신호(_method=DELETE)로 aria-controls 연결 선택지를 카드로 묻는다",
    pages: P("/g8", { portal: true, formMode: "deleteOuter" }),
    async run(h) {
      const { r, seen } = await pick(h, "/g8", "Emails");
      expect(seen.length === 1 && r.out === "Emails", `삭제 신호라 자동 실행에서도 카드(cards=${seen.length}, ${seen[0]}, out='${r.out}')`);
    },
  },
  {
    name: "부정 10k: 목록의 묶음에 다른 펼친 버튼과 접힌 보조 메뉴 버튼이 함께 있으면(묶음 추정 불가) 묶음 밖 트리거의 activedescendant로 묶지 않는다",
    pages: {
      "/x6": `<title>묶음</title><main><input id=inp role=combobox aria-expanded=true aria-haspopup=true aria-activedescendant=k0 aria-label=Include>
<form action="/pay"><p>결제 금액</p><div id=grp><button type=button aria-haspopup=listbox aria-expanded=true>B열기</button><button type=button aria-haspopup=menu aria-expanded=false>더보기</button></div></form>
<div id=grp2></div><p id=out></p></main>
<script>document.getElementById("grp").insertAdjacentHTML("beforeend", '<div role=listbox><div role=option id=k0>K0</div><div role=option id=k1>K1</div></div>');</script>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/x6" });
      excluded(r, ["K0", "K1"]);
    },
  },
  {
    name: "부정 10l: 바깥 버튼이 상위 메뉴 자체를 aria-controls로 가리키면 그 안 하위 메뉴 항목을 activedescendant로 바깥 버튼에 묶지 않는다",
    pages: {
      "/x7": `<title>중첩</title><main><button id=ob aria-haspopup=menu aria-expanded=true aria-controls=outer aria-activedescendant=s0>파일</button>
<div role=menu id=outer><div role=menuitem>새로 만들기</div><div role=menu id=sub><div role=menuitem id=s0>S0</div><div role=menuitem id=s1>S1</div></div></div>
<button aria-haspopup=listbox aria-expanded=true>필터</button><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/x7" });
      excluded(r, ["S0", "S1"]);
      expect(optNamed(r, "새로 만들기")?.listFor === "파일", `바깥 메뉴 항목은 바깥 버튼(${JSON.stringify(optNamed(r, "새로 만들기"))})`);
    },
  },
  {
    name: "6c5: form 속성으로 다른 양식에 딸린 트리거라도 화면상 감싼 양식의 삭제 주소(action)로 aria-controls 연결 선택지를 카드로 묻는다",
    pages: P("/g9", { portal: true, formMode: "deleteAction" }),
    async run(h) {
      const { r, seen } = await pick(h, "/g9", "Emails");
      expect(seen.length === 1 && r.out === "Emails", `삭제 주소라 자동 실행에서도 카드(cards=${seen.length}, ${seen[0]}, out='${r.out}')`);
    },
  },
  {
    name: "부정 10m·10n: 목록을 직접 감싼 펼친 콤보박스가 있거나, 트리거가 다른 tree를 가리키면 activedescendant로 묶지 않는다",
    pages: {
      "/x8": `<title>감쌈</title><main><input id=inp role=combobox aria-expanded=true aria-haspopup=true aria-activedescendant=w0 aria-label=Include><p id=out></p></main>
<div role=combobox aria-expanded=true aria-haspopup=listbox aria-label="휴지통으로"><div role=listbox><div role=option id=w0>W0</div><div role=option id=w1>W1</div></div></div>`,
      ...P("/x9", { controls: "tr", active: 0, extra: "<ul role=tree id=tr><li role=treeitem>T1</li></ul>" }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      let r = await h.turn([findC, { text: "끝" }], { path: "/x8" });
      excluded(r, ["W0", "W1"]);
      r = await h.turn([findC, { text: "끝" }], { path: "/x9" });
      excluded(r, NAMES);
    },
  },
  {
    name: "10o: 같은 묶음에 접힌 보조 메뉴 버튼이 있어도 펼친 콤보박스의 activedescendant 연결은 유지한다",
    pages: P("/x10", { controls: "dangling", active: 0, listId: false, portal: false, script: `document.getElementById("ctl").insertAdjacentHTML("beforeend", "<button type=button aria-haspopup=menu aria-expanded=false>더보기</button>");` }),
    async run(h) {
      const { r, seen } = await pick(h, "/x10", "Country");
      expect(options(r).filter((o) => o.role === "option").length === 10 && seen.length === 0 && r.out === "Country", `연결 유지(cards=${seen.length}, out='${r.out}', ${JSON.stringify(options(r)).slice(0, 200)})`);
    },
  },
  {
    name: "부정 9h: visibility:collapse 트리거는 activedescendant 연결에 쓰지 않고, 카드 동안 collapse로 바뀌어도 누르지 않는다",
    pages: {
      ...P("/vc", { controls: "dangling", active: 0, listId: false, script: `inp.style.visibility = "collapse";` }),
      ...P("/vc2", { controls: "dangling", active: 0, listId: false }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/vc" });
      excluded(r, NAMES, undefined, { noOptions: true });
      await cardThenNoClick(h, "/vc2", "Emails", { mode: "ask", before: () => (document.getElementById("inp").style.visibility = "collapse") });
    },
  },
  {
    name: "부정 7·12:종류가 맞는 펼친 트리거가 둘이면 빼고, 두 모드 모두 이유별 수를 로그에 남긴다(모델 결과에는 없음)",
    pages: P("/n2", { controls: "", extra: "<button aria-haspopup=listbox aria-expanded=true>필터</button>" }),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/n2" });
      excluded(r, NAMES, 10);
      const line = unrelatedLine(r);
      expect(line.includes("연결 여럿 10") && line.includes("깊이 한도 0") && line.includes("연결 없음 0"), `진단 줄(${line})`);
      expect(!JSON.stringify(r.tools).includes("unrelatedDiag"), "모델 결과에 진단이 없어야 한다");
      const r2 = await h.turn([findItems, { text: "끝" }], { path: "/n2" });
      const fresh = r2.logs.slice(r.logs.length).find((l) => l.includes("find_clickables:unrelated")) ?? "";
      expect(fresh.includes("연결 여럿 10"), `items 모드 진단 줄(${fresh})`);
      expect(!JSON.stringify(r2.tools).includes("unrelatedDiag"), "items 모드 모델 결과에 진단이 없어야 한다");
    },
  },
  {
    name: "부정 8: 유일한 트리거가 다른 목록을 aria-controls로 가리키면 포털 목록의 항목을 그 트리거에 묶지 않는다",
    pages: P("/n3", { controls: "xl", extra: "<ul role=listbox id=xl><li role=option>X1</li></ul>" }),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/n3" });
      excluded(r, NAMES, 10);
      expect(optNamed(r, "X1")?.listFor === "Include", `X1은 연결(${JSON.stringify(optNamed(r, "X1"))})`);
    },
  },
  {
    name: "부정 9a·9d: 종류 추정 트리거가 opacity:0 조상 안이거나, 목록이 opacity:0 조상 안이면 뺀다",
    pages: {
      ...P("/h1", { controls: "", wrapCtl: ['<div style="opacity:0">', "</div>"] }),
      ...P("/h4", { controls: "", around: ['<div style="opacity:0">', "</div>"] }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      for (const path of ["/h1", "/h4"]) {
        const r = await h.turn([findC, { text: "끝" }], { path });
        excluded(r, NAMES);
      }
    },
  },
  {
    name: "부정 9b·9c: 숨은 펼친 combobox + 보이는 것(모호), aria-hidden 조상 안의 activedescendant 트리거는 쓰지 않는다",
    pages: {
      ...P("/h2", { controls: "", extra: "<div hidden><input role=combobox aria-expanded=true aria-label=숨은칸></div>" }),
      ...P("/h3", { controls: "", active: 0, wrapCtl: ['<div aria-hidden="true">', "</div>"] }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      for (const path of ["/h2", "/h3"]) {
        const r = await h.turn([findC, { text: "끝" }], { path });
        excluded(r, NAMES);
      }
    },
  },
  {
    name: "부정 9e: 닫힌 shadow root의 slot에 배치된 트리거는 표시·위험 경로를 확인할 수 없어 쓰지 않고, 열린 root는 종류 추정으로 쓴다",
    pages: {
      ...P("/s1", { controls: "", wrapCtl: ["<div id=host>", "</div>"], script: `document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<div style="opacity:0"><slot></slot></div>';` }),
      ...P("/s2", { controls: "", wrapCtl: ["<div id=host>", "</div>"], script: `document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<div><slot></slot></div>';` }),
      ...P("/s3", { controls: "", wrapCtl: ["<div id=host>", "</div>"], script: `document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<div role=dialog aria-modal=true><h2>결제</h2><slot></slot></div>';` }),
      ...P("/s4", { controls: "", active: 0, wrapCtl: ["<div id=host>", "</div>"], script: `document.getElementById("host").attachShadow({ mode: "closed" }).innerHTML = '<div><slot></slot></div>';` }),
      ...P("/s5", { controls: "", wrapCtl: ["<div id=host>", "</div>"], script: `document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<div><slot></slot></div>';` }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      for (const path of ["/s1", "/s2", "/s3", "/s4"]) {
        const r = await h.turn([findC, { text: "끝" }], { path });
        excluded(r, NAMES);
      }
      const r = await h.turn([findC, { text: "끝" }], { path: "/s5" });
      expect(optNamed(r, "Emails")?.listFor === "Include", `열린 root는 종류 추정(${JSON.stringify(found(r)).slice(0, 300)})`);
    },
  },
  {
    name: "부정 9f·9g: 같은 출처 iframe 바깥 조상이 숨으면 쓰지 않고, 카드 동안 트리거가 숨겨지면 누르지 않는다",
    pages: {
      "/fr": `<title>바깥</title><main><div style="opacity:0"><iframe src="/fr-in" style="width:900px;height:400px"></iframe></div><p id=out></p></main>`,
      ...P("/fr-in", { controls: "" }),
      ...P("/hg", { controls: "", wrapCtl: ["<div id=wrap>", "</div>"] }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/fr" });
      excluded(r, NAMES, undefined, { noOptions: true });
      await cardThenNoClick(h, "/hg", "Emails", { before: () => (document.getElementById("wrap").style.opacity = "0") });
    },
  },
  {
    name: "부정 9f2: 같은 출처 iframe 자체가 visibility:hidden이면 안쪽 activedescendant 연결을 쓰지 않고, 카드 동안 숨겨도 누르지 않는다",
    pages: {
      "/fv": `<title>바깥</title><main><iframe id=fr src="/fv-in" style="width:900px;height:400px;visibility:hidden"></iframe><p id=out></p></main>`,
      "/fs": `<title>바깥</title><main><iframe id=fr src="/fv-in" style="width:900px;height:400px"></iframe><p id=out></p></main>`,
      ...P("/fv-in", { controls: "dangling", active: 0, listId: false }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/fv" });
      excluded(r, NAMES, undefined, { noOptions: true });
      const { r: r2, seen } = await pick(h, "/fs", "Emails", { mode: "ask", before: () => (document.getElementById("fr").style.visibility = "hidden") });
      expect(seen.length === 1, `카드가 한 번 떠야 한다(cards=${seen.length})`);
      const c = lastTool(r2, "click_element");
      expect(c && (c.error || c.result?.effect?.dom?.aborted || c.result?.error), `클릭 결과가 실패여야 한다(${JSON.stringify(c).slice(0, 300)})`);
      const n = await h.tab.evaluate(() => document.getElementById("fr").contentWindow.__picks);
      expect(n === 0, `누르지 않음(picks=${n})`);
    },
  },
  {
    name: "부정 10c2: 트리거가 shadow host 안에 그린 다른 목록을 가리키면 activedescendant로 묶지 않고, 카드 동안 그렇게 바뀌어도 누르지 않는다",
    pages: {
      ...P("/w1", { controls: "xh", active: 0, extra: "<div id=xh></div>", script: `document.getElementById("xh").attachShadow({ mode: "open" }).innerHTML = '<ul role=listbox><li role=option>X1</li></ul>';` }),
      ...P("/w2", { controls: "", active: 0, extra: "<div id=xh></div>", script: `document.getElementById("xh").attachShadow({ mode: "open" }).innerHTML = '<ul role=listbox><li role=option>X1</li></ul>';` }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/w1" });
      excluded(r, NAMES);
      await cardThenNoClick(h, "/w2", "Emails", { mode: "ask", before: () => document.getElementById("inp").setAttribute("aria-controls", "xh") });
    },
  },
  {
    name: "부정 10a·10b·10c:다른 트리거가 목록을 감싼 요소·목록을 가리키거나, 트리거 자신이 다른 목록을 가리키면 activedescendant로 묶지 않는다",
    pages: {
      ...P("/x1", { controls: "", active: 0, extra: "<button aria-haspopup=menu aria-expanded=true aria-controls=portal>보기</button>" }),
      ...P("/x2", { controls: "", active: 0, extra: `<button aria-haspopup=listbox aria-expanded=true aria-controls=${LB}>보기</button>` }),
      ...P("/x3", { controls: "xl", active: 0, extra: "<ul role=listbox id=xl><li role=option>X1</li></ul>" }),
      ...P("/x4", { controls: "portal xl", active: 0, extra: "<ul role=listbox id=xl><li role=option>X1</li></ul>" }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      for (const path of ["/x1", "/x2", "/x3", "/x4"]) {
        const r = await h.turn([findC, { text: "끝" }], { path });
        excluded(r, NAMES);
      }
    },
  },
  {
    name: "부정 10d: 목록이 다른 펼친 버튼과 같은 묶음 안이면 묶음 밖 트리거의 activedescendant로 묶지 않는다",
    pages: {
      "/x5": `<title>묶음</title><main><input id=inp role=combobox aria-expanded=true aria-haspopup=true aria-activedescendant=g0 aria-label=Include>
<div id=grp><button aria-haspopup=listbox aria-expanded=true>B열기</button><div role=listbox><div role=option id=g0>G0</div><div role=option id=g1>G1</div></div></div>
<button aria-haspopup=menu aria-expanded=true aria-controls=m>도구</button><ul role=menu id=m><li role=menuitem>도구 항목</li></ul><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/x5" });
      excluded(r, ["G0", "G1"]);
    },
  },
  {
    name: "부정 10e·10f: 카드 동안 충돌이 생기면 누르지 않고, 다른 트리거가 활성 항목 자체를 aria-owns로 가리키면 그 목록 항목을 묶지 않는다",
    pages: {
      ...P("/y1", { controls: "", active: 0, extra: "<button id=bb aria-haspopup=menu aria-expanded=true>보기</button>" }),
      ...P("/y2", { controls: "", active: 0, extra: `<button aria-haspopup=menu aria-expanded=true aria-owns=${OPT(0)}>보기</button>` }),
    },
    async run(h) {
      // 10e: activedescendant 연결 항목의 카드(확인 모드) 동안 다른 트리거가 목록을 감싼 요소를 가리키게 함.
      await cardThenNoClick(h, "/y1", "Emails", { mode: "ask", before: () => document.getElementById("bb").setAttribute("aria-controls", "portal") });
      // 10f 대기 중: 둘째 항목 카드 동안 다른 트리거가 첫 항목을 aria-owns로 가리킴.
      await cardThenNoClick(h, "/y1", "Emails", { mode: "ask", before: () => document.getElementById("bb").setAttribute("aria-owns", "react-select-3-option-0") });
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/y2" });
      excluded(r, ["Everyone", "Emails"]);
    },
  },
  {
    name: "10g·10h·10i: 열린 slot 래퍼·같은 종류 버튼이 연 패널 안의 콤보박스는 묶지 않고, 대화상자 버튼이면 묶으며, 자기 aria-owns와 일치하면 묶는다",
    pages: {
      // 10g: 열린 shadow root 안의 펼친 버튼 B가 slot을 감싼 패널을 가리키고, 그 slot에 목록(light DOM)이 배치됨.
      "/z1": `<title>slot</title><main><input id=inp role=combobox aria-expanded=true aria-haspopup=true aria-activedescendant=q0 aria-label=Include>
<div id=host><div role=listbox><div role=option id=q0>Q0</div><div role=option id=q1>Q1</div></div></div>
<button aria-haspopup=menu aria-expanded=true aria-controls=m>도구</button><ul role=menu id=m><li role=menuitem>도구 항목</li></ul><p id=out></p></main>
<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<button aria-haspopup=menu aria-expanded=true aria-controls=pnl>패널</button><div id=pnl><slot></slot></div>';</script>`,
      // 10h: listbox 종류 버튼 B가 연 패널 안에 콤보박스 A와 목록이 함께 있음 → 뺌. 대조(dialog 버튼) → A로 연결.
      "/z2": panelPage("listbox"),
      "/z3": panelPage("dialog"),
      // 10i: A의 aria-owns와 activedescendant가 같은 목록의 첫 항목.
      ...P("/z4", { controls: OPT(0), active: 0 }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      let r = await h.turn([findC, { text: "끝" }], { path: "/z1" });
      excluded(r, ["Q0", "Q1"]);
      r = await h.turn([findC, { text: "끝" }], { path: "/z2" });
      excluded(r, ["P0", "P1"]);
      r = await h.turn([findC, { text: "끝" }], { path: "/z3" });
      expect(optNamed(r, "P1")?.listFor === "Include", `대화상자 버튼이면 연결(${JSON.stringify(found(r)).slice(0, 300)})`);
      const seen = [];
      r = await h.turn([findC, { click: "P1" }, { text: "끝" }], { path: "/z3", onCard: approveAfter(h, seen) });
      expect(seen.length === 0 && r.out === "P1", `카드 없이 고름(cards=${seen.length}, out='${r.out}')`);
      r = await h.turn([findC, { text: "끝" }], { path: "/z4" });
      expect(optNamed(r, "Everyone") && optNamed(r, "Emails"), `첫째·둘째 모두(${JSON.stringify(found(r)).slice(0, 300)})`);
    },
  },
  {
    name: "부정 10j: 트리거가 하위 메뉴를 aria-controls로 가리키면 바깥 메뉴 항목을 activedescendant로 묶지 않는다(카드 동안 바뀌어도 누르지 않음)",
    pages: { "/j1": submenuPage(true), "/j2": submenuPage(false) },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/j1" });
      excluded(r, ["Y1"]);
      await cardThenNoClick(h, "/j2", "Y1", { mode: "ask", before: () => document.getElementById("mt").setAttribute("aria-controls", "xm") });
    },
  },
  {
    name: "11: 메뉴 버튼의 menuitem은 그 버튼에 연결하고, 연결 없는 포털 메뉴는 aria-haspopup=true 콤보박스가 있으면(모호) 뺀다",
    pages: {
      ...P("/m1", { controls: "" }),
      ...P("/m2", { controls: "", menu: false, menuRole: true, extra: "<button aria-haspopup=menu aria-expanded=true>더보기</button>" }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      let r = await h.turn([findC, { text: "끝" }], { path: "/m1" });
      expect(optNamed(r, "도구 항목")?.listFor === "도구", `메뉴 항목은 메뉴 버튼(${JSON.stringify(optNamed(r, "도구 항목"))})`);
      r = await h.turn([findC, { text: "끝" }], { path: "/m2" });
      excluded(r, NAMES);
    },
  },
  {
    name: "13: 이름 없는·aria-labelledby만 있는 트리거 입력 칸의 값은 카드·결과·로그에 없다(#43)",
    pages: {
      ...P("/v1", { controls: "", label: 'aria-labelledby="lbl"', extra: "<span id=lbl>Include</span>" }),
      ...P("/v2", { controls: "", label: "" }),
      ...P("/v3", { controls: "dangling", active: 0, listId: false, label: "" }),
    },
    async run(h) {
      for (const [path, mode] of [["/v1", "auto"], ["/v2", "auto"], ["/v3", "ask"]]) {
        const { r, seen } = await pick(h, path, "Emails", { mode });
        expect(seen.length === 1 && r.out === "Emails", `${path} 카드 후 고름(cards=${seen.length}, out='${r.out}')`);
        if (path !== "/v1") expect(seen[0].includes("(이름 없음)"), `${path} 트리거 이름 없음(${seen[0]})`);
        const r2 = await h.turn([findItems, { text: "끝" }], { path });
        await noSecret(h, r, seen);
        await noSecret(h, r2);
      }
    },
  },
  {
    name: "14: 역할 없는 목록은 activedescendant가 가리킨 항목만 — 다른 트리거 있음·없음·같은 묶음 모두",
    pages: {
      ...P("/r1", { controls: "", active: 0, listRole: false, listId: false }),
      ...P("/r2", { controls: "", active: 0, listRole: false, listId: false, menu: false }),
      ...P("/r3", { controls: "", active: 0, listRole: false, listId: false, portal: false }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      for (const path of ["/r1", "/r2", "/r3"]) {
        const r = await h.turn([findC, { text: "끝" }], { path });
        expect(optNamed(r, "Everyone"), `${path} 가리킨 항목은 나옴(${JSON.stringify(found(r)).slice(0, 300)})`);
        excluded(r, NAMES.slice(1));
      }
    },
  },
  {
    name: "15: 다른 펼친 버튼이 aria-owns로 포털 목록의 래퍼를 가리키면 종류 추정하지 않고, 카드 동안 생기면 누르지 않는다",
    pages: { ...P("/o1", { controls: "", script: `document.getElementById("mb").setAttribute("aria-owns", "portal");` }), ...P("/o2", { controls: "" }) },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/o1" });
      excluded(r, NAMES);
      await cardThenNoClick(h, "/o2", "Emails", { before: () => document.getElementById("mb").setAttribute("aria-owns", "portal") });
    },
  },
];

function panelPage(kind) {
  return `<title>패널</title><main><button aria-haspopup=${kind} aria-expanded=true aria-controls=pnl>필터 열기</button>
<div id=pnl><input id=inp role=combobox aria-expanded=true aria-haspopup=true aria-activedescendant=p0 aria-label=Include>
<div role=listbox><div role=option id=p0>P0</div><div role=option id=p1>P1</div></div></div>
<button aria-haspopup=menu aria-expanded=true aria-controls=m>도구</button><ul role=menu id=m><li role=menuitem>도구 항목</li></ul><p id=out></p></main>
<script>window.__picks=0;for(const o of document.querySelectorAll("[role=option]"))o.addEventListener("click",()=>{window.__picks++;document.getElementById("out").textContent=o.textContent;});</script>`;
}

function submenuPage(controlsSub) {
  return `<title>메뉴</title><main><button id=mt aria-haspopup=menu aria-expanded=true aria-activedescendant=y0 ${controlsSub ? "aria-controls=xm" : ""}>메뉴</button>
<button aria-haspopup=listbox aria-expanded=true>필터</button><p id=out></p></main>
<div id=portal><div role=menu><div role=menuitem id=y0>Y0</div><div role=menuitem id=y1>Y1</div>
<div role=menu id=xm><div role=menuitem id=x0>X0</div></div></div></div>
<script>window.__picks=0;for(const o of document.querySelectorAll("[role=menuitem]"))o.addEventListener("click",()=>{window.__picks++;document.getElementById("out").textContent=o.textContent;});</script>`;
}
