// 입력 중 행 변화 안내(#317): 입력 처리기가 같은 행에 안내 문구를 그리면 입력 중 검사가 지금처럼 막는다(판정은 그대로). 막힌 까닭이
// "비교한 칸 이름·종류는 그대로이고 행 글자만 더해짐"이면 결과 문구가 그렇게 알리고 회복 방법(다시 찾아 확인 뒤 한 번)을 안내한다.
// 글자 칸·select의 input 뒤 막힘에만 refillOnce(한 번 재시도 가능)를 단다. checkbox·radio는 클릭을 이미 보냈으므로 다시 누르라고 하지 않는다.
// 모든 값은 가짜(fake-…-317)이고, 채우기 결과·오류 어디에도 넣은 값이 없어야 한다(#43).
import { expect, resultLog } from "../lib.mjs";

const findF = { tool: "find_form_fields", args: {} };
const HINT = " 이 칸에는 영문 소문자와 숫자만 쓸 수 있으며 저장한 뒤에도 언제든 바꿀 수 있습니다 ";
const MSG_INPUT = "입력 중 이 칸이 든 행에 글자가 더해져";
const MSG_CLICK = "누른 뒤 이 칸이 든 행에 글자가 더해져";
const MSG_TOGGLE_INPUT = "변경 이벤트를 보내지 않았습니다. 클릭과 입력 이벤트는 이미 보냈습니다";
const MSG_HALTED = "앞 칸 입력 중 그 칸이 든 행에 글자가 더해져 이 칸은 채우지 않았습니다";
const MSG_PRE_WRITE = "승인한 뒤 이 칸이 든 행에 글자가 더해져";
const MSG_REASON = "이 칸이 든 행에 글자가 더해짐 — 비교한 칸 이름·종류는 그대로";
const OLD_GUARD = "입력 중 칸이 바뀌어 변경 이벤트를 보내지 않았습니다(";
const OLD_HALTED = "앞 칸에서 위험 변화가 보여 채우지 않았습니다";

// 칸별 input·change·click 수를 세고, 모드(?m=)에 따라 처리기가 행을 바꾼다. 행마다 처음부터 빈 안내 영역(p.hint)과 빈 숨은 글자
// 영역(span.hid)이 있어 행 모양·목록 순번은 입력 뒤에도 그대로다.
const SCRIPT = `<script>
const m = new URLSearchParams(location.search).get("m") || "own";
window.__ev = {};
const rowOf = (el) => el.closest(".row");
const setHint = (row, text) => { const h = row.querySelector(".hint"); if (h.textContent.trim() === "") h.textContent = text; };
for (const el of document.querySelectorAll("#f input:not([type=hidden])")) {
  const ev = (window.__ev[el.id] = { input: 0, change: 0, click: 0 });
  const row = rowOf(el);
  el.addEventListener("click", () => {
    ev.click++;
    if (m === "click") setHint(row, ${JSON.stringify(HINT)});
    if (m === "clickrevert") { setHint(row, ${JSON.stringify(HINT)}); el.checked = false; }
  });
  el.addEventListener("input", () => {
    ev.input++;
    if (m === "own") setHint(row, ${JSON.stringify(HINT)});
    if (m === "skipA" && el.id !== "a") setHint(row, ${JSON.stringify(HINT)});
    if (m === "echo") setHint(row, " 값 " + el.value + " 은 이미 쓰고 있습니다 ");
    if (m === "late") setTimeout(() => setHint(row, ${JSON.stringify(HINT)}), 50);
    if (m === "next" && el.id === "a") setHint(rowOf(document.getElementById("b")), ${JSON.stringify(HINT)});
    if (m === "action") { setHint(row, ${JSON.stringify(HINT)}); document.getElementById("f").action = "/pay/checkout"; }
    if (m === "hiddenpay") document.getElementById("op").value = "pay";
    if (m === "tight") setHint(row, "형식 안내");
    if (m === "hiddenrec") { setHint(row, ${JSON.stringify(HINT)}); document.getElementById("op").value = "2"; }
    if (m === "record") { setHint(row, ${JSON.stringify(HINT)}); document.getElementById("f").action = "/records/2"; }
    if (m === "hiddenonly") row.querySelector(".hid").textContent = " 숨은 안내 ";
    if (m === "retag") { setHint(row, ${JSON.stringify(HINT)}); row.querySelector(".tag").textContent = "T9"; }
    if (m === "rename") { setHint(row, ${JSON.stringify(HINT)}); row.querySelector("label").textContent = "바뀐 이름"; }
    if (m === "inputrevert") { setHint(row, ${JSON.stringify(HINT)}); el.checked = false; }
  });
  el.addEventListener("change", () => {
    ev.change++;
    if (m === "change-next-risk" && el.id === "a") {
      setHint(rowOf(document.getElementById("b")), ${JSON.stringify(HINT)});
      document.getElementById("f").action = "/pay/checkout";
    }
  });
}
</script>`;

