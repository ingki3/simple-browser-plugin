// find_clickables query 0개(#242): 이름이 화면 글자와 다른 후보는 화면 글자로 한 번 더 맞추고(matchedBy), 그래도 0개면 디버그
// 로그 find_clickables:zero에 수만 남기고 구조 수로 안내를 고른다. 후보 있음·후보 0개+후보 밖 글자만·후보 전부 제외를 각각 본다.
// 입력값·편집 글자·숨은 글자로는 맞추지도 세지도 않는다(#43).
import { expect, okResult } from "../lib.mjs";

const find = (query, extra = {}) => ({ tool: "find_clickables", args: { query, ...extra } });
const zeroLine = (r) => r.logs.find((l) => l.includes("find_clickables:zero")) ?? "";

export default [
  {
    name: "이름이 aria-label이라 query가 0개면 화면 글자로 다시 맞추고 matchedBy를 알린다 — 그 id는 승인 카드를 거쳐 누른다",
    pages: {
      "/sido": `<title>지역</title><main><ul><li><a href="#s" aria-label="시도 1">서울</a></li><li><a href="#b" aria-label="시도 2">부산</a></li></ul><p id=out></p><p id=out></p></main>`,
    },
    async run(h) {
      const r = await h.turn([find("서울"), { click: "시도 1" }], { path: "/sido" });
      const t = [...r.tools].find((x) => x.name === "find_clickables");
      const res = t?.result;
      expect(res && Array.isArray(res.items) && res.items.length === 1, `결과 1개(${JSON.stringify(res)})`);
      expect(res.items[0].text === "시도 1" && res.items[0].matchedBy === "screenText", `이름 그대로, matchedBy(${JSON.stringify(res.items[0])})`);
      expect(String(res.note).includes("화면 글자에 query가 있습니다"), `안내(${res.note})`);
      expect(r.logs.some((l) => l.includes("find_clickables:screen_text") && l.includes(" 1")), "재매칭 수 로그");
      expect(!zeroLine(r), "재매칭으로 찾았으면 zero 진단은 없다");
      expect(r.stoppedAtCard && r.cards === 1, `묻기 모드에서 승인 카드가 뜬다(cards=${r.cards})`);
    },
  },
  {
    name: "아이콘 버튼처럼 이름·화면 글자 어디에도 없으면 0개와 기본 안내, 로그에는 수만",
    pages: {
      "/icon": `<title>첫 화면</title><main><button aria-label="열기"><svg width=20 height=20><rect width=20 height=20></rect></svg></button><a href="/x">더보기</a><p id=out></p></main>`,
    },
    async run(h) {
      const r = await h.turn([find("검색|돋보기|search")], { path: "/icon" });
      const res = okResult(r, "find_clickables");
      expect(Array.isArray(res.items) && res.items.length === 0, `빈 items(${JSON.stringify(res)})`);
      expect(String(res.note).includes("2개") && String(res.note).includes("이름(text"), `수와 매칭 규칙 안내(${res.note})`);
      const line = zeroLine(r);
      expect(line.includes("후보 2") && line.includes("후보 밖 화면글자 0"), `진단 줄(${line})`);
    },
  },
  {
    name: "후보가 하나도 없고 후보 밖 화면 글자만 있으면 0개와 안내, 로그에는 구조 신호별 수만",
    pages: {
      "/region": `<title>지역</title><main><ul><li onclick="1">대전</li><li><a>대구</a></li><li tabindex=0>광주</li><li style="cursor:pointer">울산</li></ul><p id=out></p></main>`,
    },
    async run(h) {
      const r = await h.turn([find("대전|대구|광주|울산")], { path: "/region" });
      const res = okResult(r, "find_clickables");
      expect(!Array.isArray(res) && Array.isArray(res.items) && res.items.length === 0, `후보 0개여도 {items, note}(${JSON.stringify(res)})`);
      expect(String(res.note).includes("클릭 후보(링크·버튼·선택 위젯)가 아닌"), `후보 밖 안내(${res.note})`);
      const line = zeroLine(r);
      expect(line.includes("후보 0") && line.includes("a무주소 1") && line.includes("onclick 1") && line.includes("tabindex 1") && line.includes("cursor 1"), `신호별 수(${line})`);
      expect(!/대전|대구|광주|울산/.test(line), `진단 줄에 글자가 없다(${line})`);
    },
  },
  {
    name: "후보가 전부 빠지면(aria-hidden·숨김) 뺀 수로 알리고 결과에는 싣지 않는다",
    pages: {
      "/hidden": `<title>숨김</title><main><div aria-hidden="true"><a href="#x">인천</a></div><a href="#y" style="display:none">수원</a><p id=out></p></main>`,
    },
    async run(h) {
      const r = await h.turn([find("인천")], { path: "/hidden" });
      const res = okResult(r, "find_clickables");
      expect(!Array.isArray(res) && res.items.length === 0, `빈 items + note(${JSON.stringify(res)})`);
      expect(String(res.note).includes("숨겨졌거나"), `뺀 사실 안내(${res.note})`);
      const line = zeroLine(r);
      expect(line.includes("후보 0") && line.includes("숨김 1") && line.includes("aria-hidden 1") && line.includes("후보 밖 화면글자 0"), `뺀 이유별 수(${line})`);
    },
  },
  {
    name: "입력값·편집 글자·숨은 글자로는 맞추지도 세지도 않는다(#43)",
    pages: {
      "/form": `<title>양식</title><main><input id=a value="세종-비밀" aria-label="주소"><textarea aria-label="메모">세종-비밀</textarea><div contenteditable>세종-비밀</div><span hidden>세종</span><button>확인</button><p id=out></p></main>`,
    },
    async run(h) {
      const r = await h.turn([find("세종")], { path: "/form" });
      const res = okResult(r, "find_clickables");
      expect(res.items.length === 0 && !res.items.some?.((x) => x.matchedBy), `재매칭 없음(${JSON.stringify(res)})`);
      expect(!String(res.note).includes("클릭 후보(링크·버튼·선택 위젯)가 아닌"), `후보 밖 안내 없음(${res.note})`);
      const line = zeroLine(r);
      expect(line.includes("후보 밖 화면글자 0"), `입력값·편집·숨은 글자는 세지 않음(${line})`);
      const reqs = JSON.stringify(await h.sw.evaluate(() => globalThis.__modelReqs));
      expect(!reqs.includes("세종-비밀") && !r.logs.some((l) => l.includes("세종-비밀")), "입력값이 모델 요청·로그에 없다");
    },
  },
  {
    name: "query 없는 0개는 진단하지 않고 빈 배열 그대로",
    pages: { "/empty": `<title>빈</title><main><p id=out>글만</p></main>` },
    async run(h) {
      const r = await h.turn([{ tool: "find_clickables", args: { region: "nav" } }], { path: "/empty" });
      const res = okResult(r, "find_clickables");
      expect(Array.isArray(res) && res.length === 0, `빈 배열(${JSON.stringify(res)})`);
      expect(!zeroLine(r), "zero 진단 없음");
    },
  },
  {
    name: "큰 페이지(링크 3,000개·글자 노드 많음)에서도 0개 진단은 상한 안에서 빨리 끝난다",
    pages: {
      "/big": `<title>큰</title><main>${Array.from({ length: 3000 }, (_, i) => `<p><a href="#a${i}" aria-label="항목 ${i}">상품 ${i}</a> 설명 ${i}</p>`).join("")}<p id=out></p></main>`,
    },
    async run(h) {
      const r = await h.turn([find("없는낱말")], { path: "/big" });
      const end = r.logs.find((l) => l.includes("tool:find_clickables:end")) ?? "";
      const ms = Number(/(\d+)ms/.exec(end)?.[1] ?? NaN);
      expect(ms < 3000, `find_clickables가 3초 안에 끝나야 한다(${end})`);
      expect(zeroLine(r).includes("후보 3000"), `진단 줄(${zeroLine(r).slice(0, 120)})`);
    },
  },
];
