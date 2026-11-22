// 누를 때(mousedown) 목록을 여는 조합 상자(react-select 5.x 형태, #316).
// - 열기 표시기("Show options")를 실제 입력으로 누르면 mousedown에서 목록이 열리며 표시기 이름이 바뀌어 떼기에서 막힌다 →
//   "누르기 전달·관측 구간 변화 — 다시 관측"으로 따로 알린다(가드는 그대로 막음).
// - 선택지와 트리거의 관계는 명시적 ARIA 연결만 넓힌다: aria-controls·aria-owns(기존), aria-activedescendant(#316).
//   연결이 없는 포털 목록은 지금처럼 빼고 그 수를 알린다(구조 추정은 하지 않음 — 별도 이슈).
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
  } = o;
  const choiceRole = menuRole ? "menuitem" : "option";
  const popupRole = menuRole ? "menu" : "listbox";
  return `<title>규칙</title><main>
<form id=f action="/a">
${wrapCtl[0]}<div id=ctl style="display:flex;width:320px;border:1px solid #999">
<input id=inp role=combobox aria-expanded=false aria-haspopup=true aria-autocomplete=list ${label} style="flex:1;height:30px">
<div id=ind role=button aria-label="Show options" style="width:40px;height:32px;background:#ddd"><svg width=20 height=20><path d="M0 0L10 10" stroke=black /></svg></div>
</div>
<div id=inl></div>${wrapCtl[1]}
</form>
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
      expect(res.error.includes("전달된 입력: pointerdown, mousedown") && res.error.includes("떼기(pointerup) 단계에서 막음"), `통과 입력·막힌 단계(${res.error})`);
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

  // ---- B. 명시적 ARIA 연결 ----
  {
    name: "aria-controls 있음(5.8+) + 포털: 연결로 보고 자동 실행으로 카드 없이 고른다",
    pages: P("/b", {}),
    async run(h) {
      const { r, seen } = await pick(h, "/b", "Emails");
      expect(seen.length === 0 && r.out === "Emails", `카드 없이 고름(cards=${seen.length}, out='${r.out}')`);
    },
  },
  {
    name: "activedescendant + 목록 role 있음(id 없음·aria-controls는 없는 id) + 포털: 같은 목록 10개 모두 연결, 카드 없이 고른다",
    pages: P("/c", { controls: "dangling", active: 0, listId: false }),
    async run(h) {
      const { r, seen } = await pick(h, "/c", "Country");
      const opts = options(r).filter((o) => o.role === "option");
      expect(opts.length === 10 && opts.every((o) => o.listFor === "Include"), `10개·listFor(${JSON.stringify(opts).slice(0, 200)})`);
      expect(seen.length === 0 && r.out === "Country", `카드 없이 고름(cards=${seen.length}, out='${r.out}')`);
    },
  },
  {
    name: "activedescendant 재계산: 카드 동안 같은 목록의 다른 항목으로 옮기면 누르고, 비우면 누르지 않는다",
    pages: P("/d", { controls: "dangling", active: 0, listId: false }),
    async run(h) {
      const a = await pick(h, "/d", "Country", { mode: "ask", before: () => document.getElementById("inp").setAttribute("aria-activedescendant", "react-select-3-option-5") });
      expect(a.seen.length === 1 && a.r.out === "Country" && (await picks(h)) === 1, `같은 목록 안 이동은 누름(out='${a.r.out}')`);
      await cardThenNoClick(h, "/d", "Country", { mode: "ask", before: () => document.getElementById("inp").setAttribute("aria-activedescendant", "") });
    },
  },
  {
    name: "근거 재검사: 카드 동안 연결 근거가 aria-controls에서 activedescendant로 바뀌면 누르지 않는다",
    pages: P("/e", { active: 0 }),
    async run(h) {
      await cardThenNoClick(h, "/e", "Emails", { mode: "ask", before: () => document.getElementById("inp").removeAttribute("aria-controls") });
    },
  },
  {
    name: "역할 없는 목록: activedescendant가 가리킨 항목만 연결하고 형제는 뺀다(다른 펼친 트리거가 있을 때)",
    pages: P("/r", { controls: "", active: 0, listRole: false, listId: false }),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/r" });
      expect(optNamed(r, "Everyone")?.listFor === "Include", `가리킨 항목은 연결(${JSON.stringify(found(r)).slice(0, 300)})`);
      excluded(r, NAMES.slice(1));
    },
  },
  {
    name: "메뉴 버튼의 menuitem은 aria-controls로 그 버튼에 연결한다",
    pages: P("/m", {}),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/m" });
      expect(optNamed(r, "도구 항목")?.listFor === "도구", `메뉴 항목은 메뉴 버튼(${JSON.stringify(optNamed(r, "도구 항목"))})`);
    },
  },

  // ---- C. 관계없는 선택지는 계속 뺀다 ----
  {
    name: "부정: 연결 없는 포털 목록은 다른 펼친 트리거가 있으면 빼고, 두 모드 모두 이유별 수를 로그에만 남긴다",
    pages: P("/n1", { controls: "" }),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/n1" });
      excluded(r, NAMES, 10);
      const line = unrelatedLine(r);
      expect(line.includes("펼친 트리거 2") && line.includes("연결 없음 10") && line.includes("연결 여럿 0") && line.includes("깊이 한도 0"), `진단 줄(${line})`);
      expect(!JSON.stringify(r.tools).includes("unrelatedDiag"), "모델 결과에 진단이 없어야 한다");
      const r2 = await h.turn([findItems, { text: "끝" }], { path: "/n1" });
      const fresh = r2.logs.slice(r.logs.length).find((l) => l.includes("find_clickables:unrelated")) ?? "";
      expect(fresh.includes("연결 없음 10"), `items 모드 진단 줄(${fresh})`);
      expect(!JSON.stringify(r2.tools).includes("unrelatedDiag"), "items 모드 모델 결과에 진단이 없어야 한다");
    },
  },
  {
    name: "부정: 다른 트리거도 같은 목록을 aria-controls로 가리키면(연결 둘) 빼고 '연결 여럿'으로 센다",
    pages: P("/n2", { controls: "", active: 0, extra: `<button aria-haspopup=listbox aria-expanded=true aria-controls=${LB}>보기</button>` }),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/n2" });
      excluded(r, NAMES, 10);
      expect(unrelatedLine(r).includes("연결 여럿 10"), `진단 줄(${unrelatedLine(r)})`);
    },
  },
  {
    name: "부정: 트리거가 aria-controls로 다른 목록을 가리키면 남은 activedescendant로 포털 목록을 묶지 않는다",
    pages: P("/n3", { controls: "xl", active: 0, extra: "<ul role=listbox id=xl><li role=option>X1</li></ul>" }),
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/n3" });
      excluded(r, NAMES, 10);
      expect(optNamed(r, "X1")?.listFor === "Include", `X1은 연결(${JSON.stringify(optNamed(r, "X1"))})`);
    },
  },

  {
    name: "부정: 대화상자를 연 버튼의 남은 activedescendant는 무시하고, 대화상자 안 메뉴 버튼(묶음 추정 — 카드)에 그대로 묶는다",
    pages: {
      "/k1": `<title>D</title><main>