const row = (id, label, extra = "", type = "text") =>
  `<div class=row>${extra}<label for=${id}>${label}</label><div class=ctl><input id=${id} name=${id} type=${type}${label ? "" : ` aria-label="첫칸"`}></div><p class=hint> </p><span class=hid hidden></span></div>`;

// 행 셋. 첫 행의 label 글자는 비워 승인 때 보이는 행 문맥이 없다(이슈의 0→63 — 기술에서 modelContext가 생략됨).
const ROWS = `<title>행 안내</title><main><form id=f action="/submit"><input type=hidden id=op name=op value=browse>
${row("a", "")}${row("b", "Domain")}${row("c", "Action")}
</form><p id=out></p>${SCRIPT}</main>`;

// 행마다 식별 글자(span.tag)가 있는 셋(식별 글자 바뀜·칸 이름 바뀜 시험).
const TAGGED = `<title>행 식별</title><main><form id=f action="/submit">
${row("a", "Code", "<span class=tag>T1</span>")}${row("b", "Domain", "<span class=tag>T2</span>")}${row("c", "Action", "<span class=tag>T3</span>")}
</form><p id=out></p>${SCRIPT}</main>`;

// checkbox 둘과 글자 칸 하나(같은 행 모양).
const CHECKS = `<title>체크 안내</title><main><form id=f action="/submit">
${row("k1", "동의1", "", "checkbox")}${row("k2", "동의2", "", "checkbox")}${row("t", "메모")}
</form><p id=out></p>${SCRIPT}</main>`;

async function toolMessages(h) {
  const body = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1)?.body);
  return (body?.messages ?? []).filter((m) => m.role === "tool").map((m) => ({ name: m.name, raw: m.content, ...JSON.parse(m.content) }));
}
const fills = async (h) => (await toolMessages(h)).filter((m) => m.name === "fill_form_fields");
const finds = async (h) => (await toolMessages(h)).filter((m) => m.name === "find_form_fields");
const events = (h) => h.tab.evaluate(() => window.__ev);
const resultsOf = (m) => m?.result?.results ?? [];
const has = (r, s) => String(r?.note ?? "").includes(s);
const show = (x) => JSON.stringify(x);

// 같은 값으로 셋을 한 호출에 채운다.
const FILL3 = { fillMany: [{ label: "첫칸", value: "fake-a-317" }, { label: "Domain", value: "fake-b-317" }, { label: "Action", value: "fake-c-317" }] };
const FILL3T = { fillMany: [{ label: "Code", value: "fake-a-317" }, { label: "Domain", value: "fake-b-317" }, { label: "Action", value: "fake-c-317" }] };

// 채우기 결과·오류(role=tool의 fill_form_fields 전체 글)에 가짜 값이 없다.
async function noValues(h) {
  for (const m of await fills(h)) expect(!/fake-[a-z]+-317/.test(m.raw), `채우기 결과에 넣은 값이 있음(${m.raw})`);
}

