// 같은 호출의 같은 실패 반복(#318): 같은 도구·같은 인자·같은 원인으로 거듭 실패하면 두 번째 결과에 방법을 바꾸라는 안내(repeated)를
// 붙이고 세 번째에 멈춘다. 다른 대상의 성공(Dismiss)이 사이에 끼어도 이어서 센다(기존 헛돌기 감지가 놓친 순환).
// 오탐 방지: 다른 대상·같은 호출의 성공·다른 행으로 옮겨 다시 쓴 노드(같은 id)·새 요청은 세지 않는다.
// 'Show options'는 누를 때(mousedown) 목록을 연 것처럼 이름을 'Hide options'로 바꾼다 → 실제 입력 클릭이 떼기에서 막힌다(대상 바뀜,
// #316과 같은 꼴). Dismiss를 누를 때까지 열린 이름으로 남는다(그 사이 찾기에도 바뀐 이름으로 나온다).
import { expect, findC } from "../lib.mjs";

const SECRET = "비밀메모-318";
const blocker = (id, label) =>
  `<div id=${id} role=button tabindex=0 aria-label="${label}" style="width:120px;height:32px;background:#ddd;margin:4px">▼</div>`;
const PAGE = `<title>반복 실패</title><main>
<input id=memo aria-label="메모">
${blocker("show", "Show options")}
${blocker("more", "More options")}
<button id=dismiss style="width:120px;height:32px">Dismiss</button>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
window.__dismiss = 0;
// ?ok=n: n번째 누르기만 막지 않는다(성공한 재시도 시험).
const ok = Number(new URLSearchParams(location.search).get("ok") || 0);
const presses = {};
const labels = new Map();
for (const el of [show, more]) {
  labels.set(el, el.getAttribute("aria-label"));
  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    presses[el.id] = (presses[el.id] || 0) + 1;
    if (presses[el.id] === ok) { out.textContent = "열림"; return; }
    el.setAttribute("aria-label", "Hide options");
  });
}
dismiss.addEventListener("click", () => {
  for (const [el, label] of labels) el.setAttribute("aria-label", label);
  out.textContent = "닫음 " + (++window.__dismiss);
});
</script></main>`;

// 같은 버튼 노드를 글자가 같은 두 행 사이로 옮겨 다시 쓰는 목록(가상 목록의 노드 재사용 흉내). 누르면 이름이 바뀌어 막히고,
// 잠시 뒤 이름을 되돌리며 다른 행으로 옮긴다.
const ROWS = `<title>행 재사용</title><main>
<input id=memo aria-label="메모">
<button id=dismiss style="width:120px;height:32px" onclick="out.textContent='닫음'">Dismiss</button>
<ul><li id=r1><span>항목 A</span> </li><li id=r2><span>항목 A</span> </li></ul>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
const b = document.createElement("div");
b.setAttribute("role", "button");
b.tabIndex = 0;
b.setAttribute("aria-label", "열기");
b.style.cssText = "display:inline-block;width:120px;height:32px;background:#ddd";
r1.append(b);
b.addEventListener("mousedown", (e) => {
  e.preventDefault();
  b.setAttribute("aria-label", "닫기");
  setTimeout(() => {
    b.setAttribute("aria-label", "열기");
    (b.parentElement === r1 ? r2 : r1).append(b);
  }, 300);
});
</script></main>`;

// 행에 버튼 말고 글자가 없는 변형(행 글자가 버튼 글자와 같아 행 문맥이 비는 경우, 5회차 P1).
const BARE_ROWS = ROWS.replace(/<span>항목 A<\/span> /g, "");