<button aria-haspopup=dialog aria-expanded=true aria-controls=d aria-activedescendant=mi>관리</button>
<div id=d role=dialog><button aria-haspopup=menu aria-expanded=true>삭제</button>
<ul role=menu><li role=menuitem id=mi onclick="window.__picks=(window.__picks||0)+1">선택 항목</li></ul></div><p id=out></p></main>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const seen = [];
      const r = await h.turn([findC, { click: "선택 항목" }], {
        path: "/k1",
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-cancel").click();
        },
      });
      expect(optNamed(r, "선택 항목")?.listFor === "삭제", `안쪽 메뉴 버튼에 묶음(${JSON.stringify(optNamed(r, "선택 항목"))})`);
      expect(seen.length === 1 && seen[0].includes("구조로 추정"), `카드(${seen[0]})`);
    },
  },
  {
    name: "부정: 다른 트리거가 목록을 감싼 요소를 aria-controls로 가리키면(기존 래퍼 연결) 남은 activedescendant가 그 연결을 덮지 않는다",
    pages: {
      "/k2": `<title>W</title><main><input id=a role=combobox aria-expanded=true aria-controls=wrap aria-label="결제 수단">
<input id=b role=combobox aria-expanded=true aria-activedescendant=w0 aria-label="다른 칸"><p id=out></p></main>
<div id=wrap><ul role=listbox><li role=option id=w0>W0</li><li role=option id=w1>W1</li></ul></div>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/k2" });
      expect(optNamed(r, "W0")?.listFor === "결제 수단" && optNamed(r, "W1")?.listFor === "결제 수단", `래퍼 연결 유지(${JSON.stringify(options(r))})`);
    },
  },
  {
    name: "부정: form 속성으로 다른 양식에 딸린 트리거의 activedescendant는 쓰지 않는다(연결 없는 포털 목록이라 기존처럼 뺀다)",
    pages: {
      ...P("/k3", { controls: "dangling", active: 0, listId: false, script: `document.body.insertAdjacentHTML("beforeend", "<form id=g></form>"); inp.setAttribute("form", "g");` }),
      ...P("/k4", { controls: "dangling", active: 0, listId: false, script: `inp.setAttribute("form", "f");` }),
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { text: "끝" }], { path: "/k3" });
      excluded(r, NAMES, 10);
      // 대조: 감싼 양식과 같은 양식을 form 속성으로 명시하면 그대로 연결한다.
      const r2 = await h.turn([findC, { text: "끝" }], { path: "/k4" });
      expect(options(r2).filter((o) => o.role === "option").length === 10, `같은 양식이면 연결(${JSON.stringify(options(r2)).slice(0, 200)})`);
    },
  },

  {
    name: "부정: aria-controls 없는 대화상자 버튼의 남은 activedescendant도 무시하고 안쪽 메뉴 버튼(카드)에 묶는다 · 활성 항목 둘이면 '연결 여럿'",
    pages: {
      "/k5": `<title>D</title><main>
<button aria-haspopup=dialog aria-expanded=true aria-activedescendant=mi>관리</button>
<div role=dialog><button aria-haspopup=menu aria-expanded=true>삭제</button>
<ul role=menu><li role=menuitem id=mi>선택 항목</li></ul></div><p id=out></p></main>`,
      "/k6": `<title>둘</title><main><input role=combobox aria-expanded=true aria-activedescendant=j0 aria-label=가><input role=combobox aria-expanded=true aria-activedescendant=j0 aria-label=나><p id=out></p></main>
<div role=listbox><div role=option id=j0>J0</div><div role=option id=j1>J1</div></div>`,
    },
    async run(h) {
      await h.settings({ runMode: "auto" });
      let r = await h.turn([findC, { text: "끝" }], { path: "/k5" });
      expect(optNamed(r, "선택 항목")?.listFor === "삭제", `안쪽 메뉴 버튼에 묶음(${JSON.stringify(optNamed(r, "선택 항목"))})`);
      r = await h.turn([findC, { text: "끝" }], { path: "/k6" });
      excluded(r, ["J0", "J1"]);
      expect(unrelatedLine(r).includes("연결 여럿 2"), `진단 줄(${unrelatedLine(r)})`);
    },
  },

  // ---- D. 입력값 보호 ----
  {
    name: "aria-labelledby만 있거나 이름 없는 트리거 입력 칸의 값은 카드·결과·로그에 없다(#43)",
    pages: {
      ...P("/v1", { label: 'aria-labelledby="lbl"', extra: "<span id=lbl>Include</span>" }),
      ...P("/v2", { label: "" }),
      ...P("/v3", { controls: "dangling", active: 0, listId: false, label: "" }),
    },
    async run(h) {
      for (const path of ["/v1", "/v2", "/v3"]) {
        const { r, seen } = await pick(h, path, "Emails", { mode: "ask" });
        expect(seen.length === 1 && r.out === "Emails", `${path} 카드 후 고름(cards=${seen.length}, out='${r.out}')`);
        if (path !== "/v1") expect(seen[0].includes("(이름 없음)"), `${path} 트리거 이름 없음(${seen[0]})`);
        const r2 = await h.turn([findItems, { text: "끝" }], { path });
        await noSecret(h, r, seen);
        await noSecret(h, r2);
      }
    },
  },
];