export default [
  {
    name: "#317 R1 행에 안내가 생겨 막힌 첫 칸: 이유·회복 안내와 refillOnce, 남은 칸 안내, 작업 기록 분류 그대로, 다시 찾아 같은 값으로 채우면 통과",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findF, FILL3, findF, { fill: "첫칸", value: "fake-a-317" }, { text: "끝" }], { path: "/r" });
      const [f1, f2] = await fills(h);
      const [d1, d2] = await finds(h);
      const [ra, rb, rc] = resultsOf(f1);
      expect(!ra.applied && has(ra, MSG_INPUT) && ra.refillOnce === true && !has(ra, OLD_GUARD), `첫 칸 안내(${show(ra)})`);
      expect(has(rb, MSG_HALTED) && has(rc, MSG_HALTED) && !rb.refillOnce && !has(rb, OLD_HALTED), `남은 칸 안내(${show([rb, rc])})`);
      const ev = await events(h);
      expect(ev.a.input === 2 && ev.a.change === 1, `첫 칸 이벤트(${show(ev.a)})`);
      expect(ev.b.input === 0 && ev.c.input === 0, `남은 칸은 쓰지 않음(${show(ev)})`);
      // 0→63: 첫 찾기에서 첫 칸 context는 생략, 다시 찾으면 같은 id에 안내가 보인다.
      const a1 = d1.result.find((f) => f.label === "첫칸");
      const a2 = d2.result.find((f) => f.label === "첫칸");
      expect(a1 && a1.id === a2?.id, `다시 찾아도 같은 id(${show([a1, a2])})`);
      expect(!a1.context && String(a2.context ?? "").includes("영문 소문자"), `행 문맥 생략 → 안내(${show([a1, a2])})`);
      expect(resultsOf(f2)[0]?.applied === true, `다시 채우기 통과(${show(f2)})`);
      // 작업 기록 분류는 지금과 같다(첫 채우기: 쓰기 전 중단으로 분류된 칸뿐 → aborted·target_changed).
      const log = await h.sw.evaluate(async () => ((await chrome.storage.local.get("actionLog")).actionLog ?? []).filter((e) => e.tool === "fill_form_fields"));
      const first = log.at(-2);
      expect(first?.outcome === "aborted" && first?.reason === "target_changed", `작업 기록(${show(log.slice(-2))})`);
      await noValues(h);
    },
  },
  {
    name: "#317 R1b 부분 성공: 첫 칸은 통과, 둘째만 행 안내로 막히면 호출은 성공이고 그 칸 결과에 refillOnce",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=skipA" });
      const f1 = (await fills(h)).at(-1);
      const [ra, rb, rc] = resultsOf(f1);
      // 모델에 간 글에는 ok가 없다 — 백그라운드가 남긴 도구 결과 줄(패널의 tool_result.ok와 같은 값)로 호출 전체의 성공을 본다.
      const line = resultLog(r, "fill_form_fields");
      expect(line.includes("fill_form_fields ok") && !f1.error, `호출은 성공(${line} ${show(f1)})`);
      expect(ra.applied === true && !ra.refillOnce, `첫 칸 통과(${show(ra)})`);
      expect(!rb.applied && has(rb, MSG_INPUT) && rb.refillOnce === true, `둘째 안내(${show(rb)})`);
      expect(has(rc, MSG_HALTED), `셋째 남은 칸 안내(${show(rc)})`);
    },
  },
  {
    name: "#317 R2 checkbox: click 처리기가 행 안내를 그리면 click 단계 안내(다시 누르지 않음)·refillOnce 없음, 체크를 되돌려도 같음",
    pages: { "/k": CHECKS },
    async run(h) {
      await h.settings({ autoApprove: true });
      for (const m of ["click", "clickrevert"]) {
        await h.turn([findF, { fillMany: [{ label: "동의1", value: "true" }, { label: "메모", value: "fake-t-317" }] }, { text: "끝" }], { path: `/k?m=${m}` });
        const f1 = (await fills(h)).at(-1);
        const [rk, rt] = resultsOf(f1);
        expect(!rk.applied && has(rk, MSG_CLICK) && !rk.refillOnce, `${m}: click 단계 안내(${show(rk)})`);
        expect(has(rt, MSG_HALTED), `${m}: 남은 칸 안내(${show(rt)})`);
        const ev = await events(h);
        expect(ev.k1.click === 1 && ev.k1.input === 0 && ev.k1.change === 0 && ev.t.input === 0, `${m}: 이벤트(${show(ev)})`);
        await noValues(h);
      }
    },
  },
  {
    name: "#317 R2c checkbox: input 처리기가 체크를 되돌리고 행 안내를 그리면 토글 input 단계 안내·refillOnce 없음, 뒤 칸은 남은 칸 안내",
    pages: { "/k": CHECKS },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findF, { fillMany: [{ label: "동의1", value: "true" }, { label: "메모", value: "fake-t-317" }] }, { text: "끝" }], { path: "/k?m=inputrevert" });
      const f1 = (await fills(h)).at(-1);
      const [rk, rt] = resultsOf(f1);
      expect(!rk.applied && has(rk, MSG_TOGGLE_INPUT) && !rk.refillOnce, `토글 input 단계 안내(${show(rk)})`);
      expect(has(rt, MSG_HALTED) && !rt.refillOnce, `뒤 칸 안내(${show(rt)})`);
      const ev = await events(h);
      expect(ev.k1.click === 1 && ev.k1.input === 1 && ev.k1.change === 0 && ev.t.input === 0, `이벤트(${show(ev)})`);
    },
  },
  {
    name: "#317 R3·R4 행 식별 글자가 바뀌거나 칸 이름이 바뀌면 지금 문구 그대로(refillOnce 없음, 남은 칸 지금 문구)",
    pages: { "/t": TAGGED },
    async run(h) {
      await h.settings({ autoApprove: true });
      for (const m of ["retag", "rename"]) {
        await h.turn([findF, FILL3T, { text: "끝" }], { path: `/t?m=${m}` });
        const f1 = (await fills(h)).at(-1);
        const [ra, rb] = resultsOf(f1);
        expect(ra && rb, `${m}: 채우기 결과(${show({ f1, finds: (await finds(h)).at(-1) })})`);
        expect(!ra.applied && has(ra, OLD_GUARD) && !has(ra, MSG_INPUT) && !ra.refillOnce, `${m}: 지금 문구(${show(ra)})`);
        expect(has(rb, OLD_HALTED), `${m}: 남은 칸 지금 문구(${show(rb)})`);
        const ev = await events(h);
        expect(ev.a.input === 1 && ev.a.change === 0 && ev.b.input === 0, `${m}: 이벤트(${show(ev)})`);
      }
    },
  },
  {
    name: "#317 R5 제출 위험: 안내와 함께 action이 바뀌어도 지금처럼 막히고, 숨은 값만 결제로 바뀌면 지금 위험 문구 그대로",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      // R5a: 기술이 달라 곧바로 막는 지금 흐름 그대로. 제출 주소(action)가 바뀌었으므로 행 안내 문구·refillOnce가 아니라 지금 문구.
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=action" });
      let f1 = (await fills(h)).at(-1);
      let [ra, rb] = resultsOf(f1);
      let ev = await events(h);
      expect(!ra.applied && has(ra, OLD_GUARD) && !has(ra, MSG_INPUT) && !ra.refillOnce, `R5a 막힘·지금 문구(${show(ra)})`);
      expect(!rb.applied && ev.a.change === 0 && ev.b.input === 0 && ev.c.input === 0, `R5a 남은 칸 멈춤(${show({ rb, ev })})`);
      // R5b: 행 글자는 그대로, 숨은 값으로 제출 쿼리에 결제 신호 → driftReason의 지금 문구.
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=hiddenpay" });
      f1 = (await fills(h)).at(-1);
      [ra, rb] = resultsOf(f1);
      ev = await events(h);
      expect(!ra.applied && /결제·개인정보 주소로 바뀌어 채우지 않았습니다/.test(ra.note ?? "") && !ra.refillOnce, `R5b 위험 문구(${show(ra)})`);
      expect(has(rb, OLD_HALTED) && ev.a.change === 0 && ev.b.input === 0, `R5b 남은 칸 위험 문구(${show({ rb, ev })})`);
    },
  },
  {
    name: "#317 R6 묶음 뒤 칸: 앞 칸 입력이 뒤 칸 행에 안내를 그리면 그 칸만 쓰기 전 안내로 건너뛰고 셋째는 채운다 · 위험이 함께면 지금처럼 위험 중단",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=next" });
      let f1 = (await fills(h)).at(-1);
      let [ra, rb, rc] = resultsOf(f1);
      let ev = await events(h);
      expect(ra.applied === true, `첫 칸 통과(${show(ra)})`);
      expect(!rb.applied && has(rb, MSG_PRE_WRITE) && !rb.refillOnce && ev.b.input === 0, `둘째 쓰기 전 안내(${show({ rb, ev })})`);
      expect(rc.applied === true && ev.c.change === 1, `셋째 통과(${show({ rc, ev })})`);
      // R6b: 첫 칸 change 처리기가 둘째 칸 행의 안내와 양식 action을 함께 바꿈 → 둘째 칸 takeApproved가 지금처럼 위험 오류.
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=change-next-risk" });
      f1 = (await fills(h)).at(-1);
      [ra, rb, rc] = resultsOf(f1);
      ev = await events(h);
      expect(ev.a.change === 1, `첫 칸 change 1(${show(ev)})`);
      expect(!rb.applied && /승인한 뒤 대상이 바뀌어 실행하지 않았습니다/.test(rb.note ?? "") && !has(rb, MSG_PRE_WRITE) && !rb.refillOnce, `둘째 위험 문구(${show(rb)})`);
      expect(has(rc, OLD_HALTED) && ev.b.input === 0 && ev.c.input === 0, `셋째 위험 중단(${show({ rc, ev })})`);
    },
  },
  {
    name: "#317 R7·R8 반영 확인 단계의 안내(다시 채우라는 글 없음) · 숨은 글자만 늘면 지금 문구",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findF, { fill: "Domain", value: "fake-b-317" }, { text: "끝" }], { path: "/r?m=late" });
      let f1 = (await fills(h)).at(-1);
      let [rb] = resultsOf(f1);
      let ev = await events(h);
      expect(!rb.applied && has(rb, MSG_REASON) && /확인하지 못했습니다/.test(rb.note ?? "") && !rb.refillOnce && !/한 번 다시 채울/.test(rb.note ?? ""), `R7 반영 확인 안내(${show(rb)})`);
      expect(ev.b.change === 1, `R7 change는 보냄(${show(ev)})`);
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=hiddenonly" });
      f1 = (await fills(h)).at(-1);
      const [ra] = resultsOf(f1);
      ev = await events(h);
      expect(!ra.applied && has(ra, OLD_GUARD) && !ra.refillOnce && ev.a.change === 0, `R8 지금 문구(${show(ra)})`);
    },
  },
  {
    name: "#317 R10·R11 안내와 함께 제출 주소가 같은 사이트의 다른 레코드로 바뀌면 재시도 안내 없음 · 요소 사이 공백 없는 안내도 알아본다",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      // R10: 행 글자는 더해지기만 했지만 양식 action이 바뀜 → 지금처럼 막히고, 위험 신호가 바뀌었으므로 지금 문구·refillOnce 없음.
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=record" });
      let f1 = (await fills(h)).at(-1);
      let [ra, rb] = resultsOf(f1);
      let ev = await events(h);
      expect(!ra.applied && has(ra, OLD_GUARD) && !has(ra, MSG_INPUT) && !ra.refillOnce, `R10 지금 문구(${show(ra)})`);
      expect(has(rb, OLD_HALTED) && ev.a.change === 0 && ev.b.input === 0, `R10 남은 칸 멈춤(${show({ rb, ev })})`);
      // R10b: 행 글자는 더해지기만 했지만 같은 양식의 숨은 레코드 번호가 바뀜(일반 숫자 — 위험 신호 아님) → 지금 문구·refillOnce 없음.
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=hiddenrec" });
      f1 = (await fills(h)).at(-1);
      [ra, rb] = resultsOf(f1);
      ev = await events(h);
      expect(!ra.applied && has(ra, OLD_GUARD) && !has(ra, MSG_INPUT) && !ra.refillOnce && ev.a.change === 0, `R10b 지금 문구(${show(ra)})`);
      // R11: 'Domain' 뒤 빈 안내 영역에 공백 없이 글자가 생김(원문 textContent는 붙고 화면 글자는 띄워짐) → 안내 문구.
      await h.turn([findF, { fill: "Domain", value: "fake-b-317" }, { text: "끝" }], { path: "/r?m=tight" });
      f1 = (await fills(h)).at(-1);
      [rb] = resultsOf(f1);
      expect(!rb.applied && has(rb, MSG_INPUT) && rb.refillOnce === true, `R11 안내(${show(rb)})`);
    },
  },
  {
    name: "#317 R9 안내가 넣은 값을 되비춰도 채우기 결과·오류에 값이 없다(#43)",
    pages: { "/r": ROWS },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findF, FILL3, { text: "끝" }], { path: "/r?m=echo" });
      const f1 = (await fills(h)).at(-1);
      expect(has(resultsOf(f1)[0], MSG_INPUT), `안내 문구(${show(f1)})`);
      await noValues(h);
    },
  },
];
