// 저장 링크(0.2.4·0.2.9): 이 페이지 기억하기 → 초안 자동 요청(요청·답·화면 글자 반영, 일반적인 템플릿) → 저장 → open_saved_link로 자리 값만 넣어 열기.
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
  // 카드를 열면 초안을 자동으로 한 번 묻는다(사용자 결정으로 #129 변경).
  await h.panel.waitForTimeout(1200);
  expect((await h.sw.evaluate(() => (globalThis.__draftReqs ?? []).length)) === 1, "카드를 열면 초안을 한 번 묻는다");
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
      // 디버그 로그에 턴마다 붙인 후보 수·이름이 한 번 남는다(#156). 주소는 남기지 않는다.
      const lines = r.logs.filter((l) => l.includes("saved_links:candidates"));
      const last = lines.at(-1) ?? "";
      expect(last.includes("1개 · '가격 검색'"), `후보 로그(${JSON.stringify(lines)})`);
      expect(lines.filter((l) => l.includes("1개")).length === 1, `이 턴에 한 번만(${JSON.stringify(lines)})`);
      expect(!last.includes("/s?"), "주소는 남기지 않는다");
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
  {
    name: "자동 초안: 닫았다 다시 열어도 한 번만, 늦게 온 응답은 다시 열면 반영, 다시 채우기는 다시 묻는다",
    pages: { "/s": search },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.sw.evaluate(() => {
        globalThis.__draft = { name: "가격 검색", purpose: "상품을 검색해 가격을 비교", params: [{ index: 0, mode: "slot", slot: "상품명", hint: "검색할 상품 이름" }, { index: 1, mode: "drop" }] };
        globalThis.__draftDelayMs = 1500;
        globalThis.__draftReqs = [];
      });
      await h.turn([{ tool: "navigate_to_url", args: { url: `${h.base}/s?q=${encodeURIComponent("맥북")}&trk=abc` } }, { text: "찾았습니다." }], { text: "맥북 찾아줘" });
      await h.panel.waitForTimeout(500);
      await h.panel.getByText("이 페이지 기억하기").click();
      await h.panel.waitForTimeout(200);
      await h.panel.locator(".page-offer.open .btn-cancel").click();
      await h.panel.waitForTimeout(1800);
      await h.panel.getByText("이 페이지 기억하기").click();
      await h.panel.waitForTimeout(300);
      const reqs = () => h.sw.evaluate(() => globalThis.__draftReqs.length);
      expect((await reqs()) === 1, `한 번만(${await reqs()})`);
      const nameVal = await h.panel.locator(".page-offer.open input").first().inputValue();
      expect(nameVal === "가격 검색", `늦게 온 초안 반영(${nameVal})`);
      await h.sw.evaluate(() => { globalThis.__draftDelayMs = 0; });
      await h.panel.getByText("다시 채우기").click();
      await h.panel.waitForTimeout(800);
      expect((await reqs()) === 2, `다시 채우기(${await reqs()})`);
      const body = await h.sw.evaluate(() => JSON.stringify(globalThis.__draftReqs[0]));
      expect(body.includes("일반적인 링크") && body.includes("구체 값") && body.includes("optional"), "일반화 지침");
    },
  },
  {
    name: "자동 초안: 페이지 기억하기를 끈 뒤 남은 카드를 열면 묻지 않고 저장도 막는다",
    pages: { "/s": search },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.sw.evaluate(() => { globalThis.__draftReqs = []; globalThis.__draftDelayMs = 0; });
      await h.turn([{ tool: "navigate_to_url", args: { url: `${h.base}/s?q=a` } }, { text: "끝" }], { text: "찾아줘" });
      await h.panel.waitForTimeout(500);
      await h.settings({ rememberPages: false });
      await h.panel.waitForTimeout(300);
      await h.panel.getByText("이 페이지 기억하기").click();
      await h.panel.waitForTimeout(800);
      expect((await h.sw.evaluate(() => globalThis.__draftReqs.length)) === 0, "묻지 않음");
      expect(await h.panel.locator(".page-offer.open .btn-approve").isDisabled(), "저장 비활성");
      expect((await h.panel.locator(".page-offer.open").innerText()).includes("꺼져 있어"), "안내");
    },
  },
  {
    name: "자동 초안: 보내는 페이지 글자에 textarea 값·편집 글자·숨은 글자가 없다",
    pages: {
      "/s": `<title>가격 검색</title><main><h1>검색 결과</h1><p>최저가 상품 목록</p><textarea id=t></textarea><div contenteditable=true id=e></div><span hidden>숨은글</span><p id=out></p></main>
<script>document.getElementById("t").value = "비밀값"; document.getElementById("e").textContent = "편집글";</script>`,
    },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.sw.evaluate(() => { globalThis.__draftReqs = []; globalThis.__draftDelayMs = 0; });
      await h.turn([{ tool: "navigate_to_url", args: { url: `${h.base}/s?q=a` } }, { tool: "describe_page", args: {} }, { text: "끝" }], { text: "찾아줘" });
      await h.panel.waitForTimeout(500);
      await h.panel.getByText("이 페이지 기억하기").click();
      await h.panel.waitForTimeout(1000);
      const body = await h.sw.evaluate(() => JSON.stringify(globalThis.__draftReqs));
      expect(body.includes("최저가 상품 목록"), "화면 글자는 보냄");
      expect(!/비밀값|편집글|숨은글/.test(body), "보호 글자 없음");
    },
  },
  {
    name: "비워도 되는 자리: 필수만 주면 그 쿼리 값을 빼고 열고, 필수를 빼면 오류, 개인정보 모양 값은 카드",
    pages: { "/s": search },
    async run(h) {
      await h.settings({ autoApprove: true });
      await h.sw.evaluate(() => {
        globalThis.__draftDelayMs = 0;
        globalThis.__draft = {
          name: "가격 검색",
          purpose: "상품을 검색해 가격을 비교",
          params: [
            { index: 0, mode: "slot", slot: "상품명", hint: "검색할 상품 이름", optional: false },
            { index: 1, mode: "slot", slot: "최고 가격", hint: "원, 숫자만", optional: true },
            { index: 2, mode: "keep" },
          ],
        };
      });
      await h.turn([{ tool: "navigate_to_url", args: { url: `${h.base}/s?q=${encodeURIComponent("맥북")}&max=900000&sort=low` } }, { text: "끝" }], { text: "맥북 찾아줘" });
      await h.panel.waitForTimeout(500);
      await h.panel.getByText("이 페이지 기억하기").click();
      await h.panel.waitForTimeout(1200);
      const optBox = h.panel.locator(".page-offer.open .check-row", { hasText: "비워도 됨" });
      expect((await optBox.count()) === 2, `자리마다 체크박스(${await optBox.count()})`);
      await h.panel.locator(".page-offer.open .btn-approve").click();
      await h.panel.waitForTimeout(500);
      const saved = await h.sw.evaluate(async () => (await chrome.storage.local.get("savedPages")).savedPages);
      const l = saved.at(-1) ?? saved[0];
      const norm = (slots) => JSON.stringify(slots.map((x) => [x.key, x.hint, x.optional === true]));
      expect(norm(l.slots) === norm([{ key: "상품명", hint: "검색할 상품 이름" }, { key: "최고 가격", hint: "원, 숫자만", optional: true }]), `저장된 자리(${JSON.stringify(l.slots)})`);
      const r = await h.turn([{ tool: "open_saved_link", args: { id: l.id, values: { 상품명: "아이패드" } } }, { text: "열었습니다" }]);
      expect(decodeURIComponent(new URL(r.url).search) === "?q=아이패드&sort=low", `선택 자리 빠짐(${r.url})`);
      const r2 = await h.turn([{ tool: "open_saved_link", args: { id: l.id, values: { "최고 가격": "500000" } } }, { text: "끝" }]);
      expect(String(lastTool(r2, "open_saved_link")?.error ?? "").includes("상품명"), "필수 빠지면 오류");
      const r3 = await h.turn([{ tool: "open_saved_link", args: { id: l.id, values: { 상품명: "아이패드", "최고 가격": "user@example.com" } } }]);
      expect(r3.stoppedAtCard, "선택 자리의 개인정보 모양 값도 카드");
    },
  },
];
