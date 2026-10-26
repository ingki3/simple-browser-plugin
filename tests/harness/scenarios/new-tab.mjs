// 클릭으로 열린 일반 새 탭 따라가기: 브라우저가 같은 창의 앞에 띄운 새 탭 하나면 이후 도구가 그 탭에서 동작한다.
import { expect, okResult } from "../lib.mjs";

const findC = { tool: "find_clickables", args: {} };
const describe = { tool: "describe_page", args: {} };

const LINK_PAGE = `<title>가게</title><main><a href="/booking" target="_blank">예약</a><p id=out></p></main>`;
const BOOKING_PAGE = `<title>예약 화면</title><main><h1>예약</h1><button>시간 보기</button></main>`;

// 이 탭·패널 밖의 탭·창을 닫는다. 앞 시나리오가 남긴 팝업 창이 마지막 포커스 창이면 따라간 탭이 앞에 보이지 않는
// 것으로 판정되므로 시작 전에도 닫고, 끝난 뒤에도 닫는다(다음 시나리오에 남지 않게).
async function closeExtraTabs(h) {
  for (const p of h.ctx.pages()) if (p !== h.tab && p !== h.panel) await p.close().catch(() => {});
  await h.tab.bringToFront();
}

export default [
  {
    name: "target=_blank 링크로 앞에 열린 새 탭을 따라간다",
    pages: { "/shop": LINK_PAGE, "/booking": BOOKING_PAGE },
    async run(h) {
      await closeExtraTabs(h);
      await h.settings({ autoApprove: true });
      try {
        const r = await h.turn([findC, { click: "예약" }, describe], { path: "/shop" });
        const click = okResult(r, "click_element");
        const opened = click.effect?.popup?.opened;
        expect(opened?.followed && opened?.newTab, `새 탭을 따라가야 한다(${JSON.stringify(click.effect?.popup)})`);
        expect(String(click.note).includes("새 탭에서 동작"), `결과 문구(${click.note})`);
        const page = okResult(r, "describe_page");
        expect(page.title === "예약 화면", `도구가 새 탭을 읽어야 한다(title='${page.title}')`);
      } finally {
        await closeExtraTabs(h);
      }
    },
  },
  {
    name: "새 탭을 따라간 다음 턴에 그 탭이 닫혀 있으면 원래 탭에서 시작한다",
    pages: { "/shop": LINK_PAGE, "/booking": BOOKING_PAGE },
    async run(h) {
      await closeExtraTabs(h);
      await h.settings({ autoApprove: true });
      try {
        await h.turn([findC, { click: "예약" }, describe], { path: "/shop" });
        await closeExtraTabs(h);
        const r = await h.turn([describe], { noReload: true });
        const page = okResult(r, "describe_page");
        expect(page.title === "가게", `원래 탭을 읽어야 한다(title='${page.title}')`);
      } finally {
        await closeExtraTabs(h);
      }
    },
  },
];
