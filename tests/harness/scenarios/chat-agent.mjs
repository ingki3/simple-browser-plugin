// ChatAgent 분리(#263) 단계 0: 분리할 경로 중 기존 시나리오가 덮지 못하던 것 — 요청별 읽기 한도, 깨진 도구 인자, 한도 카드 "계속",
// 길이 한도 재시도·잘림 안내, 팝업 창을 따라가는 턴의 머리말. 모두 제품 코드(src/background/agent/chatAgent.ts) 동작을 그대로 고정한다.
import { expect, findC, okResult, waitUntil } from "../lib.mjs";

const PAGE = `<title>가게</title><main><button>주문</button><p id=out></p></main>`;
const describe = { tool: "describe_page", args: {} };
const reqs = (h) => h.sw.evaluate(() => globalThis.__modelReqs ?? []);
// 에이전트 요청(도구가 실린 것)만 — 저장 카드 초안·번역 요청은 뺀다.
const agentReqs = (list) => list.filter((q) => Array.isArray(q.body.tools) && q.body.tools.length);
const panelText = (h) => h.panel.locator("body").innerText();
// 마지막 요청 기록에 실린 그 도구의 결과(모델에 간 그대로, 호출 순서) — 한 응답의 여러 호출을 모두 본다(__toolLog는 요청마다 마지막 결과 하나만).
const sentResults = async (h, name) => {
  const last = (await reqs(h)).at(-1)?.body;
  return (last?.messages ?? []).filter((m) => m.role === "tool" && m.name === name).map((m) => JSON.parse(m.content));
};
// 카드가 뜨면 취소한다(읽기 도구가 묻는 카드 — 한도를 세는 데에는 실행 여부가 상관없다).
const cancelCards = async (card) => {
  await card.locator(".btn-cancel").first().click();
};

// 사용자 문맥(buildUserContent) 안의 chrome.tabs.get을 세고, holdAt번째를 붙잡는 게이트(#263 R4). 붙잡은 호출은 풀 때 실제
// 탭을 읽고, title이 있으면 제목만 그 글로 바꿔 돌려준다(붙잡은 것이 탭 머리말 조회인지 확인하는 데 쓴다).
// buildUserContent는 ChatAgent 메서드라 압축 빌드에서도 이름이 남고, 그 안에서 기다린 함수의 호출은 async 스택에 그 이름이 보인다.
async function installTabsGetGate(h) {
  await h.sw.evaluate(() => {
    const real = chrome.tabs.get.bind(chrome.tabs);
    globalThis.__realTabsGet = real;
    globalThis.__tabsGetCount = 0;
    globalThis.__tabsGetHoldAt = 0;
    globalThis.__tabsGetHeld = false;
    globalThis.__tabsGetTitle = null;
    globalThis.__releaseTabsGet = null;
    chrome.tabs.get = (id, ...rest) => {
      if (rest.length || !String(new Error().stack ?? "").includes("buildUserContent")) return real(id, ...rest);
      const n = ++globalThis.__tabsGetCount;
      if (n !== globalThis.__tabsGetHoldAt) return real(id);
      globalThis.__tabsGetHeld = true;
      const title = globalThis.__tabsGetTitle;
      return new Promise((resolve, reject) => {
        globalThis.__releaseTabsGet = () => {
          globalThis.__releaseTabsGet = null;
          real(id).then((t) => resolve(title ? { ...t, title } : t), reject);
        };
      });
    };
  });
}
async function armTabsGetGate(h, holdAt, title = null) {
  await h.sw.evaluate(
    ([at, t]) => {
      globalThis.__tabsGetCount = 0;
      globalThis.__tabsGetHoldAt = at;
      globalThis.__tabsGetHeld = false;
      globalThis.__tabsGetTitle = t;
    },
    [holdAt, title],
  );
}
async function removeTabsGetGate(h) {
  await h.sw.evaluate(() => {
    globalThis.__releaseTabsGet?.();
    if (globalThis.__realTabsGet) chrome.tabs.get = globalThis.__realTabsGet;
    globalThis.__realTabsGet = null;
    globalThis.__tabsGetHoldAt = 0;
  });
}
const waitHeld = (h) =>
  waitUntil(() => h.sw.evaluate(() => globalThis.__tabsGetHeld && !!globalThis.__releaseTabsGet), { timeoutMs: 8000, label: "머리말 탭 조회 붙잡힘" });
