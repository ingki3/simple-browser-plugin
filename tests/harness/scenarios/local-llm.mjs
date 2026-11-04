// 로컬·호환 서버 제공자(#193): 사용자가 적은 주소로만, 선택 필드 거부 재시도, 리다이렉트 거절, 대상 변경 경합, 모델 목록, 첫 화면, #43.
import { expect } from "../lib.mjs";

const LOCAL = "http://127.0.0.1:59999/v1";
const local = (h, over = {}) => h.settings({ provider: "local", localServer: { baseUrl: LOCAL, model: "qwen3:8b" }, ...over });
const reqs = (h) => h.sw.evaluate(() => globalThis.__modelReqs);
const ask = (h, msg) => h.panel.evaluate(async (m) => chrome.runtime.sendMessage(m), msg);

const FORM = `<title>신청</title>
<label>이름 <input name="name" value="LOCAL_TYPED_VALUE"></label>
<div contenteditable="true">LOCAL_EDIT_TEXT</div>
<select name="seat"><option>R석</option><option>S석</option></select>
<button>적용</button>
<div id="out"></div>`;

const ARTICLE = `<title>Article</title>${Array.from({ length: 60 }, (_, i) => `<p>Paragraph number ${i} has some English words to translate for the test page.</p>`).join("")}<div id="out"></div>`;