// 버튼이 열린 shadow root 안에 있고 호스트를 글자 없는 두 행 사이로 옮기는 변형(6회차 P1).
const SHADOW_ROWS = `<title>행 재사용(shadow)</title><main>
<input id=memo aria-label="메모">
<button id=dismiss style="width:120px;height:32px" onclick="out.textContent='닫음'">Dismiss</button>
<ul><li id=r1></li><li id=r2></li></ul>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
const host = document.createElement("span");
r1.append(host);
const b = document.createElement("div");
b.setAttribute("role", "button");
b.tabIndex = 0;
b.setAttribute("aria-label", "열기");
b.style.cssText = "display:inline-block;width:120px;height:32px;background:#ddd";
host.attachShadow({ mode: "open" }).append(b);
b.addEventListener("mousedown", (e) => {
  e.preventDefault();
  b.setAttribute("aria-label", "닫기");
  setTimeout(() => {
    b.setAttribute("aria-label", "열기");
    (host.parentElement === r1 ? r2 : r1).append(host);
  }, 300);
});
</script></main>`;

// 같은 버튼(DOM 부모는 그대로)을 slot 속성만 바꿔 shadow 안의 다른(글자 없는) 행에 배치하는 변형(7회차 P1).
const SLOT_ROWS = `<title>행 재사용(slot)</title><main>
<input id=memo aria-label="메모">
<button id=dismiss style="width:120px;height:32px" onclick="out.textContent='닫음'">Dismiss</button>
<div id=host></div>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
host.attachShadow({ mode: "open" }).innerHTML = '<ul><li id=r1><slot name=a></slot></li><li id=r2><slot name=b></slot></li></ul>';
const b = document.createElement("div");
b.setAttribute("role", "button");
b.tabIndex = 0;
b.slot = "a";
b.setAttribute("aria-label", "열기");
b.style.cssText = "display:inline-block;width:120px;height:32px;background:#ddd";
host.append(b);
b.addEventListener("mousedown", (e) => {
  e.preventDefault();
  b.setAttribute("aria-label", "닫기");
  setTimeout(() => {
    b.setAttribute("aria-label", "열기");
    b.slot = b.slot === "a" ? "b" : "a";
  }, 300);
});
</script></main>`;

// 같은 행·같은 ▼ 버튼 노드를 다른 항목에 다시 쓰며 접근성 이름(aria-label)만 바꾸는 가상 목록(코드 리뷰 1회차 P1).
const RENAMED = `<title>이름 바뀌는 버튼</title><main>
<input id=memo aria-label="메모">
<button id=dismiss style="width:120px;height:32px" onclick="out.textContent='닫음'">Dismiss</button>
<ul><li><div id=b role=button tabindex=0 aria-label="A 열기" style="display:inline-block;width:120px;height:32px;background:#ddd">▼</div></li></ul>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
const names = ["A 열기", "B 열기", "C 열기"];
let n = 0;
b.addEventListener("mousedown", (e) => {
  e.preventDefault();
  b.setAttribute("aria-label", "닫기");
  setTimeout(() => b.setAttribute("aria-label", names[++n] ?? "끝"), 300);
});
</script></main>`;

// 행 표시가 없는 일반 div 행(버튼 외 글자 없음) 사이로 같은 버튼 노드를 옮기는 변형(코드 리뷰 2회차 P2).
const DIV_ROWS = BARE_ROWS.replace("<ul><li id=r1></li><li id=r2></li></ul>", "<div><div id=r1></div><div id=r2></div></div>");

// 같은 '열기' 버튼 노드가 고른 레코드에 따라 formaction(제출 목적지)만 바꾸는 양식(코드 리뷰 2회차 P1).
const FORMACTION = `<title>제출 목적지</title><main>
<input id=memo aria-label="메모">
<button id=dismiss type=button style="width:120px;height:32px" onclick="out.textContent='닫음'">Dismiss</button>
<form action="/noop" onsubmit="return false"><button id=b formaction="/edit/A" style="width:120px;height:32px">열기</button></form>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
const recs = ["A", "B", "C"];
let n = 0;
b.addEventListener("mousedown", (e) => {
  e.preventDefault();
  b.setAttribute("aria-label", "닫기");
  setTimeout(() => {
    b.removeAttribute("aria-label");
    b.setAttribute("formaction", "/edit/" + (recs[++n] ?? "Z"));
  }, 300);
});
</script></main>`;