// 패널에서 요청을 보내기만 한다(h.turn은 턴이 끝나기를 기다린다 — 붙잡힌 턴은 끝나지 않는다).
async function sendOnly(h, text, steps) {
  await h.sw.evaluate((s) => {
    globalThis.__steps = s;
    globalThis.__toolLog = [];
  }, steps);
  await h.panel.fill("textarea.composer-input", text);
  await h.panel.click("button.composer-btn.primary");
}

// 이 탭·패널 밖의 탭·창을 닫는다(팝업 창이 다음 시나리오에 남지 않게).
async function closeExtraTabs(h) {
  for (const p of h.ctx.pages()) if (p !== h.tab && p !== h.panel) await p.close().catch(() => {});
  await h.tab.bringToFront();
}

export default [
  {
    name: "한 요청에서 다른 탭 읽기는 2번, 파일 읽기는 5번까지(넘는 호출은 한도 오류 결과)",
    pages: { "/p": PAGE },
    async run(h) {
      const tabs = Array.from({ length: 3 }, (_, i) => ({ tool: "read_other_tabs", args: { purpose: `참고 ${i + 1}` } }));
      await h.turn([{ calls: tabs }, { text: "끝" }], { path: "/p", onCard: cancelCards });
      const tabRes = await sentResults(h, "read_other_tabs");
      expect(tabRes.length === 3, `다른 탭 읽기 결과 3개(${tabRes.length})`);
      const tabLimit = (t) => String(t.error ?? "").includes("한 요청에서 다른 탭 읽기는 최대 2번입니다");
      expect(!tabLimit(tabRes[0]) && !tabLimit(tabRes[1]) && tabLimit(tabRes[2]), `셋째만 한도 오류(${JSON.stringify(tabRes.map((t) => t.error ?? "ok"))})`);

      const docs = Array.from({ length: 6 }, (_, i) => ({ tool: "read_document", args: { url: `${h.base}/files/doc${i + 1}.pdf` } }));
      await h.sw.evaluate(() => {
        globalThis.__modelReqs = [];
      });
      await h.turn([{ calls: docs }, { text: "끝" }], { path: "/p", onCard: cancelCards });
      const docRes = await sentResults(h, "read_document");
      expect(docRes.length === 6, `파일 읽기 결과 6개(${docRes.length})`);
      const docLimit = (t) => String(t.error ?? "").includes("한 요청에서 파일은 최대 5개까지 읽을 수 있습니다");
      expect(docRes.slice(0, 5).every((t) => !docLimit(t)) && docLimit(docRes[5]), `여섯째만 한도 오류(${JSON.stringify(docRes.map((t) => t.error ?? "ok"))})`);
      // 한도 오류는 실행 전에 막는다 — 여섯째 파일은 서버에 요청하지 않는다.
      expect(!h.hits.some((x) => x.includes("/files/doc6.pdf")), `여섯째 파일은 요청하지 않음(${h.hits.filter((x) => x.includes("/files/")).join(",")})`);
    },
  },
  {
    name: "인자가 깨진 호출은 실패 결과로 돌려주고 턴을 잇는다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ autoApprove: true });
      const r = await h.turn([{ tool: "describe_page", rawArgs: "{" }, describe, { text: "끝냄" }], { path: "/p" });
      const res = r.tools.filter((t) => t.name === "describe_page");
      expect(res.length === 2, `describe_page 결과 2개(${res.length})`);
      expect(res[0].error && res[0].result === undefined && /JSON/i.test(String(res[0].error)), `깨진 인자는 해석 오류 결과(${JSON.stringify(res[0])})`);
      expect(!res[1].error && res[1].result !== undefined, `다음 호출은 실행(${JSON.stringify(res[1]).slice(0, 200)})`);
      const list = agentReqs(await reqs(h));
      expect(list.length === 3, `요청 3번 — 깨진 호출 뒤에도 이어 감(${list.length})`);
      expect((await panelText(h)).includes("끝냄"), "최종 답");
    },
  },
  {
    name: "한도 카드에서 계속하면 설정 한도만큼 더 진행한다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.settings({ autoApprove: true, maxToolHops: 2, maxToolHopsVersion: 2 });
      // 같은 호출이 되풀이되면 헛돌기로 멈추므로 두 도구를 번갈아 부른다.
      const steps = Array.from({ length: 8 }, (_, i) => (i % 2 ? findC : describe));
      const seen = [];
      const r = await h.turn(steps, {
        path: "/p",
        onCard: async (card, n) => {
          const txt = await card.innerText();
          seen.push(txt);
          // 첫 카드는 계속, 둘째 카드는 그만두기.
          await card.locator(n === 1 ? ".btn-approve" : ".btn-cancel").click();
        },
      });
      expect(r.cards === 2, `한도 카드 2번(${r.cards})`);
      const ran = r.tools.filter((t) => t.name === "describe_page" || t.name === "find_clickables");
      expect(ran.length === 4, `도구 4번(한도 2 + 계속 2)(${ran.length}: ${ran.map((t) => t.name).join(",")})`);
      const list = agentReqs(await reqs(h));
      const last = list.at(-1)?.body;
      expect(list.length === 5 && last?.tool_choice === "none", `도구 요청 4번 + 마무리 1번(${list.length}, ${JSON.stringify(last?.tool_choice)})`);
    },
  },
  {
    name: "길이 재시도가 또 빈 답이면 오류로 끝낸다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.turn([{ lengthEmpty: true }, { lengthEmpty: true }, { text: "보내면 안 됨" }], { path: "/p" });
      const list = agentReqs(await reqs(h));
      expect(list.length === 2, `요청 2번(처음 + 재시도 1번)(${list.length})`);
      const text = await panelText(h);
      expect(text.includes("모델이 생각만 하다 응답 길이 한도에 걸려 답을 만들지 못했습니다"), `오류 안내(${text.slice(-300)})`);
      expect(!text.includes("보내면 안 됨"), "셋째 요청 없음");
    },
  },
  {
    name: "글이 있는 채로 길이 한도에 걸리면 답을 두고 잘림 안내를 붙인다",
    pages: { "/p": PAGE },
    async run(h) {
      await h.turn([{ lengthText: "앞부분까지 쓴 답" }, { text: "보내면 안 됨" }], { path: "/p" });
      const list = agentReqs(await reqs(h));
      expect(list.length === 1, `재시도하지 않음(${list.length})`);
      const text = await panelText(h);
      expect(text.includes("앞부분까지 쓴 답"), "받은 글은 보인다");
      expect(text.includes("답이 응답 길이 한도에서 잘렸습니다"), `잘림 안내(${text.slice(-300)})`);
    },
  },
  {
    name: "팝업 창을 따라가는 중이면 다음 요청의 머리말에 그 안내가 붙는다",
    pages: {
      "/pp": `<title>예매</title><main><button onclick="window.open('/cal','cal','popup,width=420,height=320')">달력 열기</button><p id=out></p></main>`,
      "/cal": `<title>달력</title><main><button>10월 25일</button></main>`,
    },
    async run(h) {
      await closeExtraTabs(h);
      await h.settings({ autoApprove: true });
      const NOTE = "[팝업 창을 따라가는 중";
      const userTexts = (q) => JSON.stringify((q?.body?.messages ?? []).filter((m) => m.role === "user"));
      try {
        const r = await h.turn([findC, { click: "달력 열기" }, { text: "열었습니다" }], { path: "/pp", text: "달력 열어 줘" });
        const click = okResult(r, "click_element");
        expect(click.effect?.popup?.opened?.followed, `팝업 창을 따라감(${JSON.stringify(click.effect?.popup)})`);
        const first = agentReqs(await reqs(h))[0];
        expect(first && !userTexts(first).includes(NOTE), "따라가기 전 요청에는 안내 없음");
        await h.sw.evaluate(() => {
          globalThis.__modelReqs = [];
        });
        await h.turn([{ text: "날짜 봤습니다" }], { noReload: true, text: "날짜 골라 줘" });
        // 둘째 요청의 사용자 글(현재 시각 안내 앞, 요청 글이 든 것)의 탭 머리말 — 앞 턴 글에는 안내가 없었다(위에서 확인).
        const second = agentReqs(await reqs(h))[0];
        const asked = (second?.body?.messages ?? []).filter((m) => m.role === "user" && JSON.stringify(m.content).includes("날짜 골라 줘"));
        const s = JSON.stringify(asked);
        expect(asked.length === 1 && s.includes(NOTE) && s.includes("제목: 달력"), `둘째 요청 머리말에 팝업 안내(${s.slice(0, 600)})`);
      } finally {
        await closeExtraTabs(h);
      }
    },
  },
  {
    // #263 R4: 탭 머리말(fetchTabHeader)은 탭 조회를 기다린 뒤 지금 턴의 탭(this.turnTab)을 다시 읽는다 — 그 사이 새 턴이 시작되면
    // 다른 턴의 값이 섞일 수 있지만, buildUserContent 뒤 stale 확인으로 옛 턴은 기록·모델 요청 없이 끝난다. 이 보장을 고정한다.
    // 패널은 응답 중 보내기를 막으므로 "새 요청"은 중단(턴 번호를 올림) 뒤 보내기로 만든다.
    name: "사용자 문맥을 읽는 사이 새 요청이 오면 옛 요청의 글은 기록·모델 요청에 들어가지 않는다",
    pages: { "/ctx": `<title>문맥</title><main><p id=out></p></main>` },
    async run(h) {
      const agentUserTexts = async () => agentReqs(await reqs(h)).map((q) => JSON.stringify((q.body.messages ?? []).filter((m) => m.role === "user")));
      const settled = () => waitUntil(async () => !(await h.panel.locator("button.composer-btn.danger").count()), { timeoutMs: 8000, label: "응답 끝" });
      await installTabsGetGate(h);
      try {
        // 1) 문맥 안의 탭 조회 수를 센다(일반 웹 페이지 — 머리말 조회가 마지막이다).
        await armTabsGetGate(h, 0);
        await h.turn([{ text: "하나" }], { path: "/ctx", text: "세기" });
        const n = await h.sw.evaluate(() => globalThis.__tabsGetCount);
        expect(n >= 1, `문맥 안 탭 조회가 있음(${n})`);

        // 2) 대조: n번째를 붙잡고 제목을 바꿔 풀면 머리말에 그 제목이 실린다 → 붙잡는 것이 머리말 조회다.
        await armTabsGetGate(h, n, "붙잡은 제목");
        await sendOnly(h, "확인 요청", [{ text: "확인 답" }]);
        await waitHeld(h);
        await h.sw.evaluate(() => globalThis.__releaseTabsGet());
        await settled();
        const probe = (await agentUserTexts()).find((t) => t.includes("확인 요청"));
        expect(probe?.includes("제목: 붙잡은 제목"), `붙잡은 호출이 머리말 조회(${String(probe).slice(0, 300)})`);

        // 3) 머리말 조회를 붙잡은 채 중단하고 새 요청을 보낸 뒤 푼다.
        await h.sw.evaluate(() => {
          globalThis.__modelReqs = [];
        });
        await armTabsGetGate(h, n);
        await sendOnly(h, "첫 요청 글", [{ text: "보내면 안 됨" }]);
        await waitHeld(h);
        await h.panel.click("button.composer-btn.danger");
        await settled();
        const ends = h.logs.filter((l) => l.startsWith("[SBP turn:end]") && l.includes("aborted")).length;
        await h.turn([{ text: "둘째 답" }], { noReload: true, text: "둘째 요청 글" });
        expect(await h.sw.evaluate(() => !!globalThis.__releaseTabsGet), "둘째 요청 동안 첫 요청은 여전히 붙잡혀 있음");
        await h.sw.evaluate(() => globalThis.__releaseTabsGet());
        await waitUntil(() => h.logs.filter((l) => l.startsWith("[SBP turn:end]") && l.includes("aborted")).length > ends, {
          timeoutMs: 5000,
          label: "풀린 첫 요청이 중단으로 끝남",
        });
        // 기록에 옛 글이 남았는지는 다음 요청의 기록으로 본다.
        await h.turn([{ text: "셋째 답" }], { noReload: true, text: "셋째 요청 글" });
        const all = JSON.stringify(await reqs(h));
        expect(!all.includes("첫 요청 글"), "옛 요청 글은 어느 모델 요청에도 없음");
        const texts = await agentUserTexts();
        expect(texts.length === 2, `에이전트 요청 2번(둘째·셋째)(${texts.length})`);
        expect(texts[1].includes("둘째 요청 글") && texts[1].includes("셋째 요청 글"), `셋째 요청 기록에 둘째·셋째 글(${texts[1]?.slice(0, 400)})`);
        const text = await panelText(h);
        expect(!text.includes("보내면 안 됨") && text.includes("셋째 답"), "옛 요청의 답은 없음");
      } finally {
        await removeTabsGetGate(h);
      }
    },
  },
];
