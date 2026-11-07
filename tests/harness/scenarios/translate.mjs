// 페이지 번역(#256): 편집 영역 글자(편집 호스트 안 전부·input·textarea·select·designMode 문서)는 번역 요청에 싣지 않고 바꾸지 않는다.
// 경계(shadow host·slot·같은 출처 iframe), 관찰 경로의 분기(characterData·Text 추가·요소 추가·원문 되돌림), 응답을 붙잡은 사이 편집 가능해진
// 노드(적용 직전·나머지 배치·재시도 전송 직전)를 본다. 양성 대조(일반 글자는 요청에 실리고 화면에서 바뀜)를 항상 같이 확인한다.
// 요청 본문은 하네스 모의 기록(__translateReqs[].texts)으로 본다. 페이지마다 #out을 둔다(turn()이 그 글자를 읽는다 — 없으면 30초 기다림).
import { expect, waitUntil } from "../lib.mjs";

const sentTexts = (h) => h.sw.evaluate(() => (globalThis.__translateReqs ?? []).flatMap((r) => r.texts ?? []));
const sentCount = (texts, marker) => texts.filter((t) => t.includes(marker)).length;

// 문서·같은 출처 iframe·열린 shadow root를 훑어 marker가 든 Text의 글자를 돌려준다(없으면 null).
const nodeText = (h, marker) =>
  h.tab.evaluate((m) => {
    const docs = [document];
    for (const f of document.querySelectorAll("iframe")) {
      try {
        if (f.contentDocument) docs.push(f.contentDocument);
      } catch {}
    }
    const roots = [];
    const addShadows = (r) => {
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) {
        roots.push(el.shadowRoot);
        addShadows(el.shadowRoot);
      }
    };
    for (const d of docs) {
      roots.push(d);
      addShadows(d);
    }
    for (const r of roots) {
      const w = (r.ownerDocument ?? r).createTreeWalker(r, NodeFilter.SHOW_TEXT);
      let n;
      // 페이지 스크립트(이 시험의 shadow 생성 코드)에도 marker가 있으니 script·style 안 글자는 건너뛴다.
      while ((n = w.nextNode())) if (n.data.includes(m) && !n.parentElement?.closest("script, style")) return n.data;
    }
    return null;
  }, marker);
const translated = async (h, marker) => ((await nodeText(h, marker)) ?? "").trim().startsWith("번역:");

const startTranslate = (h, path) =>
  h.turn([{ tool: "translate_page", args: { targetLang: "ko" } }, { text: "번역 시작" }], { path, approve: true });

// 보호 글자는 요청에 없고 화면에서 그대로인지.
async function expectProtected(h, markers, label) {
  const sent = await sentTexts(h);
  for (const m of markers) {
    expect(sentCount(sent, m) === 0, `${label}: ${m}는 요청에 없어야 한다(${sent.filter((t) => t.includes(m)).join(" | ").slice(0, 120)})`);
    const now = await nodeText(h, m);
    expect(now !== null && !now.includes("번역:"), `${label}: ${m}는 화면에서 그대로여야 한다(${now})`);
  }
}

// 그림자 루트를 붙이는 페이지 스크립트(열린 root).
const shadow = (id, html) => `document.getElementById(${JSON.stringify(id)}).attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(html)};`;

const STATIC = `<title>Static</title><div id="out"></div>
<p id="plain">PLAINPARA words for the page.</p>
<div contenteditable="true">EDITHOST words typed here <span contenteditable="false">ISLANDTEXT words inside editor</span></div>
<div contenteditable="plaintext-only">PLAINONLY words typed here</div>
<select><option>SELECTOPT words option</option><option>Other choice</option></select>
<p style="display:none">HIDDENPARA words never shown</p>
<div id="sh-plain"></div>
<div contenteditable="true"><div id="sh-edit"></div></div>
<div id="slot1">SLOTDIRECT words typed here</div>
<div id="slot2"><span>SLOTSPAN words typed here</span></div>
<iframe src="/plainframe" style="width:300px;height:80px"></iframe>
<iframe src="/designframe" style="width:300px;height:80px"></iframe>
<div contenteditable="true"><iframe src="/editframe" style="width:300px;height:80px"></iframe></div>
<script>
${shadow("sh-plain", "<p>PLAINSHADOW words in shadow</p>")}
${shadow("sh-edit", "<p>SHADOWINEDIT words in shadow</p>")}
${shadow("slot1", '<div contenteditable="true"><slot></slot></div>')}
${shadow("slot2", '<div contenteditable="true"><slot></slot></div>')}
</script>`;