// 같은 '열기' 버튼 노드가 hx-get(요청 주소)만 바꾸는 변형(코드 리뷰 3회차 P1).
const HXGET = FORMACTION.replace('<form action="/noop" onsubmit="return false"><button id=b formaction="/edit/A"', '<div><button id=b type=button hx-get="/edit/A"')
  .replace("열기</button></form>", "열기</button></div>")
  .replace('b.setAttribute("formaction", "/edit/" + (recs[++n] ?? "Z"));', 'b.setAttribute("hx-get", "/edit/" + (recs[++n] ?? "Z"));');

// 버튼을 두 겹 래퍼째로 글자 없는 일반 div 행 사이로 옮기는 변형(코드 리뷰 3회차 P2).
const WRAPPED_ROWS = DIV_ROWS.replace("r1.append(b);", 'const w1 = document.createElement("div"); const w2 = document.createElement("div"); w1.append(w2); w2.append(b); r1.append(w1);')
  .replace("(b.parentElement === r1 ? r2 : r1).append(b);", "(w1.parentElement === r1 ? r2 : r1).append(w1);");

const show = (callId) => ({ click: "Show options", ...(callId ? { callId } : {}) });
const dismiss = { click: "Dismiss" };
const reqs = (h) => h.sw.evaluate(() => globalThis.__modelReqs ?? []);
// 마지막 모델 요청의 도구 결과 메시지(호출 id·내용).
async function lastToolMessages(h) {
  const list = await reqs(h);
  const body = list.at(-1)?.body ?? {};
  return { body, tools: (body.messages ?? []).filter((m) => m.role === "tool").map((m) => ({ id: m.tool_call_id, data: JSON.parse(m.content) })) };
}
// 이번 턴의 클릭 결과(첫 요청은 앞 턴의 마지막 결과를 다시 싣으므로 호출 id로 한 번씩, 앞 턴의 것은 뺀다).
const clickResults = (r, prev = null) => {
  const seen = new Set((prev?.tools ?? []).map((t) => t.callId));
  return r.tools.filter((t) => t.name === "click_element" && !seen.has(t.callId) && (seen.add(t.callId), true));
};
const clickFails = (r) => r.logs.filter((l) => l.includes("tool:result") && l.includes(" click_element fail")).length;
async function noSecret(h, r) {
  const all = JSON.stringify(await reqs(h));
  expect(!all.includes(SECRET), "입력 칸 값이 모델 요청에 없어야 한다(#43)");
  expect(!r.logs.some((l) => l.includes(SECRET)), "입력 칸 값이 로그에 없어야 한다(#43)");
}
const settings = { autoApprove: true, trustedInput: true };
const panelBody = (h) => h.panel.locator("body").innerText();

// 마지막 요청에 실린 대화의 click_element 호출 인자(호출 순서).
async function sentClickArgs(h) {
  const body = (await reqs(h)).at(-1)?.body ?? {};
  return (body.messages ?? [])
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.tool_calls ?? [])
    .filter((c) => c.function.name === "click_element")
    .map((c) => c.function.arguments);
}

