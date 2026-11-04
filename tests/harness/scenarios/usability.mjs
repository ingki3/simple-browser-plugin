// 사용성 후속(#132): 승인 카드의 전체 보기, 진단 복사 전 가리기·미리보기, 저장 실패 때 직접 입력 상태, 연결 확인 오류의 원문.
import { expect } from "../lib.mjs";

const LONG = `긴메모-${"가나다라마바사".repeat(20)}-끝`;
const FILL = `<title>메모</title>
<form action="/save?email=me%40corp.test" method="get">
  <label>메모 <input name="memo" value="PAGE_TYPED_VALUE"></label>
  <div contenteditable="true">PAGE_EDIT_TEXT</div>
  <button>저장</button>
</form>
<div id="out"></div>`;

const ask = (h, msg) => h.panel.evaluate(async (m) => chrome.runtime.sendMessage(m), msg);

export default [
  {
    name: "전체 보기(#132): 잘린 값을 펼쳐 보이고 개인정보 주소 목록은 펼쳐도 그대로, 입력값·편집 글자는 없고 펼치기만으로 실행하지 않음",
    pages: { "/fill": FILL },
    async run(h) {
      await h.settings({ runMode: "auto" });
      let checked = false;
      const r = await h.turn([{ tool: "find_form_fields", args: {} }, { fill: "메모", value: LONG }, { text: "끝" }], {
        path: "/fill",
        onCard: async (card) => {
          if (checked) return;
          checked = true;
          const pre = card.locator(".tool-card-details");
          const summary = await pre.innerText();
          expect(!summary.includes(LONG) && summary.includes("긴메모-"), "요약은 잘림");
          expect(summary.includes("개인정보 모양이 걸린 주소") && summary.includes("email="), `요약에 주소 목록(${summary})`);
          await card.locator(".tool-card-full").click();
          const full = await pre.innerText();
          expect(full.includes(LONG), "전체 보기에 값 전체");
          expect(full.includes("개인정보 모양이 걸린 주소") && full.includes("email="), "전체 보기에도 주소 목록");
          expect((await card.locator(".btn-approve-urls").count()) === 1, "다시 묻지 않기 버튼 그대로");
          for (const t of [summary, full]) expect(!t.includes("PAGE_TYPED_VALUE") && !t.includes("PAGE_EDIT_TEXT"), "지금 값·편집 글자 없음");
          // 펼치기·접기는 표시만 바꾼다(실행·승인 없음).
          expect((await h.tab.locator("input[name=memo]").inputValue()) === "PAGE_TYPED_VALUE", "펼쳐도 입력하지 않음");
          await card.locator(".tool-card-full").click();
          expect((await pre.innerText()) === summary, "접으면 요약");
          await card.locator(".btn-cancel").click();
        },
      });
      expect(checked, "입력 카드");
      // 모델로 간 도구 결과에도 지금 값·편집 글자가 없고 라벨은 있다(#43).
      const sent = await h.sw.evaluate(() => JSON.stringify(globalThis.__modelReqs.map((q) => q.body.messages.filter((m) => m.role === "tool"))));
      expect(sent.includes("메모") && !sent.includes("PAGE_TYPED_VALUE") && !sent.includes("PAGE_EDIT_TEXT"), "도구 결과에 라벨만");
      void r;
    },
  },
  {
    name: "진단 복사(#132): 미리보기에서 주소 경로·이메일을 가리고, 연 순간의 글만 복사하며, 다시 열면 원문 복사가 꺼져 있다",
    async run(h) {
      await h.turn([{ tool: "find_clickables", args: { query: "me@corp.test https://shop.test/order/98765432?x=1" } }, { text: "끝" }]);
      await h.panel.evaluate(() => {
        window.__copied = [];
        navigator.clipboard.writeText = async (t) => void window.__copied.push(t);
      });
      await h.panel.locator(".debug-btn").click();
      await h.panel.getByRole("button", { name: "진단 복사" }).click();
      const box = h.panel.locator(".diag-preview");
      await box.waitFor({ timeout: 3000 });
      const shown = await box.locator(".diag-preview-body").innerText();
      expect(!shown.includes("me@corp.test") && shown.includes("[이메일]"), "이메일 가림");
      expect(!shown.includes("/order/98765432") && shown.includes("https://shop.test/…"), "주소 경로 가림");
      expect((await box.innerText()).includes("주소 1") || (await box.innerText()).includes("주소 "), "가린 것 개수");
      // 미리보기를 연 뒤 로그가 늘고 필터가 바뀌어도 복사하는 글은 연 순간의 것.
      const before = await h.panel.locator(".debug-row").count();
      await ask(h, { kind: "check_connection" });
      await h.panel.waitForTimeout(300);
      expect((await h.panel.locator(".debug-row").count()) > before, "미리보기 뒤 로그가 늘어남");
      await h.panel.locator(".debug-filter").fill("hop");
      await box.getByRole("button", { name: "복사" }).click();
      const copied = await h.panel.evaluate(() => window.__copied);
      expect(copied.length === 1 && copied[0] === shown, "연 순간의 가린 글을 복사");
      // 원문 복사를 켜고 닫았다 다시 열면 꺼져 있다.
      await box.locator("input[type=checkbox]").check();
      await h.panel.locator(".drawer-header .icon-btn").click();
      await h.panel.locator(".debug-btn").click();
      expect((await h.panel.locator(".diag-preview").count()) === 0, "닫으면 미리보기도 닫힘");
      await h.panel.getByRole("button", { name: "진단 복사" }).click();
      expect(!(await h.panel.locator(".diag-preview input[type=checkbox]").isChecked()), "원문 복사는 꺼진 채");
      await h.panel.locator(".drawer-header .icon-btn").click();
    },
  },
  {
    name: "직접 입력 상태(#132): 목록 밖 언어·모델에서 목록 값을 고르다 저장이 실패하면 직접 입력 칸이 옛 값으로 다시 열린다",
    async run(h) {
      await h.settings({ translationTargetLang: "nl", model: "vendor/custom-model" });
      // 서비스 워커의 저장을 한 번 실패하게 한다(settings_patch가 실패).
      await h.sw.evaluate(() => {
        const real = chrome.storage.local.set.bind(chrome.storage.local);
        globalThis.__failSet = 0;
        chrome.storage.local.set = async (...a) => {
          if (globalThis.__failSet > 0) {
            globalThis.__failSet--;
            throw new Error("저장 실패(시험)");
          }
          return real(...a);
        };
      });
      const opts = await h.openOptions("advanced");
      const lang = opts.locator('[data-section="advanced"] select').first();
      const langInput = opts.locator('input[placeholder^="언어 코드"]');
      expect((await langInput.inputValue()) === "nl", "목록 밖 언어는 직접 입력 칸");
      await h.sw.evaluate(() => (globalThis.__failSet = 1));
      await lang.selectOption("en");
      await opts.waitForTimeout(800);
      expect((await langInput.count()) === 1 && (await langInput.inputValue()) === "nl", "저장 실패 뒤 직접 입력 칸이 옛 값으로");
      expect((await lang.inputValue()) === "__custom__", "select는 직접 입력");
      // 일반 진입: 목록 값에서 직접 입력을 고르면 칸이 열린다.
      await lang.selectOption("ko");
      await opts.waitForTimeout(800);
      expect((await langInput.count()) === 0, "목록 값이면 칸 없음");
      await lang.selectOption("__custom__");
      expect((await langInput.count()) === 1 && (await langInput.inputValue()) === "ko", "직접 입력을 고르면 칸이 열림");

      await opts.goto(`${h.optionsUrl}#model`);
      await opts.waitForTimeout(400);
      const model = opts.locator('[data-section="model"] select').nth(1);
      const modelInput = opts.locator('input[placeholder^="provider/model"]');
      expect((await modelInput.inputValue()) === "vendor/custom-model", "목록 밖 모델은 직접 입력 칸");
      await h.sw.evaluate(() => (globalThis.__failSet = 1));
      await model.selectOption({ index: 0 });
      await opts.waitForTimeout(800);
      expect((await modelInput.count()) === 1 && (await modelInput.inputValue()) === "vendor/custom-model", "저장 실패 뒤 모델 직접 입력 칸이 옛 값으로");
      await opts.close();
    },
  },
  {
    name: "연결 확인(#132): 400 안내와 '자세히' 원문, 원문의 키는 가림, 연결 실패는 연결 안내, 확인 중 키를 바꾸면 옛 결과는 버림",
    async run(h) {
      const KEY = "sk-or-test-KEY123";
      await h.settings({ openRouterApiKey: KEY });
      const opts = await h.openOptions("model");
      const btn = opts.getByRole("button", { name: "연결 확인" });
      const result = async () => {
        await opts.waitForTimeout(600);
        return opts.locator('[data-section="model"]').innerText();
      };
      await h.sw.evaluate((k) => (globalThis.__checkReply = { status: 400, body: { error: { message: `bad model for ${k} (${k})` } } }), KEY);
      await btn.click();
      let text = await result();
      expect(text.includes("모델 이름이 맞는지"), "연결 확인용 400 안내");
      await opts.locator(".check-detail summary").click();
      const detail = await opts.locator(".check-detail pre").innerText();
      expect(detail.includes("[키]") && !detail.includes(KEY) && !text.includes(KEY), `원문의 키 가림(${detail})`);

      await h.sw.evaluate((k) => (globalThis.__checkReply = { status: 418, body: { error: { message: `teapot ${k}` } } }), KEY);
      await btn.click();
      text = await result();
      expect(text.includes("teapot [키]") && !text.includes(KEY), "안내가 없는 상태 코드도 키 가림");

      await h.sw.evaluate(() => (globalThis.__checkReply = { networkError: true }));
      await btn.click();
      text = await result();
      expect(text.includes("연결하지 못했습니다"), "연결 실패 안내");

      // 키 A로 확인하는 동안 키 B로 바꾸면 A의 늦은 결과는 보이지 않는다.
      await h.sw.evaluate((k) => (globalThis.__checkReply = { status: 400, delayMs: 1500, body: { error: { message: `late ${k}` } } }), KEY);
      await btn.click();
      const keyRow = opts.locator(".key-row", { has: opts.locator('input[placeholder="sk-or-v1-..."]') });
      await keyRow.locator("input").fill("sk-or-test-OTHER");
      await keyRow.locator("button.primary").click();
      await opts.waitForTimeout(2200);
      text = await opts.locator('[data-section="model"]').innerText();
      expect(!text.includes("late") && !text.includes(KEY), "옛 키의 늦은 결과는 버림");
      await opts.close();
    },
  },
];