const FRAMES = {
  "/plainframe": "<title>F</title><p>PLAINFRAME words in frame</p>",
  "/designframe": '<title>D</title><p>DESIGNDOC words in frame</p><script>document.designMode = "on";</script>',
  "/editframe": "<title>E</title><p>FRAMEINEDIT words in frame</p>",
  "/dframe": "<title>T</title><p>FRAMESTART words in frame</p>",
};

const OBSERVE = `<title>Observe</title><div id="out"></div>
<p id="plain">PLAINPARA words for the page.</p>
<p id="revert">REVERTPLAIN words for the page.</p>
<p id="revert2">REVERTEDIT words for the page.</p>
<div id="ed" contenteditable="true"><p id="edp">EDITSTART words typed here</p></div>
<div contenteditable="true"><div id="sh-edit"></div></div>
<div id="sh-plain"></div>
<iframe id="df" src="/dframe" style="width:300px;height:120px"></iframe>
<script>
${shadow("sh-plain", "<p>PLAINSHADOW words in shadow</p>")}
${shadow("sh-edit", "<p>SHEDINIT words in shadow</p>")}
</script>`;

const RACE = `<title>Race</title><div id="out"></div><p id="a">RACEAPPLY words for the page.</p><p id="b">RACEPLAIN words for the page.</p>`;
const RETRY = `<title>Retry</title><div id="out"></div><p id="r">RETRYEDIT words for the page.</p><p id="p">RETRYPLAIN words for the page.</p>`;
const MANY = `<title>Many</title><div id="out"></div>${Array.from({ length: 60 }, (_, i) => `<p id="m${i}">Paragraph item${i}z has some English words to translate here.</p>`).join("")}`;