export default [
  {
    name: "같은 대상이 같은 원인으로 거듭 실패하면 두 번째 결과에 안내, 세 번째에 멈춘다(사이에 다른 대상 성공)",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn(
        [findC, show("call_s"), findC, dismiss, findC, show("call_s"), findC, dismiss, findC, show("call_s"), { text: "보내면 안 됨" }],
        { path: "/p" },
      );
      expect(clickFails(r) === 3, `Show 실패 3번(${clickFails(r)})`);
      const dismissed = await h.tab.evaluate(() => window.__dismiss);
      expect(dismissed === 2, `Dismiss 2번 성공(${dismissed})`);
      const opened = r.tools.some((t) => t.name === "find_clickables" && JSON.stringify(t.result ?? "").includes("Hide options"));
      expect(opened, "그 사이 찾기에 열린 이름(Hide options)으로 나온다");
      const { body, tools } = await lastToolMessages(h);
      expect(body.tool_choice === "none", `마무리 요청은 도구 없이(${JSON.stringify(body.tool_choice)})`);
      const s = tools.filter((t) => t.id === "call_s");
      expect(s.length === 3, `Show 결과 3개(${s.length})`);
      expect(s[0].data.repeated === undefined, `첫 결과는 그대로(${JSON.stringify(s[0].data).slice(0, 200)})`);
      expect(typeof s[1].data.repeated === "string" && s[1].data.repeated.includes("같은 도구(click_element)") && s[1].data.repeated.includes("2번 실패"), `두 번째 결과에 안내(${s[1].data.repeated})`);
      expect(typeof s[2].data.repeated === "string" && s[2].data.repeated.includes("3번 실패"), `세 번째 결과에 안내(${s[2].data.repeated})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `Show는 같은 인자로 세 번(${args.join(" | ")})`);
      const repeatLogs = r.logs.filter((l) => l.includes("hop:repeat_fail"));
      expect(repeatLogs.length === 2 && repeatLogs.every((l) => /hop:repeat_fail\W+click_element ×[23]\s*$/.test(l)), `로그는 도구 이름과 수만(${repeatLogs.join(" | ")})`);
      expect(r.logs.some((l) => l.includes("hop:spin") && l.includes("same_failure · click_element ×3")), "같은 실패 멈춤 로그");
      expect(!r.logs.some((l) => l.includes("|t:") || l.includes("blocked:")), "원인 코드·대상 회차는 로그에 없다");
      expect(!JSON.stringify(await reqs(h)).includes("|t:"), "원인 코드는 모델 요청에 없다");
      await noSecret(h, r);
    },
  },
  {
    name: "한 응답에 [같은 실패, 다른 성공]이 함께 와도 세 번째 같은 실패에서 멈추고 남은 호출은 실행하지 않는다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn(
        [
          findC,
          show("call_s"),
          findC,
          dismiss,
          findC,
          { clickMany: [{ text: "Show options", callId: "call_s" }, { text: "Dismiss", callId: "call_d2" }] },
          findC,
          { clickMany: [{ text: "Show options", callId: "call_s" }, { text: "Dismiss", callId: "call_d3" }] },
          { text: "보내면 안 됨" },
        ],
        { path: "/p" },
      );
      expect(clickFails(r) === 3, `Show 실패 3번(${clickFails(r)})`);
      const dismissed = await h.tab.evaluate(() => window.__dismiss);
      expect(dismissed === 2, `마지막 응답의 Dismiss는 실행하지 않음(${dismissed})`);
      const { body, tools } = await lastToolMessages(h);
      expect(body.tool_choice === "none", "마무리 요청은 도구 없이");
      const s = tools.filter((t) => t.id === "call_s");
      expect(s.length === 3 && s[0].data.repeated === undefined && s[1].data.repeated && s[2].data.repeated, `Show 결과 안내(${s.map((x) => !!x.data.repeated).join(",")})`);
      const d2 = tools.find((t) => t.id === "call_d2");
      expect(d2 && d2.data.result && !d2.data.error, `둘째 응답의 Dismiss는 실행(${JSON.stringify(d2?.data).slice(0, 120)})`);
      const d3 = tools.find((t) => t.id === "call_d3");
      expect(d3 && d3.data.error === "interrupted", `셋째 응답의 Dismiss는 미실행 결과(${JSON.stringify(d3?.data)})`);
      expect(r.logs.some((l) => l.includes("same_failure · click_element ×3")), "같은 실패 멈춤 로그");
    },
  },
  {
    name: "다른 대상이 한 번씩 실패하거나, 같은 호출이 사이에 성공하면 안내하지 않는다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      const a = await h.turn([findC, show(), findC, { click: "More options" }, { text: "끝" }], { path: "/p" });
      expect(clickFails(a) === 2, `두 대상 실패(${clickFails(a)})`);
      expect(clickResults(a).every((t) => t.repeated === undefined), "다른 대상은 안내 없음");
      expect(!a.logs.some((l) => l.includes("hop:repeat_fail")), "반복 로그 없음");

      // 두 번째 누르기만 성공: 실패 → (닫기) → 성공 → (닫기) → 실패. 같은 호출이 성공하면 0부터 센다.
      const b = await h.turn([findC, show(), findC, dismiss, findC, show(), findC, dismiss, findC, show(), { text: "끝" }], { path: "/p?ok=2" });
      const res = clickResults(b, a);
      expect(res.length === 5, `클릭 결과 5개(${res.length})`);
      const shows = [res[0], res[2], res[4]];
      expect(shows[0].result?.error && !shows[1].result?.error && shows[2].result?.error, `실패·성공·실패(${shows.map((t) => (t.result?.error ? "x" : "o")).join("")})`);
      expect(res.every((t) => t.repeated === undefined), `성공 뒤 실패는 안내 없음(${res.map((t) => !!t.repeated).join(",")})`);
      expect(!b.logs.some((l) => l.includes("hop:repeat_fail")), "반복 로그 없음");
    },
  },
  {
    name: "같은 버튼 노드를 글자가 같은 다른 행으로 옮겨 다시 쓰면 같은 id로 다시 눌러도(다시 찾지 않음) 같은 실패로 세지 않는다",
    pages: { "/rows": ROWS },
    async run(h) {
      await h.settings(settings);
      const again = (text) => ({ clickAgain: text });
      const r = await h.turn(
        [findC, { click: "열기" }, { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { text: "끝까지 감" }],
        { path: "/rows" },
      );
      expect(clickFails(r) === 3, `열기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `열기는 같은 id로 세 번(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "다른 행은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), `반복·헛돌기 로그 없음(${r.logs.filter((l) => l.includes("hop:")).slice(-3).join(" | ")})`);
      const text = await h.panel.locator("body").innerText();
      expect(text.includes("끝까지 감"), `마지막 예정 응답까지 감(${text.slice(-80)})`);
      await noSecret(h, r);
    },
  },
  {
    name: "버튼 말고 글자가 없는 두 행 사이로 같은 버튼 노드를 옮겨도 같은 id로 다시 누른 실패를 같은 실패로 세지 않는다",
    pages: { "/bare": BARE_ROWS },
    async run(h) {
      await h.settings(settings);
      const again = (text) => ({ clickAgain: text });
      const r = await h.turn(
        [findC, { click: "열기" }, { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { text: "끝까지 감" }],
        { path: "/bare" },
      );
      expect(clickFails(r) === 3, `열기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `열기는 같은 id로 세 번(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "다른 행은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
    },
  },
  {
    name: "행 표시가 없는 일반 div 행(글자 없음) 사이로 같은 버튼 노드를 옮겨도 같은 id로 다시 누른 실패를 같은 실패로 세지 않는다",
    pages: { "/divs": DIV_ROWS },
    async run(h) {
      await h.settings(settings);
      const again = (text) => ({ clickAgain: text });
      const r = await h.turn(
        [findC, { click: "열기" }, { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { text: "끝까지 감" }],
        { path: "/divs" },
      );
      expect(clickFails(r) === 3, `열기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `열기는 같은 id로 세 번(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "다른 행은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
    },
  },
  {
    name: "같은 버튼 노드가 제출 목적지(formaction)만 바꾼 다른 동작은(다시 찾음) 같은 실패로 세지 않는다",
    pages: { "/fa": FORMACTION, "/edit/A": "<p>A</p>", "/edit/B": "<p>B</p>", "/edit/C": "<p>C</p>" },
    async run(h) {
      await h.settings(settings);
      const open = { click: "열기" };
      const r = await h.turn(
        [findC, open, { delayMs: 500, ...findC }, dismiss, findC, open, { delayMs: 500, ...findC }, dismiss, findC, open, { text: "끝까지 감" }],
        { path: "/fa", approve: true },
      );
      expect(clickFails(r) === 3, `세 동작 실패(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `같은 id(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "목적지가 다른 동작은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
      expect((await panelBody(h)).includes("끝까지 감"), "마지막 예정 응답까지 감");
    },
  },
  {
    name: "같은 버튼 노드가 요청 주소(hx-get)만 바꾼 다른 동작은(다시 찾음) 같은 실패로 세지 않는다",
    pages: { "/hx": HXGET, "/edit/A": "<p>A</p>", "/edit/B": "<p>B</p>", "/edit/C": "<p>C</p>" },
    async run(h) {
      await h.settings(settings);
      const open = { click: "열기" };
      const r = await h.turn(
        [findC, open, { delayMs: 500, ...findC }, dismiss, findC, open, { delayMs: 500, ...findC }, dismiss, findC, open, { text: "끝까지 감" }],
        { path: "/hx", approve: true },
      );
      expect(clickFails(r) === 3, `세 동작 실패(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `같은 id(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "목적지가 다른 동작은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
      expect((await panelBody(h)).includes("끝까지 감"), "마지막 예정 응답까지 감");
    },
  },
  {
    name: "버튼을 두 겹 래퍼째 글자 없는 일반 div 행 사이로 옮겨도 같은 id로 다시 누른 실패를 같은 실패로 세지 않는다",
    pages: { "/wrapped": WRAPPED_ROWS },
    async run(h) {
      await h.settings(settings);
      const again = (text) => ({ clickAgain: text });
      const r = await h.turn(
        [findC, { click: "열기" }, { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { text: "끝까지 감" }],
        { path: "/wrapped" },
      );
      expect(clickFails(r) === 3, `열기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `열기는 같은 id로 세 번(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "다른 행은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
    },
  },
  {
    name: "열린 shadow root 안의 버튼 호스트를 글자 없는 두 행 사이로 옮겨도 같은 id로 다시 누른 실패를 같은 실패로 세지 않는다",
    pages: { "/shadow": SHADOW_ROWS },
    async run(h) {
      await h.settings(settings);
      const again = (text) => ({ clickAgain: text });
      const r = await h.turn(
        [findC, { click: "열기" }, { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { text: "끝까지 감" }],
        { path: "/shadow" },
      );
      expect(clickFails(r) === 3, `열기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `열기는 같은 id로 세 번(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "다른 행은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
    },
  },
  {
    name: "같은 버튼의 slot 속성만 바꿔 shadow 안의 다른 행에 배치해도 같은 id로 다시 누른 실패를 같은 실패로 세지 않는다",
    pages: { "/slot": SLOT_ROWS },
    async run(h) {
      await h.settings(settings);
      const again = (text) => ({ clickAgain: text });
      const r = await h.turn(
        [findC, { click: "열기" }, { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { delayMs: 500, clickAgain: "Dismiss" }, again("열기"), { text: "끝까지 감" }],
        { path: "/slot" },
      );
      expect(clickFails(r) === 3, `열기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `열기는 같은 id로 세 번(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "다른 행은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
    },
  },
  {
    name: "한 응답 안에서 호출 id가 겹쳐도 멈출 때 남은 호출마다 미실행 결과를 하나씩 채운다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      await h.turn(
        [
          findC,
          show("call_s"),
          findC,
          dismiss,
          findC,
          show("call_s"),
          findC,
          dismiss,
          findC,
          { clickMany: [{ text: "Show options", callId: "call_x" }, { text: "Dismiss", callId: "call_x" }] },
          { text: "보내면 안 됨" },
        ],
        { path: "/p" },
      );
      const dismissed = await h.tab.evaluate(() => window.__dismiss);
      expect(dismissed === 2, `마지막 응답의 Dismiss는 실행하지 않음(${dismissed})`);
      // 겹친 id는 받을 때 뒤의 것에 새 id를 준다(streamReply) — 마무리 요청의 호출·결과 짝이 맞아 거절되지 않는다(공통 짝 검사가 확인).
      const { body, tools } = await lastToolMessages(h);
      expect(body.tool_choice === "none", "마무리 요청은 도구 없이");
      const lastCalls = (body.messages ?? []).filter((m) => m.role === "assistant" && m.tool_calls?.length).at(-1).tool_calls.map((c) => c.id);
      expect(lastCalls.length === 2 && lastCalls[0] === "call_x" && lastCalls[1] !== "call_x", `겹친 id는 뒤의 것만 새 id(${lastCalls.join(",")})`);
      const first = tools.find((t) => t.id === lastCalls[0]);
      const second = tools.find((t) => t.id === lastCalls[1]);
      expect(first?.data.result?.error && typeof first.data.repeated === "string", `첫째는 Show 실패 + 안내(${JSON.stringify(first?.data).slice(0, 160)})`);
      expect(second?.data.error === "interrupted", `둘째는 미실행(${JSON.stringify(second?.data)})`);
      expect((await panelBody(h)).includes("정리"), "마무리 답을 받는다");
      // 다음 요청도 같은 대화로 이어진다(기록의 짝이 맞음).
      await h.turn([{ text: "다음 턴 답" }], { path: "/p", noReload: true });
      expect((await panelBody(h)).includes("다음 턴 답"), "다음 턴 답");
    },
  },
  {
    name: "같은 노드를 다시 쓰며 접근성 이름만 바꾼 다른 대상은(다시 찾아 다른 이름을 봄) 같은 실패로 세지 않는다",
    pages: { "/renamed": RENAMED },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn(
        [findC, { click: "A 열기" }, { delayMs: 500, ...findC }, dismiss, findC, { click: "B 열기" }, { delayMs: 500, ...findC }, dismiss, findC, { click: "C 열기" }, { text: "끝까지 감" }],
        { path: "/renamed" },
      );
      expect(clickFails(r) === 3, `세 대상 실패(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `같은 id(${args.join(" | ")})`);
      expect(clickResults(r).every((t) => t.repeated === undefined), "이름이 다른 대상은 안내 없음");
      expect(!r.logs.some((l) => l.includes("hop:repeat_fail") || l.includes("hop:spin")), "반복·헛돌기 로그 없음");
      expect((await panelBody(h)).includes("끝까지 감"), "마지막 예정 응답까지 감");
    },
  },
  {
    name: "오래된 id 클릭 실패(대상 확인의 stale_target)도 사이에 다른 대상 성공이 끼면 두 번째에 안내",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn([findC, { clickStaleLocal: true }, findC, dismiss, findC, { clickStaleLocal: true }, { text: "끝" }], { path: "/p" });
      const stale = clickResults(r).filter((t) => t.error);
      expect(stale.length === 2, `오래된 id 실패 2번(${JSON.stringify(clickResults(r)).slice(0, 300)})`);
      expect(stale[0].repeated === undefined && typeof stale[1].repeated === "string", `두 번째에만 안내(${stale.map((t) => !!t.repeated).join(",")})`);
    },
  },
  {
    name: "새 요청이면 같은 대상이라도 새로 센다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      const one = await h.turn([findC, show(), findC, dismiss, findC, show(), { text: "첫 턴 끝" }], { path: "/p" });
      const first = clickResults(one).filter((t) => t.result?.error);
      expect(first.length === 2 && first[1].repeated, "첫 턴 두 번째 실패에 안내");
      const two = await h.turn([findC, dismiss, findC, show(), { text: "둘째 턴 끝" }], { path: "/p", noReload: true });
      // 마지막 요청에 두 턴의 대화가 모두 실린다: [Show, Dismiss, Show](첫 턴) + [Dismiss, Show](둘째 턴).
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `두 턴의 Show 인자가 같다(${args.join(" | ")})`);
      const res = clickResults(two, one).filter((t) => t.result?.error);
      expect(res.length === 1, `둘째 턴 실패 1번(${JSON.stringify(res).slice(0, 200)})`);
      expect(res[0].repeated === undefined, "새 요청의 첫 실패는 안내 없음");
    },
  },
  {
    name: "한도 카드에 같은 호출 반복 실패 줄을 보이고, 이어 가면 같은 턴으로 이어 센다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ ...settings, maxToolHops: 6, maxToolHopsVersion: 2 });
      const seen = [];
      const r = await h.turn([findC, show(), findC, dismiss, findC, show(), findC, dismiss, findC, show(), { text: "보내면 안 됨" }], {
        path: "/p",
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1, `한도 카드 1번(${r.cards})`);
      expect(seen[0].includes("같은 호출 반복 실패: 누르기 2번"), `카드에 반복 실패 줄(${seen[0]})`);
      expect(!seen[0].includes(SECRET), "카드에 입력값 없음");
      expect(r.logs.some((l) => l.includes("same_failure · click_element ×3")), "이어 간 뒤 세 번째에서 멈춤");
    },
  },
];
