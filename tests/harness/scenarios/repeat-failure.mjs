// 같은 호출의 같은 실패 반복(#318): 같은 도구·같은 인자·같은 원인으로 거듭 실패하면 두 번째 결과부터 방법을 바꾸라는 안내(repeated)를
// 붙인다. 안내만 한다 — 이 셈으로 호출을 막거나 턴을 끝내지 않는다. 다른 대상의 성공(Dismiss)이 사이에 끼어도 이어서 센다(기존 헛돌기
// 감지가 놓친 순환). 다른 인자·같은 호출의 성공·새 요청은 세지 않는다.
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

// 항목 목록 안의 막히는 버튼(찾기 모드를 번갈아 써도 같은 호출로 세는지).
const ITEMS = `<title>항목 목록</title><main>
<input id=memo aria-label="메모">
<button id=dismiss style="width:120px;height:32px">Dismiss</button>
<ul>
<li><span>레코드 1</span> <div role=button tabindex=0 aria-label="보기" style="display:inline-block;width:120px;height:32px;background:#eee">▼</div></li>
<li><span>레코드 2</span> <div id=b role=button tabindex=0 aria-label="펼치기" style="display:inline-block;width:120px;height:32px;background:#ddd">▼</div></li>
<li><span>레코드 3</span> <div role=button tabindex=0 aria-label="보기" style="display:inline-block;width:120px;height:32px;background:#eee">▼</div></li>
</ul>
<p id=out></p>
<script>
memo.value = ${JSON.stringify(SECRET)};
b.addEventListener("mousedown", (e) => { e.preventDefault(); b.setAttribute("aria-label", "접기"); });
dismiss.addEventListener("click", () => { b.setAttribute("aria-label", "펼치기"); out.textContent = "닫음"; });
</script></main>`;
const itemsFind = { tool: "find_clickables", args: { mode: "items" } };

// 닫을 때마다 문서 제목이 결제 문구를 넣었다 뺐다 하는 변형(낱말 판정이 셈을 바꾸지 않아야 함).
const TITLE_TOGGLE = PAGE.replace("<title>반복 실패</title>", "<title>알림</title>").replace(
  'out.textContent = "닫음 " + (++window.__dismiss);',
  'out.textContent = "닫음 " + (++window.__dismiss); document.title = document.title === "알림" ? "결제 알림" : "알림";',
);

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

const noStop = (r) => !r.logs.some((l) => l.includes("hop:spin") || l.includes("same_failure"));