export default [
  {
    name: "번역(#256): 처음 훑기 — 편집 호스트(섬 포함)·plaintext-only·select·shadow·slot 두 경우·designMode·편집 영역 안 iframe 글자는 보내지 않는다",
    pages: { "/static": STATIC, ...FRAMES },
    async run(h) {
      await startTranslate(h, "/static");
      await waitUntil(async () => (await translated(h, "PLAINPARA")) && (await translated(h, "PLAINSHADOW")) && (await translated(h, "PLAINFRAME")), {
        timeoutMs: 15_000,
        label: "양성 대조(문단·shadow·iframe) 번역",
      });
      const sent = await sentTexts(h);
      expect(["PLAINPARA", "PLAINSHADOW", "PLAINFRAME"].every((m) => sentCount(sent, m) === 1), `양성 대조는 한 번씩 요청(${sent.length}개)`);
      await expectProtected(
        h,
        ["EDITHOST", "ISLANDTEXT", "PLAINONLY", "SELECTOPT", "HIDDENPARA", "SHADOWINEDIT", "SLOTDIRECT", "SLOTSPAN", "DESIGNDOC", "FRAMEINEDIT"],
        "처음 훑기",
      );
    },
  },
  {
    name: "번역(#256): 관찰 경로 — 편집 영역의 글자 바꿈·Text 추가·요소 추가·새 편집 노드·shadow 안 추가·숨김·편집 뒤 원문 되돌림은 보내지 않고, 일반 추가·되돌림은 번역",
    pages: { "/observe": OBSERVE, ...FRAMES },
    async run(h) {
      await startTranslate(h, "/observe");
      await waitUntil(
        async () =>
          (await translated(h, "PLAINPARA")) && (await translated(h, "REVERTPLAIN")) && (await translated(h, "REVERTEDIT")) && (await translated(h, "PLAINSHADOW")) && (await translated(h, "FRAMESTART")),
        { timeoutMs: 15_000, label: "처음 번역" },
      );
      await expectProtected(h, ["EDITSTART", "SHEDINIT"], "처음 훑기");
      await h.tab.evaluate(() => {
        const ed = document.getElementById("ed");
        ed.querySelector("#edp").firstChild.data = "EDITTYPED words typed later"; // characterData
        ed.appendChild(document.createTextNode("EDITADDTEXT words typed later")); // Text 직접 추가
        const p = document.createElement("p");
        p.textContent = "EDITADDEL words typed later"; // 요소째 추가
        ed.appendChild(p);
        const fresh = document.createElement("div");
        fresh.contentEditable = "true";
        fresh.textContent = "NEWEDITABLE words typed later"; // 새 편집 노드
        document.body.appendChild(fresh);
        const shEdit = document.getElementById("sh-edit").shadowRoot;
        const sp = document.createElement("p");
        sp.textContent = "SHADOWEDITADD words in shadow";
        shEdit.appendChild(sp);
        const hidden = document.createElement("p");
        hidden.style.display = "none";
        hidden.textContent = "HIDDENADD words never shown";
        document.body.appendChild(hidden);
        const hidden2 = document.createElement("p");
        hidden2.hidden = true;
        hidden2.textContent = "HIDDENATTR words never shown";
        document.body.appendChild(hidden2);
        // 번역된 글자를 페이지가 원문으로 되돌림: 일반 영역은 재번역, 편집 영역이 된 뒤 되돌리면 보내지 않음.
        document.getElementById("revert").firstChild.data = "REVERTPLAIN words for the page.";
        const r2 = document.getElementById("revert2");
        r2.contentEditable = "true";
        r2.firstChild.data = "REVERTEDIT words for the page.";
        // 양성 대조(같은 관찰 배치): 일반 새 문단·기존 shadow root 안 새 문단.
        const pa = document.createElement("p");
        pa.textContent = "PLAINADD words added later";
        document.body.appendChild(pa);
        const ps = document.createElement("p");
        ps.textContent = "PSHADOWADD words in shadow";
        document.getElementById("sh-plain").shadowRoot.appendChild(ps);
      });
      await waitUntil(async () => (await translated(h, "PLAINADD")) && (await translated(h, "PSHADOWADD")) && (await translated(h, "REVERTPLAIN")), {
        timeoutMs: 15_000,
        label: "관찰 배치 양성 대조 번역",
      });
      // 되돌린 원문은 백그라운드 번역 캐시에 있어 모델 요청 없이 다시 적용된다. 그래서 되돌림은 요청 수가 아니라 화면으로 본다:
      // 일반 영역은 다시 번역(위 대기), 편집 영역이 된 뒤 되돌린 글자는 그대로(content script가 보내지도 쓰지도 않음).
      const reverted = await nodeText(h, "REVERTEDIT");
      expect(reverted === "REVERTEDIT words for the page.", `편집 영역이 된 뒤 되돌린 글자는 그대로(${reverted})`);
      await expectProtected(h, ["EDITTYPED", "EDITADDTEXT", "EDITADDEL", "NEWEDITABLE", "SHADOWEDITADD", "HIDDENADD", "HIDDENATTR"], "관찰 경로");

      // 같은 출처 iframe(관찰 등록 범위 안): designMode가 꺼진 동안 추가는 번역(관찰 확인), 켠 뒤 추가·글자 바꿈은 보내지 않음.
      await h.tab.evaluate(() => {
        const d = document.getElementById("df").contentDocument;
        const p = d.createElement("p");
        p.textContent = "FRAMEADDPLAIN words in frame";
        d.body.appendChild(p);
      });
      await waitUntil(() => translated(h, "FRAMEADDPLAIN"), { timeoutMs: 15_000, label: "iframe 관찰 양성 대조" });
      await h.tab.evaluate(() => {
        const d = document.getElementById("df").contentDocument;
        d.designMode = "on";
        const p = d.createElement("p");
        p.textContent = "FRAMEADDDESIGN words in frame";
        d.body.appendChild(p);
        d.body.firstElementChild.firstChild.data = "FRAMETYPED words in frame";
        const pa = document.createElement("p");
        pa.textContent = "SECONDADD words added later";
        document.body.appendChild(pa);
      });
      await waitUntil(() => translated(h, "SECONDADD"), { timeoutMs: 15_000, label: "두 번째 관찰 배치 양성 대조" });
      await expectProtected(h, ["FRAMEADDDESIGN", "FRAMETYPED"], "designMode iframe 관찰");
    },
  },
  {
    name: "번역(#256): 응답을 붙잡은 사이 대상 문단이 편집 가능해지면 그 문단에는 번역을 쓰지 않는다(옆 문단은 번역)",
    pages: { "/race": RACE },
    async run(h) {
      await h.sw.evaluate(() => (globalThis.__translateHold = true));
      const pending = startTranslate(h, "/race");
      pending.catch(() => {});
      let ready = false;
      try {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__translateHeld >= 1), { timeoutMs: 15_000, label: "첫 배치 응답 붙잡힘" });
        await h.tab.evaluate(() => (document.getElementById("a").contentEditable = "true"));
        ready = true;
      } finally {
        await h.sw.evaluate(() => globalThis.__releaseTranslate?.());
        if (!ready) await pending.catch(() => {});
      }
      await pending;
      await waitUntil(() => translated(h, "RACEPLAIN"), { timeoutMs: 15_000, label: "양성 대조 번역" });
      const now = await nodeText(h, "RACEAPPLY");
      expect(now === "RACEAPPLY words for the page.", `편집 가능해진 문단은 그대로(${now})`);
    },
  },
  {
    name: "번역(#256): 첫 배치를 붙잡은 사이 나머지 배치의 문단이 편집 가능해지면 그 글자는 보내지 않는다",
    pages: { "/many": MANY },
    async run(h) {
      await h.sw.evaluate(() => (globalThis.__translateHold = true));
      const pending = startTranslate(h, "/many");
      pending.catch(() => {});
      let ready = false;
      let target = -1;
      let controls = [];
      try {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__translateHeld >= 1), { timeoutMs: 15_000, label: "첫 배치 응답 붙잡힘" });
        const first = await sentTexts(h);
        const later = Array.from({ length: 60 }, (_, i) => i).filter((i) => sentCount(first, `item${i}z`) === 0);
        expect(later.length >= 2, `나머지 배치가 있어야 한다(${later.length})`);
        target = later[later.length - 1];
        controls = later.slice(0, -1);
        await h.tab.evaluate((i) => (document.getElementById(`m${i}`).contentEditable = "true"), target);
        ready = true;
      } finally {
        await h.sw.evaluate(() => globalThis.__releaseTranslate?.());
        if (!ready) await pending.catch(() => {});
      }
      await pending;
      // 대상 말고 나머지 배치의 문단이 모두 번역될 때까지 기다린다(대상이 든 배치가 아직 안 갔는데 통과하지 않게).
      await waitUntil(async () => {
        for (const i of controls) if (!(await translated(h, `item${i}z`))) return false;
        return true;
      }, { timeoutMs: 20_000, label: "나머지 배치 양성 대조 번역" });
      await expectProtected(h, [`item${target}z`], "나머지 배치");
    },
  },
  {
    name: "번역(#256): 다시 요청(쓸 수 없는 번역)을 보내기 전에 편집 가능해진 문단은 다시 보내지 않는다",
    pages: { "/retry": RETRY },
    async run(h) {
      await h.sw.evaluate(() => {
        globalThis.__translateHold = true;
        globalThis.__translateEcho = "RETRYEDIT";
      });
      const pending = startTranslate(h, "/retry");
      pending.catch(() => {});
      let ready = false;
      try {
        await waitUntil(() => h.sw.evaluate(() => globalThis.__translateHeld >= 1), { timeoutMs: 15_000, label: "첫 배치 응답 붙잡힘" });
        await h.tab.evaluate(() => (document.getElementById("r").contentEditable = "true"));
        ready = true;
      } finally {
        await h.sw.evaluate(() => globalThis.__releaseTranslate?.());
        if (!ready) await pending.catch(() => {});
      }
      await pending;
      await waitUntil(() => translated(h, "RETRYPLAIN"), { timeoutMs: 15_000, label: "양성 대조 번역" });
      const sent = await sentTexts(h);
      expect(sentCount(sent, "RETRYEDIT") === 1, `편집 가능해진 뒤 다시 요청 없음(${sentCount(sent, "RETRYEDIT")})`);
      expect((await nodeText(h, "RETRYEDIT")) === "RETRYEDIT words for the page.", "글자 그대로");
    },
  },
];
