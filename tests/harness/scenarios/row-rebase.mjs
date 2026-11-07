// 같은 대상 연속 클릭(#233): 클릭이 바꾼 행·항목 글자를 결과로 보여 주고, 그 결과를 본 다음 응답부터만 그 상태를 기준으로 쓴다
// (같은 응답의 뒤 호출·다른 대화·기록을 비운 대화는 쓰지 못한다). 공용 기준은 다시 찾을 때만 바뀐다.
import { duringTurn, expect, findC, pollUntil } from "../lib.mjs";

const findF = { tool: "find_form_fields", args: {} };
const items = { tool: "find_clickables", args: { mode: "items" } };

// 장바구니 행 셋(같은 모양 — 항목 모드가 반복 항목으로 보게). 수량증가를 누르면 그 행의 합계가 바뀌고 #out에 누른 횟수가 오른다. 행 A에는 입력값·숨은 글자·편집 영역(#43).
const CART = `<title>장바구니</title><main><ul id=cart>
<li><span>상품 A</span> <button>수량증가</button> <span class=total>1,000원</span> <input aria-label=메모 value="비밀메모"> <span hidden>숨은글</span> <span contenteditable=true>편집글</span></li>
<li><span>상품 B</span> <button>수량증가</button> <span class=total>5,000원</span> <input aria-label=메모></li>
<li><span>상품 C</span> <button>수량증가</button> <span class=total>5,000원</span> <input aria-label=메모></li>
</ul><p id=out>0</p></main>
<script>
let clicks = 0;
document.querySelectorAll("#cart li").forEach((li, i) => {
  let q = 1;
  const unit = i ? 5000 : 1000;
  li.querySelector("button").addEventListener("click", () => {
    q += 1;
    clicks += 1;
    li.querySelector(".total").textContent = (unit * q).toLocaleString("en-US") + "원";
    document.getElementById("out").textContent = String(clicks);
  });
});
</script>`;

// 모델용 행 글자(200자)가 잘리는 긴 행. 누르면 200자 뒤쪽의 상품 이름만 바뀐다.
const LONG = `<title>긴 행</title><main><ul id=cart>
<li><span>${"설명 ".repeat(80)}</span><button>수량증가</button><span class=name>상품 C</span></li>
<li><span>다른 행</span><button>다른 버튼</button></li>
</ul><p id=out>0</p></main>
<script>
let clicks = 0;
document.querySelector("#cart button").addEventListener("click", () => {
  clicks += 1;
  document.querySelector(".name").textContent = "상품 D" + clicks;
  document.getElementById("out").textContent = String(clicks);
});
</script>`;

// 행마다 수량 입력 칸. 값을 바꾸면 그 행의 합계가 바뀐다.
const QTY = `<title>수량</title><main><ul id=cart>
<li><span>상품 A</span> <input aria-label="수량 A" value=1> <span class=total>1,000원</span></li>
<li><span>상품 B</span> <input aria-label="수량 B" value=1> <span class=total>5,000원</span></li>
</ul><p id=out></p></main>
<script>
document.querySelectorAll("#cart li").forEach((li, i) => {
  const unit = i ? 5000 : 1000;
  li.querySelector("input").addEventListener("input", (e) => {
    li.querySelector(".total").textContent = (unit * (Number(e.target.value) || 0)).toLocaleString("en-US") + "원";
  });
});
</script>`;

const DRIFT = "행의 내용이 찾은 뒤 바뀌었습니다";
const PROTECTED = /비밀메모|숨은글|편집글/;

// 마지막 모델 요청에 실린 도구 결과들(기록 순서). __toolLog는 요청마다 마지막 결과만 남겨 한 응답의 여러 호출을 볼 수 없다.
async function toolMessages(h) {
  const body = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1)?.body);
  return (body?.messages ?? []).filter((m) => m.role === "tool").map((m) => ({ name: m.name, ...JSON.parse(m.content) }));
}

const clicksOf = (msgs) => msgs.filter((m) => m.name === "click_element");
const isOk = (m) => m && !m.error && m.result;
const errText = (m) => String(m?.error ?? "");

// content가 만든 nonce가 모델 요청 어디에도 없다.
async function noNonce(h) {
  const all = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs.map((r) => r.body)));
  expect(!/rb-[0-9a-f]{24}/.test(all), "nonce가 모델 요청에 실림");
}

async function waitReqs(h, n) {
  const count = () => h.sw.evaluate(() => globalThis.__modelReqs.length);
  await pollUntil(async () => (await count()) >= n, { tries: 100, intervalMs: 50, label: `모델 요청 ${n}개`, detail: async () => `지금 ${await count()}개` });
}