export default [
  {
    name: "같은 대상이 같은 원인으로 거듭 실패하면 두 번째 결과부터 안내하고, 멈추지 않는다(사이에 다른 대상 성공)",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn(
        [findC, show("call_s"), findC, dismiss, findC, show("call_s"), findC, dismiss, findC, show("call_s"), { text: "끝까지 감" }],
        { path: "/p" },
      );
      expect(clickFails(r) === 3, `Show 실패 3번(${clickFails(r)})`);
      const dismissed = await h.tab.evaluate(() => window.__dismiss);
      expect(dismissed === 2, `Dismiss 2번 성공(${dismissed})`);
      const opened = r.tools.some((t) => t.name === "find_clickables" && JSON.stringify(t.result ?? "").includes("Hide options"));
      expect(opened, "그 사이 찾기에 열린 이름(Hide options)으로 나온다");
      const { body, tools } = await lastToolMessages(h);
      expect(body.tool_choice !== "none", `도구 없이 답하는 마무리 요청이 없다(${JSON.stringify(body.tool_choice)})`);
      const s = tools.filter((t) => t.id === "call_s");
      expect(s.length === 3, `Show 결과 3개(${s.length})`);
      expect(s[0].data.repeated === undefined, `첫 결과는 그대로(${JSON.stringify(s[0].data).slice(0, 200)})`);
      expect(typeof s[1].data.repeated === "string" && s[1].data.repeated.includes("같은 도구(click_element)") && s[1].data.repeated.includes("2번 실패"), `두 번째 결과에 안내(${s[1].data.repeated})`);
      expect(typeof s[2].data.repeated === "string" && s[2].data.repeated.includes("3번 실패"), `세 번째 결과에 안내(${s[2].data.repeated})`);
      expect(!s[2].data.repeated.includes("멈춥니다"), "멈춘다는 말은 없다");
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `Show는 같은 인자로 세 번(${args.join(" | ")})`);
      const repeatLogs = r.logs.filter((l) => l.includes("hop:repeat_fail"));
      expect(repeatLogs.length === 2 && repeatLogs.every((l) => /hop:repeat_fail\W+click_element ×[23]\s*$/.test(l)), `로그는 도구 이름과 수만(${repeatLogs.join(" | ")})`);
      expect(noStop(r), "같은 실패로 멈추지 않는다");
      expect((await panelBody(h)).includes("끝까지 감"), "마지막 예정 응답까지 감");
      expect(!r.logs.some((l) => l.includes("blocked:")), "원인 코드는 로그에 없다");
      expect(!JSON.stringify(await reqs(h)).includes("blocked:"), "원인 코드는 모델 요청에 없다");
      await noSecret(h, r);
    },
  },
  {
    name: "한 응답에 [같은 실패, 다른 성공]이 함께 와도 안내하고, 모든 호출을 실행한다",
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
          { text: "끝까지 감" },
        ],
        { path: "/p" },
      );
      expect(clickFails(r) === 3, `Show 실패 3번(${clickFails(r)})`);
      const dismissed = await h.tab.evaluate(() => window.__dismiss);
      expect(dismissed === 3, `Dismiss는 모두 실행(${dismissed})`);
      const { tools } = await lastToolMessages(h);
      const s = tools.filter((t) => t.id === "call_s");
      expect(s.length === 3 && s[0].data.repeated === undefined && s[1].data.repeated && s[2].data.repeated, `Show 결과 안내(${s.map((x) => !!x.data.repeated).join(",")})`);
      for (const id of ["call_d2", "call_d3"]) {
        const d = tools.find((t) => t.id === id);
        expect(d && d.data.result && !d.data.error, `${id} 실행(${JSON.stringify(d?.data).slice(0, 120)})`);
      }
      expect(noStop(r), "같은 실패로 멈추지 않는다");
    },
  },
  {
    name: "한 응답 안에서 호출 id가 겹치면 뒤의 것에 새 id를 주어 실행하고, 다음 요청·다음 턴도 짝이 맞는다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings(settings);
      await h.turn(
        [findC, show(), findC, dismiss, findC, { clickMany: [{ text: "Show options", callId: "call_x" }, { text: "Dismiss", callId: "call_x" }] }, { text: "정리 답" }],
        { path: "/p" },
      );
      const dismissed = await h.tab.evaluate(() => window.__dismiss);
      expect(dismissed === 2, `겹친 id의 Dismiss도 실행(${dismissed})`);
      // 공통 짝 검사(run.mjs의 __badToolIds)가 다음 요청의 호출·결과 짝을 확인한다.
      const { body, tools } = await lastToolMessages(h);
      const lastCalls = (body.messages ?? []).filter((m) => m.role === "assistant" && m.tool_calls?.length).at(-1).tool_calls.map((c) => c.id);
      expect(lastCalls.length === 2 && lastCalls[0] === "call_x" && lastCalls[1] !== "call_x", `겹친 id는 뒤의 것만 새 id(${lastCalls.join(",")})`);
      const first = tools.find((t) => t.id === lastCalls[0]);
      const second = tools.find((t) => t.id === lastCalls[1]);
      expect(first?.data.result?.error && typeof first.data.repeated === "string", `첫째는 Show 실패 + 안내(${JSON.stringify(first?.data).slice(0, 160)})`);
      expect(second?.data.result && !second.data.error, `둘째는 Dismiss 실행 결과(${JSON.stringify(second?.data).slice(0, 160)})`);
      expect((await panelBody(h)).includes("정리 답"), "답을 받는다");
      await h.turn([{ text: "다음 턴 답" }], { path: "/p", noReload: true });
      expect((await panelBody(h)).includes("다음 턴 답"), "다음 턴 답");
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
    name: "찾기 모드를 번갈아 써도(list → items → list) 같은 버튼의 같은 실패를 이어 센다",
    pages: { "/items": ITEMS },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn(
        [findC, { click: "펼치기" }, findC, dismiss, itemsFind, { clickItem: "레코드 2", target: "펼치기" }, findC, dismiss, findC, { click: "펼치기" }, { text: "끝까지 감" }],
        { path: "/items" },
      );
      expect(clickFails(r) === 3, `펼치기 실패 3번(${clickFails(r)})`);
      const args = await sentClickArgs(h);
      expect(args.length === 5 && args[0] === args[2] && args[2] === args[4], `같은 id(${args.join(" | ")})`);
      const fails = clickResults(r).filter((t) => t.result?.error);
      expect(fails.length === 3 && fails[0].repeated === undefined && typeof fails[1].repeated === "string" && typeof fails[2].repeated === "string", `두·세 번째에 안내(${fails.map((t) => !!t.repeated).join(",")})`);
      expect(noStop(r), "멈추지 않는다");
    },
  },
  {
    name: "닫을 때마다 문서 제목의 결제 문구가 바뀌어도 같은 대상의 같은 실패를 이어 센다(낱말 판정은 셈에 쓰지 않음)",
    pages: { "/t": TITLE_TOGGLE },
    async run(h) {
      await h.settings(settings);
      const r = await h.turn([findC, show(), findC, dismiss, findC, show(), findC, dismiss, findC, show(), { text: "끝까지 감" }], { path: "/t", approve: true });
      expect(clickFails(r) === 3, `Show 실패 3번(${clickFails(r)})`);
      const fails = clickResults(r).filter((t) => t.result?.error);
      expect(fails.length === 3 && fails[0].repeated === undefined && typeof fails[1].repeated === "string" && typeof fails[2].repeated === "string", `두·세 번째에 안내(${fails.map((t) => !!t.repeated).join(",")})`);
      expect(noStop(r), "멈추지 않는다");
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
    name: "한도 카드에 같은 호출 반복 실패 줄을 보이고, 이어 가면 같은 턴으로 이어 세되 안내만 한다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ ...settings, maxToolHops: 6, maxToolHopsVersion: 2 });
      const seen = [];
      const r = await h.turn([findC, show(), findC, dismiss, findC, show(), findC, dismiss, findC, show(), { text: "끝까지 감" }], {
        path: "/p",
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1, `한도 카드 1번(${r.cards})`);
      expect(seen[0].includes("같은 호출 반복 실패: 누르기 2번"), `카드에 반복 실패 줄(${seen[0]})`);
      expect(!seen[0].includes(SECRET), "카드에 입력값 없음");
      expect(r.logs.some((l) => /hop:repeat_fail\W+click_element ×3/.test(l)), "이어 간 뒤 세 번째에도 이어 센다");
      expect(noStop(r) && (await panelBody(h)).includes("끝까지 감"), "멈추지 않고 마지막 예정 응답까지 감");
    },
  },
];
