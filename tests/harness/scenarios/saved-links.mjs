// 저장 링크(0.2.4·0.2.9): 이 페이지 기억하기 → AI로 채우기(#129) → 초안(요청·답·화면 글자 반영) → 저장 → open_saved_link로 자리 값만 넣어 열기.
import { expect, lastTool } from "../lib.mjs";

const search = `<title>가격 검색</title><main><h1>검색 결과</h1><p>최저가 상품 목록</p><input id=memo value="비밀메모"><p id=out></p></main>`;

async function saveFromOffer(h) {
  await h.sw.evaluate(() => {
    globalThis.__draft = {
      name: "가격 검색",
      purpose: "쇼핑을 위한 가격 비교 검색",
      params: [
        { index: 0, mode: "slot", slot: "상품명", hint: "검색할 상품 이름" },
        { index: 1, mode: "drop" },
      ],
    };
  });
  const r = await h.turn(
    [{ tool: "navigate_to_url", args: { url: `${h.base}/s?q=${encodeURIComponent("맥북 에어")}&trk=abc` } }, { tool: "describe_page", args: {} }, { text: "찾았습니다." }],
    { text: "맥북 에어 최저가 찾아줘" },
  );
  await h.panel.waitForTimeout(500);
  const btn = h.panel.getByText("이 페이지 기억하기");
  expect((await btn.count()) === 1, "저장 제안 버튼이 떠야 한다");
  await btn.click();
  await h.panel.waitForTimeout(300);
  expect((await h.sw.evaluate(() => (globalThis.__draftReqs ?? []).length)) === 0, "카드를 여는 것만으로는 초안을 묻지 않는다");
  await h.panel.getByText("AI로 이름·용도 채우기").click();
  await h.panel.waitForTimeout(1200);
  const req = await h.sw.evaluate(() => globalThis.__draftReqs.at(-1));
  const content = req?.messages?.[0]?.content ?? "";
  const data = JSON.parse(content.slice(content.indexOf("데이터:\n") + 4));
  await h.panel.locator(".page-offer.open .btn-approve").click();
  await h.panel.waitForTimeout(500);
  const saved = await h.sw.evaluate(async () => (await chrome.storage.local.get("savedPages")).savedPages);
  return { r, data, saved };
}

export default [
  {
    name: "기억하기: 초안에 요청·답·화면 글자를 보내고 입력값은 빼며, 자리·빼기를 반영해 저장",
    pages: { "/s": search },
    async run(h) {
      await h.settings({ autoApprove: true });
      const { data, saved } = await saveFromOffer(h);
      expect(data.request === "맥북 에어 최저가 찾아줘", `요청(${data.request})`);
      expect(data.answer === "찾았습니다.", `답(${data.answer})`);
      expect(data.page.includes("최저가 상품 목록"), `화면 글자(${data.page})`);
      expect(!data.page.includes("비밀메모"), "입력 칸 값은 보내면 안 된다");
      expect(saved?.length === 1, `1개 저장(${JSON.stringify(saved)})`);
      const t = saved[0].template;
      expect(t.params.length === 1 && t.params[0].slot === "상품명", `자리만 남고 추적 값은 빠짐(${JSON.stringify(t)})`);
    },
  },
  {
    name: "open_saved_link: 자동 실행이면 카드 없이 자리 값을 넣어 연다",
    pages: { "/s": search },
    async run(h) {
      await h.settings({ autoApprove: true });
      const { saved } = await saveFromOffer(h);
      const r = await h.turn([{ tool: "open_saved_link", args: { id: saved[0].id, values: { 상품명: "아이패드" } } }, { text: "열었습니다" }]);
      expect(!r.stoppedAtCard, "카드가 뜨면 안 된다");
      expect(decodeURIComponent(new URL(r.url).search) === "?q=아이패드", `연 주소(${r.url})`);
    },
  },
  {
    name: "open_saved_link: 자리 값이 개인정보 모양이면 카드로 묻는다",
    pages: { "/s": search },
    async run(h) {
      await h.settings({ autoApprove: true });
      const { saved } = await saveFromOffer(h);
      const r = await h.turn([{ tool: "open_saved_link", args: { id: saved[0].id, values: { 상품명: "user@example.com" } } }]);
      expect(r.stoppedAtCard, "개인정보 모양 값은 카드가 떠야 한다");
    },
  },
  {
    name: "open_saved_link: 없는 id는 오류",
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([{ tool: "open_saved_link", args: { id: "nope", values: {} } }, { text: "끝" }]);
      const t = lastTool(r, "open_saved_link");
      expect(t?.error, `오류여야 한다(${JSON.stringify(t)})`);
    },
  },
];