export default [
  {
    name: "#233 클릭이 바꾼 행 글자를 결과로 보여 주고, 다음 응답의 같은 id 클릭은 그 상태로 통과(입력값·숨은 글자 없음, nonce 비노출)",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { click: "수량증가" }, { repeatLastClick: true }, { text: "끝" }], { path: "/c" });
      const find = (await toolMessages(h)).find((m) => m.name === "find_clickables");
      const target = (find.result.items ?? find.result).find((c) => c.text === "수량증가");
      expect(String(target?.context ?? "").includes("1,000원"), `행 문맥이 잡힘(${JSON.stringify(target)})`);
      const [c1, c2] = clicksOf(await toolMessages(h));
      expect(isOk(c1) && isOk(c2), `둘 다 성공(${JSON.stringify([c1, c2])})`);
      const row = String(c1.result.rowAfter ?? "");
      expect(row.includes("2,000원") && row.includes("상품 A"), `누른 뒤 행(${row})`);
      expect(!PROTECTED.test(row), `보호 글자 없음(${row})`);
      expect(r.out === "2", `두 번 눌림(${r.out})`);
      await noNonce(h);
    },
  },
  {
    name: "#233 한 응답의 같은 id 클릭 셋: 첫째만 실행되고 둘째·셋째는 row_drift(기준 갱신 없음), 다음 응답의 클릭은 통과",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { clickN: { text: "수량증가", n: 3 } }, { repeatLastClick: true }, { text: "끝" }], { path: "/c" });
      const [c1, c2, c3, c4] = clicksOf(await toolMessages(h));
      expect(isOk(c1), `첫째 성공(${JSON.stringify(c1)})`);
      expect(errText(c2).includes(DRIFT) && errText(c3).includes(DRIFT), `둘째·셋째 row_drift(${errText(c2)} / ${errText(c3)})`);
      expect(!PROTECTED.test(errText(c2)), `오류 문구에 보호 글자 없음(${errText(c2)})`);
      expect(isOk(c4), `다음 응답은 통과(${JSON.stringify(c4)})`);
      expect(r.out === "2", `실제 클릭 2번(${r.out})`);
      await noNonce(h);
    },
  },
  {
    name: "#233 항목 모드: 클릭이 항목 글자를 바꾸면 itemAfter(전체)가 오고 다음 응답의 클릭은 통과",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([items, { clickItem: "상품 A", target: "수량증가" }, { repeatLastClick: true }, { text: "끝" }], { path: "/c" });
      const [c1, c2] = clicksOf(await toolMessages(h));
      expect(isOk(c1) && isOk(c2), `둘 다 성공(${JSON.stringify([c1, c2])})`);
      const item = String(c1.result.itemAfter ?? "");
      expect(item.includes("2,000원") && !PROTECTED.test(item), `누른 뒤 항목(${item})`);
      expect(r.out === "2", `두 번 눌림(${r.out})`);
    },
  },
  {
    name: "#233 항목 모드 + 한 응답의 같은 id 클릭 둘: 다음 응답의 같은 id 클릭은 첫 클릭 결과의 기준으로 통과",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn(
        [items, { clickItem: "상품 A", target: "수량증가" }, { clickN: { n: 2 } }, { repeatLastClick: true }, { text: "끝" }],
        { path: "/c" },
      );
      const [c1, c2, c3, c4] = clicksOf(await toolMessages(h));
      expect(isOk(c1) && isOk(c2), `앞 두 번 성공(${JSON.stringify([c1, c2])})`);
      expect(errText(c3).includes("다시 찾으세요"), `같은 응답 둘째는 막힘(${errText(c3)})`);
      expect(isOk(c4), `다음 응답은 통과(${JSON.stringify(c4)})`);
      expect(r.out === "3", `실제 클릭 3번(${r.out})`);
    },
  },
  {
    name: "#233 클릭 뒤 행이 또 바뀌면(결과를 본 뒤 페이지가 바꿈) row_drift, 그 오류를 본 다음 응답은 통과",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      const turn = h.turn([findC, { click: "수량증가" }, { repeatLastClick: true, delayMs: 1500 }, { repeatLastClick: true }, { text: "끝" }], { path: "/c" });
      // 클릭 결과가 실린 요청(3번째)이 도착한 뒤(클릭 뒤 상태를 읽은 뒤) 행 합계를 바꾼다.
      await duringTurn(turn, async () => {
        await waitReqs(h, 3);
        await h.tab.evaluate(() => {
          document.querySelector("#cart li .total").textContent = "9,999원";
        });
      });
      const r = await turn;
      const [c1, c2, c3] = clicksOf(await toolMessages(h));
      expect(isOk(c1), `첫째 성공(${JSON.stringify(c1)})`);
      expect(errText(c2).includes(DRIFT) && errText(c2).includes("9,999원"), `둘째 row_drift(${errText(c2)})`);
      expect(isOk(c3), `셋째 통과(${JSON.stringify(c3)})`);
      expect(r.out === "2", `실제 클릭 2번(${r.out})`);
    },
  },
  {
    name: "#233 잘린 긴 행: 뒤쪽만 바뀌면 rowAfter도 기준도 없이 '다시 찾으세요', 다시 찾은 뒤 클릭은 통과",
    pages: { "/l": LONG },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([findC, { click: "수량증가" }, { repeatLastClick: true }, findC, { click: "수량증가" }, { text: "끝" }], { path: "/l" });
      const [c1, c2, c3] = clicksOf(await toolMessages(h));
      expect(isOk(c1) && c1.result.rowAfter === undefined, `첫째 성공·rowAfter 없음(${JSON.stringify(c1)})`);
      expect(errText(c2).includes("다시 찾으세요") && !errText(c2).includes(DRIFT), `둘째는 row_drift 아님(${errText(c2)})`);
      expect(isOk(c3), `다시 찾은 뒤 통과(${JSON.stringify(c3)})`);
      expect(r.out === "2", `실제 클릭 2번(${r.out})`);
    },
  },
  {
    name: "#233 대화 격리: 새 대화(같은 탭·같은 content script)는 앞 대화의 클릭 뒤 기준을 쓰지 못한다",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findC, { click: "수량증가" }, { text: "끝" }], { path: "/c" });
      const [c1] = clicksOf(await toolMessages(h));
      expect(isOk(c1) && c1.result.rowAfter, `첫 대화 클릭(${JSON.stringify(c1)})`);
      const id = (await h.sw.evaluate(() => globalThis.__modelReqs.at(-1).body.messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.function.name === "click_element").function.arguments));
      await h.panel.click("button[title='새 대화']");
      await h.panel.waitForTimeout(300);
      const r = await h.turn([{ tool: "click_element", args: JSON.parse(id) }, { text: "끝" }], { noReload: true });
      const [c2] = clicksOf(await toolMessages(h));
      expect(errText(c2).includes(DRIFT), `새 대화는 row_drift(${JSON.stringify(c2)})`);
      expect(r.out === "1", `새 대화에서는 누르지 않음(${r.out})`);
    },
  },
  {
    name: "#233 같은 대화의 기록 초기화(빠르게 생각 바꿈): 확정된 기준은 다음 턴에도 쓰이고, 기록을 비우면 쓰이지 않는다",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findC, { click: "수량증가" }, { text: "끝" }], { path: "/c" });
      const args = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1).body.messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.function.name === "click_element").function.arguments);
      const click = { tool: "click_element", args: JSON.parse(args) };
      // 같은 대화의 다음 턴: 앞 턴에 확정된 기준으로 통과(클릭 뒤 상태는 다시 새 기준).
      const r1 = await h.turn([click, { text: "끝" }], { noReload: true });
      expect(isOk(clicksOf(await toolMessages(h)).at(-1)) && r1.out === "2", `다음 턴 통과(${r1.out})`);
      // 빠르게 생각을 바꾸면 같은 대화 객체가 기록을 비운다 → 이전 기준을 쓰지 않는다.
      await h.settings({ quickThinking: true });
      const r2 = await h.turn([click, { text: "끝" }], { noReload: true });
      expect(errText(clicksOf(await toolMessages(h)).at(-1)).includes(DRIFT) && r2.out === "2", `기록을 비우면 row_drift(${r2.out})`);
    },
  },
  {
    name: "#233 중단: 클릭 결과를 실은 요청을 멈추면 기준은 확정되지 않고, 다시 요청해 응답이 오면 확정 · 기록을 비우면 버린다",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ autoApprove: true });
      // 클릭 뒤 다음 응답을 늦추고 그동안 멈춘다.
      // reqs: 이 턴에서 늦춘 응답의 요청이 몇 번째인지.
      const stopAfterClick = async (steps, opts, reqs) => {
        const base = await h.sw.evaluate(() => globalThis.__modelReqs.length);
        const turn = h.turn(steps, opts);
        await duringTurn(turn, async () => {
          await waitReqs(h, base + reqs);
          await h.panel.waitForTimeout(200);
          await h.panel.click("button.composer-btn.danger");
        });
        return turn;
      };
      await stopAfterClick([findC, { click: "수량증가" }, { text: "늦은 답", delayMs: 3000 }], { path: "/c" }, 3);
      const args = await h.sw.evaluate(() => globalThis.__modelReqs.at(-1).body.messages.flatMap((m) => m.tool_calls ?? []).find((c) => c.function.name === "click_element").function.arguments);
      const click = { tool: "click_element", args: JSON.parse(args) };
      // 멈춘 뒤 바로 다시 요청: 그 요청에 클릭 결과가 실리고 응답이 오면 확정 → 그 응답의 클릭은 통과.
      const r1 = await h.turn([click, { text: "끝" }], { noReload: true });
      expect(isOk(clicksOf(await toolMessages(h)).at(-1)) && r1.out === "2", `다시 요청하면 통과(${r1.out})`);
      // 다시 클릭(기준 S) 뒤 멈추고 기록을 비우면(빠르게 생각 바꿈) S는 쓰이지 않는다.
      await stopAfterClick([click, { text: "늦은 답", delayMs: 3000 }], { noReload: true }, 2);
      await h.settings({ quickThinking: true });
      await h.tab.waitForTimeout(3200);
      const r2 = await h.turn([click, { text: "끝" }], { noReload: true });
      expect(errText(clicksOf(await toolMessages(h)).at(-1)).includes(DRIFT) && r2.out === "3", `기록을 비우면 row_drift(${r2.out})`);
    },
  },
  {
    name: "#233 입력 칸: 합계가 바뀐 행의 칸은 row_drift, 다음 응답은 통과 · 묶음의 한 칸이 row_drift면 어느 칸에도 쓰지 않는다",
    pages: { "/q": QTY },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.turn([findF, { fill: "수량 A", value: "2" }, { refill: ["3"] }, { refill: ["4"] }, { text: "끝" }], { path: "/q" });
      const fills = (await toolMessages(h)).filter((m) => m.name === "fill_form_fields");
      expect(isOk(fills[0]) && errText(fills[1]).includes(DRIFT) && isOk(fills[2]), `입력·row_drift·통과(${JSON.stringify(fills)})`);
      expect((await h.tab.locator("#cart input").first().inputValue()) === "4", "마지막 값");
      // 묶음: 다시 찾은 뒤 A의 합계가 페이지에서 바뀌고 A·B를 함께 넣으면 A가 row_drift라 B에도 쓰지 않는다.
      const before = await h.sw.evaluate(() => globalThis.__modelReqs.length);
      const turn = h.turn([findF, { fillMany: [{ label: "수량 A", value: "5" }, { label: "수량 B", value: "7" }], delayMs: 1500 }, { text: "끝" }], { noReload: true });
      await duringTurn(turn, async () => {
        await waitReqs(h, before + 2);
        await h.tab.evaluate(() => {
          document.querySelector("#cart li .total").textContent = "8,888원";
        });
      });
      await turn;
      const batch = (await toolMessages(h)).filter((m) => m.name === "fill_form_fields").at(-1);
      expect(errText(batch).includes(DRIFT), `묶음은 row_drift(${JSON.stringify(batch)})`);
      const values = await h.tab.locator("#cart input").evaluateAll((els) => els.map((e) => e.value));
      expect(values[0] === "4" && values[1] === "1", `어느 칸에도 쓰지 않음(${values})`);
    },
  },
  {
    name: "#233 기준으로 승인 카드까지 간 뒤 행이 바뀌면 승인해도 실행하지 않는다",
    pages: { "/c": CART },
    async run(h) {
      await h.settings({ runMode: "ask" });
      const r = await h.turn([findC, { click: "수량증가" }, { repeatLastClick: true }, { text: "끝" }], {
        path: "/c",
        onCard: async (card, n) => {
          if (n === 2) {
            await h.tab.evaluate(() => {
              document.querySelector("#cart li .total").textContent = "7,777원";
            });
          }
          await card.locator(".btn-approve").click();
        },
      });
      const [c1, c2] = clicksOf(await toolMessages(h));
      expect(isOk(c1), `첫째 성공(${JSON.stringify(c1)})`);
      expect(errText(c2).includes("승인한 뒤 대상이 바뀌어 실행하지 않았습니다"), `승인 뒤 바뀜(${JSON.stringify(c2)})`);
      expect(r.out === "1", `한 번만 눌림(${r.out})`);
    },
  },
];
