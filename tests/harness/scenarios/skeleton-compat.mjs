// 페이지 뼈대 해시 호환(#284 계획 11절 P2-8): skeleton.ts를 영역용(skeletonOf)으로 일반화해도 pageSkeleton 값이 그대로여야
// 한다. 값이 조금이라도 바뀌면 이미 저장된 읽기 레시피(#156)의 페이지 키가 모두 무효가 된다.
// 기대값은 리팩터 전 구현(dev 187925a)으로 이 페이지들에서 뽑은 고정값이다. 바꾸지 않는다.
import { expect } from "../lib.mjs";

const PAGES = {
  // 반복 목록(항목 수가 달라도 같은 값이어야 하는 틀).
  "/sk-list": `<title>목록</title><main><h1>메일</h1><ul><li><a href=#>하나</a></li><li><a href=#>둘</a></li><li><a href=#>셋</a></li></ul>
<div class=card><h2>A</h2><button>열기</button></div><div class=card><h2>B</h2><button>열기</button></div></main><p id=out></p>`,
  // 의미 없는 감싸개(div·span 중첩) 안의 구조 요소.
  "/sk-wrap": `<title>감싸개</title><div><div><span><div><nav><ul><li>메뉴</li></ul></nav></div></span></div>
<div><div><section><h2>제목</h2><form><input type=text><select><option>1</option></select><textarea></textarea><button>보내기</button></form></section></div></div></div>
<footer><p>끝</p></footer><p id=out></p>`,
  // 깊이 경계(6)를 넘는 트리.
  "/sk-deep": `<title>깊음</title><main><section><article><section><article><section><article><section><ul><li>깊다</li></ul></section></article></section></article></section></article></section></main>
<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table><p id=out></p>`,
  // shadow root(열린 shadow 안의 구조 요소와 역할).
  "/sk-shadow": `<title>섀도</title><main><div id=host></div><div role=list><div role=listitem>x</div><div role=listitem>y</div></div></main><p id=out></p>
<script>const r=document.getElementById("host").attachShadow({mode:"open"});r.innerHTML='<nav><ul><li>s1</li><li>s2</li></ul></nav><dialog><button>닫기</button></dialog>';</script>`,
};

// 리팩터 전 구현으로 뽑은 값(fnv1a 16진).
const EXPECTED = {
  "/sk-list": "0b342951",
  "/sk-wrap": "3981771b",
  "/sk-deep": "d686f814",
  "/sk-shadow": "8e4b39d1",
};

async function skeletonOfTab(h, path) {
  await h.tab.goto(h.base + path);
  await h.tab.waitForTimeout(300);
  return h.sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    const res = await chrome.tabs.sendMessage(t.id, { kind: "page_skeleton" }, { frameId: 0 });
    return res?.ok ? res.data : `오류:${res?.error}`;
  }, h.base + path);
}

export default [
  {
    name: "페이지 뼈대 해시가 리팩터 전 고정값과 같다(읽기 레시피 키 호환)",
    pages: PAGES,
    async run(h) {
      const got = {};
      for (const path of Object.keys(PAGES)) got[path] = await skeletonOfTab(h, path);
      if (process.env.SKELETON_PRINT) console.log(JSON.stringify(got));
      for (const [path, want] of Object.entries(EXPECTED)) expect(got[path] === want, `${path}: ${got[path]} ≠ ${want}`);
    },
  },
];
