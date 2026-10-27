// 실행 방식(#123): '처음에 승인 받고 끝까지 실행'은 작업 맡기기 카드로 한 번 묻고, 맡기면 이 대화 동안 승인 카드 없이 실행한다.
import { expect, lastTool, okResult } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };
const confirm = { tool: "confirm_task", args: { summary: "필터를 적용하고 결제까지 진행", risks: ["결제 버튼을 누릅니다"] } };

const modelSaw = (h, needle) =>
  h.sw.evaluate((n) => (globalThis.__modelReqs ?? []).some((r) => JSON.stringify(r.body).includes(n)), needle);

export default [
  {
    name: "맡기기 방식: 작업 맡기기 카드 한 번 뒤 결제 버튼까지 카드 없이 실행하고, 다음 요청도 묻지 않는다",
    async run(h) {
      await h.settings({ runMode: "task" });
      const seen = [];
      const r = await h.turn([confirm, findC, { click: "결제하기" }], {
        text: "결제까지 해줘",
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1, `카드는 작업 맡기기 한 번(실제 ${r.cards})`);
      expect(seen[0].includes("작업 맡기기") && seen[0].includes("결제까지 해줘"), `요청 원문이 보여야 한다(${seen[0]})`);
      expect(seen[0].includes("결제 버튼을 누릅니다"), `모델이 넘긴 위험이 보여야 한다`);
      expect(r.out === "결제됨", `결제 버튼까지 실행돼야 한다(out='${r.out}')`);
      expect(await modelSaw(h, "아직 작업을 맡기지 않았다"), "맡기기 전 요청에 실행 방식 안내가 붙어야 한다");
      expect(await h.panel.locator(".task-bar").count(), "입력창 위에 맡김 표시가 보여야 한다");

      const r2 = await h.turn([findC, { click: "적용" }], { noReload: true, text: "필터도" });
      expect(r2.cards === 0 && !r2.stoppedAtCard, "맡긴 대화의 다음 요청은 묻지 않는다");
      expect(r2.out?.startsWith("필터됨"), `실행돼야 한다(out='${r2.out}')`);
    },
  },
  {
    name: "맡기기 방식: confirm_task 없이 승인이 필요한 동작을 부르면 그 동작으로 맡기기 카드를 띄운다",
    async run(h) {
      await h.settings({ runMode: "task" });
      const seen = [];
      const r = await h.turn([findC, { click: "적용" }], {
        onCard: async (card) => {
          seen.push(await card.innerText());
          await card.locator(".btn-approve").click();
        },
      });
      expect(r.cards === 1, `카드 1개(실제 ${r.cards})`);
      expect(seen[0].includes("작업 맡기기") && seen[0].includes("첫 동작"), `첫 동작을 할 일로 보여야 한다(${seen[0]})`);
      expect(r.out?.startsWith("필터됨"), `맡긴 뒤 실행돼야 한다(out='${r.out}')`);
    },
  },
  {
    name: "맡기기 방식: 맡기지 않으면 실행하지 않고, 해제하면 다시 묻는다",
    async run(h) {
      await h.settings({ runMode: "task" });
      const r = await h.turn([findC, confirm], { onCard: (card) => card.locator(".btn-cancel").click() });
      const t = lastTool(r, "confirm_task");
      expect(t?.error === "user_cancelled", `거절은 취소로 알린다(${JSON.stringify(t)})`);
      expect(!(await h.panel.locator(".task-bar").count()), "맡기지 않았으면 표시가 없어야 한다");

      const r2 = await h.turn([confirm, findC, { click: "적용" }], { noReload: true, approve: true });
      expect(r2.cards === 1 && r2.out?.startsWith("필터됨"), `맡기고 실행(cards=${r2.cards}, out='${r2.out}')`);
      await h.panel.locator(".task-bar button").click();
      await h.panel.waitForTimeout(300);
      const r3 = await h.turn([findC, { click: "적용" }]);
      expect(r3.stoppedAtCard, "해제한 뒤에는 다시 묻는다");
    },
  },
  {
    name: "맡기기 방식: 다른 방식으로 바꾸면 맡긴 작업을 거두고 평소 규칙으로 묻는다",
    async run(h) {
      await h.settings({ runMode: "task" });
      await h.turn([confirm, findC, { click: "적용" }], { approve: true });
      await h.settings({ runMode: "auto" });
      const r = await h.turn([findC, { click: "결제하기" }], { noReload: true });
      expect(r.stoppedAtCard, "자동 실행 방식에서 결제 버튼은 묻는다");
      expect(r.out !== "결제됨", "실행되면 안 된다");
    },
  },
  {
    name: "맡기기 방식: 동작 없이 다른 방식으로 바꿨다 돌아와도 다시 묻는다",
    async run(h) {
      await h.settings({ runMode: "task" });
      await h.turn([confirm, findC, { click: "적용" }], { approve: true });
      expect(await h.panel.locator(".task-bar").count(), "맡김 표시");
      await h.settings({ runMode: "ask" });
      await h.panel.waitForTimeout(300);
      expect(!(await h.panel.locator(".task-bar").count()), "바꾸는 즉시 맡김 표시가 사라져야 한다");
      await h.settings({ runMode: "task" });
      const r = await h.turn([findC, { click: "결제하기" }], { noReload: true });
      expect(r.stoppedAtCard, "다시 맡길지 물어야 한다");
      expect(r.out !== "결제됨", "실행되면 안 된다");
    },
  },
  {
    name: "맡기기 방식: 카드가 열린 사이 방식을 바꾸면 그 카드는 취소되고, 돌아와도 다시 묻는다",
    async run(h) {
      await h.settings({ runMode: "task" });
      const r = await h.turn([findC, { click: "결제하기" }], {
        onCard: async (card) => {
          await h.settings({ runMode: "ask" });
          await h.panel.waitForTimeout(300);
          await h.settings({ runMode: "task" });
          await h.panel.waitForTimeout(300);
          // 이미 거둔 카드라 눌러도(눌리지 않아도) 맡겨지지 않아야 한다.
          await card.locator(".btn-approve").click({ timeout: 1000 }).catch(() => {});
        },
      });
      expect(r.out !== "결제됨", `거둔 카드로 실행되면 안 된다(out='${r.out}')`);
      expect(!(await h.panel.locator(".task-bar").count()), "맡김 표시가 없어야 한다");
      const r2 = await h.turn([findC, { click: "결제하기" }], { noReload: true });
      expect(r2.stoppedAtCard && r2.out !== "결제됨", "다시 맡길지 물어야 한다");
    },
  },
  {
    name: "실행 방식: 입력창 아래에서 고르면 설정에 저장된다",
    async run(h) {
      await h.panel.selectOption("#run-mode-select", "task");
      await h.panel.waitForTimeout(400);
      const mode = await h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.runMode);
      expect(mode === "task", `runMode=${mode}`);
      const r = await h.turn([{ tool: "confirm_task", args: { summary: "x", risks: [] } }], { onCard: (c) => c.locator(".btn-cancel").click() });
      expect(r.cards === 1, "선택한 방식으로 묻는다");
      await h.panel.selectOption("#run-mode-select", "ask");
      await h.panel.waitForTimeout(400);
      const r2 = await h.turn([{ tool: "confirm_task", args: { summary: "x", risks: [] } }]);
      const res = okResult(r2, "confirm_task");
      expect(String(res.note).includes("아닙니다"), `다른 방식이면 맡기지 않는다(${JSON.stringify(res)})`);
    },
  },
];