export default [
  {
    name: "로컬 서버(#193): 적은 주소로 도구 왕복, 키 없으면 Authorization 없음, 모를 수 있는 필드 없음, 입력값·편집 글자는 보내지 않음",
    pages: { "/form": FORM },
    async run(h) {
      await local(h);
      const r = await h.turn([{ tool: "find_form_fields", args: {} }, { tool: "find_clickables", args: {} }, { text: "끝" }], { path: "/form" });
      void r;
      const sent = await reqs(h);
      expect(sent.length >= 3 && sent.every((q) => q.url === `${LOCAL}/chat/completions`), `주소(${sent.map((q) => q.url).join(", ")})`);
      const b = sent[1].body;
      expect(b.model === "qwen3:8b" && b.max_tokens > 0 && b.stream === true && b.stream_options?.include_usage === true, "본문");
      expect(!("parallel_tool_calls" in b) && !("reasoning_effort" in b) && !("reasoning" in b), "모를 수 있는 필드 없음");
      expect(sent.every((q) => !("Authorization" in (q.headers ?? {}))), "키 없으면 머리글 없음");
      const tools = JSON.stringify(sent.map((q) => q.body.messages.filter((m) => m.role === "tool")));
      expect(tools.includes("이름") && tools.includes("R석"), "라벨·선택지 글자는 보냄");
      expect(!tools.includes("LOCAL_TYPED_VALUE") && !tools.includes("LOCAL_EDIT_TEXT"), "입력값·편집 글자는 보내지 않음");
    },
  },
  {
    name: "로컬 서버(#193): 거부(400)면 선택 필드를 빼고 한 번만 다시 보낸다",
    async run(h) {
      await local(h);
      await h.turn([{ httpStatus: 400 }, { text: "다시 보낸 답" }]);
      const sent = await reqs(h);
      expect(sent.length === 2 && "stream_options" in sent[0].body && !("stream_options" in sent[1].body), `재시도(${sent.length})`);
      expect((await h.panel.locator(".bubble-assistant").last().innerText()).includes("다시 보낸 답"), "답");
      expect(h.logs.some((l) => l.includes("local:dropped_fields") && l.includes("stream_options")), "뺀 필드 로그");
    },
  },
  {
    name: "로컬 서버(#193): 주소가 다른 곳으로 넘기면(307) 따르지 않고 연결 안내, 넘긴 곳에는 요청이 가지 않음",
    async run(h) {
      await local(h, { localServer: { baseUrl: `${h.base}/redir`, model: "m" } });
      h.hits.length = 0;
      await h.turn([{ text: "가면 안 됨" }]);
      const text = await h.panel.locator("body").innerText();
      expect(text.includes("로컬 서버에 연결하지 못했습니다"), "연결 안내");
      expect(h.hits.includes("1/redir/chat/completions"), "적은 주소에는 닿음");
      expect(!h.hits.some((x) => x.startsWith("2/v1/")), `넘긴 곳 요청 없음(${h.hits.join(",")})`);
    },
  },
  {
    name: "로컬 서버(#193): 주소·모델이 비면 첫 화면이 키 대신 주소·모델을 안내하고, 보내도 요청하지 않는다",
    async run(h) {
      await h.settings({ provider: "local", localServer: { baseUrl: "", model: "" } });
      await h.panel.reload();
      await h.panel.waitForTimeout(500);
      const w = await h.panel.locator(".welcome").innerText();
      expect(w.includes("로컬 서버의 주소와 모델") && !w.includes("API 키가 필요합니다"), `첫 화면(${w.slice(0, 60)})`);
      await h.turn([{ text: "끝" }], { maxWaitMs: 1500 });
      expect((await reqs(h)).length === 0, "요청 없음");
    },
  },
  {
    name: "로컬 서버(#193): 턴 도중(승인 카드) 서버 주소를 바꾸면 어느 서버로도 더 보내지 않고 멈춘다",
    pages: { "/form": FORM },
    async run(h) {
      await local(h);
      let before = -1;
      await h.turn([{ tool: "find_clickables", args: {} }, { click: "적용" }, { tool: "describe_page", args: {} }, { text: "끝" }], {
        path: "/form",
        onCard: async (card, n) => {
          if (n > 1) return;
          await h.settings({ localServer: { baseUrl: "http://127.0.0.1:59998/v1", model: "qwen3:8b" } });
          await h.panel.waitForTimeout(200);
          before = (await reqs(h)).length;
          await card.locator(".btn-approve").click();
        },
      });
      const sent = await reqs(h);
      expect(before === 2 && sent.length === before, `바꾼 뒤 요청 없음(${before} → ${sent.length})`);
      expect((await h.panel.locator("body").innerText()).includes("이 요청을 멈췄습니다"), "멈춤 안내");
    },
  },
  {
    name: "로컬 서버(#193): 답을 받는 중 서버 주소를 바꾸면 그 답을 거두고 멈춘다",
    async run(h) {
      await local(h);
      const pending = h.turn([{ textParts: ["받는 중인 ", "긴 답"], gapMs: 1500 }], { maxWaitMs: 8000 });
      await h.panel.waitForTimeout(700);
      await h.settings({ localServer: { baseUrl: "http://127.0.0.1:59998/v1", model: "qwen3:8b" } });
      await pending;
      const text = await h.panel.locator("body").innerText();
      expect(!text.includes("받는 중인") && text.includes("이 요청을 멈췄습니다"), `답을 거둠(${text.slice(-120)})`);
      expect((await reqs(h)).length === 1, "더 보내지 않음");
    },
  },
  {
    name: "로컬 서버(#193): 번역 중 서버 주소를 바꾸면 그 뒤 배치는 두 서버 어디에도 보내지 않는다",
    pages: { "/article": ARTICLE },
    async run(h) {
      await local(h);
      await h.sw.evaluate(() => (globalThis.__translateDelayMs = 400));
      await h.turn([{ tool: "translate_page", args: { targetLang: "ko" } }, { text: "번역 시작" }], { path: "/article", approve: true, maxWaitMs: 30_000 });
      const first = await h.sw.evaluate(() => globalThis.__translateReqs.length);
      await h.settings({ localServer: { baseUrl: "http://127.0.0.1:59998/v1", model: "qwen3:8b" } });
      await h.panel.waitForTimeout(2500);
      const after = await h.sw.evaluate(() => globalThis.__translateReqs.map((r) => r.url));
      expect(first >= 1, `첫 배치(${first})`);
      expect(after.length <= first + 1, `바꾼 뒤 새 배치 없음(${first} → ${after.length})`);
      expect(after.every((u) => u.startsWith(LOCAL)), "옛 서버로만(바꾼 뒤 새 서버로는 없음)");
      // 세션이 없거나 끝난 배치(옛 content script·멈춘 번역)는 보내지 않는다.
      const before = (await h.sw.evaluate(() => globalThis.__translateReqs.length));
      const noSession = await ask(h, { kind: "translate_text_batch", texts: ["hello"], targetLang: "ko" });
      expect(noSession?.ok === false && String(noSession.error).includes("번역을 멈췄습니다"), `세션 없음 거절(${JSON.stringify(noSession)})`);
      expect((await h.sw.evaluate(() => globalThis.__translateReqs.length)) === before, "요청 없음");
    },
  },
  {
    name: "로컬 서버(#193): 설정의 '목록 불러오기'가 모델 목록을 채우고, 늦게 온 옛 주소의 결과는 버린다, 주소 오류를 보인다",
    async run(h) {
      await local(h, { localServer: { baseUrl: LOCAL, model: "" } });
      await h.sw.evaluate(() => (globalThis.__localModels = ["qwen3:8b", "llama3.1"]));
      const opts = await h.openOptions("model");
      await opts.locator(".local-models-btn").click();
      await opts.waitForTimeout(800);
      expect((await opts.locator("#local-models option").count()) === 2, "목록 2개");
      expect((await opts.locator('[data-section="model"]').innerText()).includes("모델 2개"), "개수 안내");
      // 늦은 결과: 요청 뒤 주소를 바꾸면 옛 결과를 쓰지 않는다.
      await h.sw.evaluate(() => {
        globalThis.__localModels = ["late-model"];
        globalThis.__localModelsDelayMs = 1500;
      });
      await opts.locator(".local-models-btn").click();
      await opts.locator(".local-base-url").fill("http://127.0.0.1:59999/v1/");
      await opts.waitForTimeout(2200);
      expect(!(await opts.locator('[data-section="model"]').innerText()).includes("모델 1개"), "옛 주소의 늦은 결과는 버림");
      await opts.locator(".local-base-url").fill("http://example.com/v1");
      await opts.waitForTimeout(300);
      expect((await opts.locator('[data-section="model"]').innerText()).includes("http 주소는 이 컴퓨터나 내부망"), "공인 http 주소 오류");
      await opts.close();
    },
  },
  {
    name: "로컬 서버(#193): 가림 목록을 읽는 사이 서버 주소를 바꾸면 두 서버 어디에도 보내지 않는다",
    async run(h) {
      await local(h);
      // 서비스 워커의 세션 저장소 읽기(자동 로그인 가림 목록)를 붙잡아 가림 처리를 멈춘다.
      await h.sw.evaluate(() => {
        const real = chrome.storage.session.get.bind(chrome.storage.session);
        globalThis.__holdSession = new Promise((r) => (globalThis.__releaseSession = r));
        chrome.storage.session.get = async (...a) => {
          if (globalThis.__holdSession) await globalThis.__holdSession;
          return real(...a);
        };
      });
      const pending = h.turn([{ text: "보내면 안 됨" }], { maxWaitMs: 10_000 });
      await h.panel.waitForTimeout(800);
      // 가림 목록이 이미 캐시돼 있으면 붙잡지 못하고 바꾸기 전에 보낼 수 있다 — 어느 쪽이든 "바꾼 뒤에는 옛 서버로 보내지 않음"이 지켜져야 한다.
      const changeAt = await h.sw.evaluate(() => Date.now());
      await h.settings({ localServer: { baseUrl: "http://127.0.0.1:59998/v1", model: "qwen3:8b" } });
      await h.panel.waitForTimeout(300);
      await h.sw.evaluate(() => {
        globalThis.__holdSession = null;
        globalThis.__releaseSession();
      });
      await pending;
      const sent = await reqs(h);
      const late = sent.filter((q) => q.url.startsWith(LOCAL) && q.at >= changeAt);
      expect(late.length === 0, `바꾼 뒤 옛 서버 요청 없음(${late.map((q) => q.url).join(",")})`);
    },
  },
];
