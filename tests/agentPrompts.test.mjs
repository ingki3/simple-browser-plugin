// 지침·안내 문구(src/background/agent/prompts.ts, #263 단계 1). 옮기기 전 chatAgent.ts의 같은 함수·상수 본문을 임시 모듈로 실행해 뽑은
// 결과(SHA-256)를 스냅숏으로 둔다 — 옮긴 뒤에도 한 글자도 같아야 한다. 문구를 일부러 고치면 이 값도 함께 고친다.
// #297 2단계에서 pathHints 줄을 더해 system 스냅숏을 고쳤다(원격 안내·고정 문구는 그대로).
// #310에서 send_to_kakao 지침 줄을 더해 system 스냅숏을 고쳤다(원격 안내·고정 문구는 그대로).
// isGoogleConfigured는 manifest의 oauth2.client_id와 chrome.identity를 보므로 chrome 전역 대역으로 Google 있음/없음을 고른다.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import "./helpers/tsLoader.mjs";

const P = await import("../src/background/agent/prompts.ts");
const { functionDeclarations } = await import("../src/background/tools/declarations.ts");

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const setGoogle = (on) => {
  globalThis.chrome = { runtime: { getManifest: () => (on ? { oauth2: { client_id: "x.apps.googleusercontent.com" } } : {}) }, ...(on ? { identity: {} } : {}) };
};
const CUSTOM = "시험용 사용자 지침";
const NAMED = { none: [], one: ["https://news.naver.com"], two: ["https://news.naver.com", "https://www.coupang.com"] };
const SITES = { none: [], one: ["https://example.com"], two: ["https://example.com", "https://shop.example.org"] };

const SNAP = {
  "system g=false q=false c=0": "a5f5e8ef2a62dfd5662ae907af29b467aaafb057fc226d688617f6114ad9c3c2",
  "system g=false q=false c=1": "a316269683a69d6a11d18010b2dfbbcaf5c092597679a86e42a455edfe226d85",
  "system g=false q=true c=0": "b0f534d1ed04399e05f3292c366ffe37038cfff33e275955c6e4515b95f382a9",
  "system g=false q=true c=1": "575c101924710a2354748e1c1d9e79dd76dde983d6fbf7aea2a4655e94b89eb8",
  "system g=true q=false c=0": "4e76551c5eb7d191802b9121ea3b85a896a763434e106fec1183a7e27d281ffb",
  "system g=true q=false c=1": "666c74c1aaf09f929de8a913362c60a597e312dc202e805c9d115009870977cb",
  "system g=true q=true c=0": "6fbd8cc298513991920b529872d5f5c38d89247ff4299455e313d0a6359ce1a3",
  "system g=true q=true c=1": "52467fb9358183a7ba6238fa944065a821e43eab7e2a5fffde1e0dd83b669075",
  "remote panel named=none ask=false sites=none": "e9b5c931c33c7c34b03c3b973c16a2baa89ace5e0310f4cbbcc0c8bd686395d0",
  "remote panel named=none ask=false sites=one": "31abe1f780df0cb1ed0b5b5578a63bbf4136e788f51a15deda64587bd506836c",
  "remote panel named=none ask=false sites=two": "cce20de157c132ea5ee26da1ff7cae0cf6aaa591a8435d28c62089620cc9eaf4",
  "remote panel named=none ask=true sites=none": "3e23b414a935bcb352f8e71b7cdcbbbff7048e5ad8520d36aa5342ab2a86248d",
  "remote panel named=none ask=true sites=one": "02da6da70e33a1ee2a21fc95562f448979c839b14d35bf885dad12bad0d10f84",
  "remote panel named=none ask=true sites=two": "0ba7b7d907cd7a05eae79f71a65f4bea7623f7fee2c32c812d52242f6baa166e",
  "remote panel named=one ask=false sites=none": "51b75efd1ca6900d51c0448778d342800238da6dc5b4356ad3596cfa8323d7ca",
  "remote panel named=one ask=false sites=one": "28521419e2a3d11f3597ba64cf5640572715f9aba60c142ae9055815fcd08cb2",
  "remote panel named=one ask=false sites=two": "2efaa444d373898d02b30e6a50b69cd65cc72e1c32b91357b9f1a728e05b4680",
  "remote panel named=one ask=true sites=none": "799b5bc35a647a1ea76db9214eb97dbda774680ee511ac49c982f1fa872d96cb",
  "remote panel named=one ask=true sites=one": "838045bd0416d3222702d3967757e1c36553970dafebe771e22c93f34e0cfee3",
  "remote panel named=one ask=true sites=two": "4fa4f442fcfd35bfb147cf6fc00f645a0f5a47598d09dea42a275c6b873c253b",
  "remote panel named=two ask=false sites=none": "4745420276621c26afbd79aecb4d77bb145c95cce1941c3126d7ed1651eff99f",
  "remote panel named=two ask=false sites=one": "0cb15442dc6652ac708f45c52f9fd9242c5197ad1c52d7bc520aef722dc52d35",
  "remote panel named=two ask=false sites=two": "6ef9d612fe84e4516458699e8ffb3506c486d4c704932917c67825e7b73d6102",
  "remote panel named=two ask=true sites=none": "5675268ca2d42dde2d350ec36fdd2628bc908ebf82852d79856fcfd2a87e2e77",
  "remote panel named=two ask=true sites=one": "aa025bc0101ee404afae7868b018c2d346f1ac3160b70bf2e462db0c68539339",
  "remote panel named=two ask=true sites=two": "8f6b05c2ec422c2ae8bbb4dbc91f73f8779117186d023e138a419d28c2673c6b",
  "remote telegram named=none ask=false sites=none": "e9b5c931c33c7c34b03c3b973c16a2baa89ace5e0310f4cbbcc0c8bd686395d0",
  "remote telegram named=none ask=false sites=one": "31abe1f780df0cb1ed0b5b5578a63bbf4136e788f51a15deda64587bd506836c",
  "remote telegram named=none ask=false sites=two": "cce20de157c132ea5ee26da1ff7cae0cf6aaa591a8435d28c62089620cc9eaf4",
  "remote telegram named=none ask=true sites=none": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=none ask=true sites=one": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=none ask=true sites=two": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=one ask=false sites=none": "51b75efd1ca6900d51c0448778d342800238da6dc5b4356ad3596cfa8323d7ca",
  "remote telegram named=one ask=false sites=one": "28521419e2a3d11f3597ba64cf5640572715f9aba60c142ae9055815fcd08cb2",
  "remote telegram named=one ask=false sites=two": "2efaa444d373898d02b30e6a50b69cd65cc72e1c32b91357b9f1a728e05b4680",
  "remote telegram named=one ask=true sites=none": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=one ask=true sites=one": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=one ask=true sites=two": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=two ask=false sites=none": "4745420276621c26afbd79aecb4d77bb145c95cce1941c3126d7ed1651eff99f",
  "remote telegram named=two ask=false sites=one": "0cb15442dc6652ac708f45c52f9fd9242c5197ad1c52d7bc520aef722dc52d35",
  "remote telegram named=two ask=false sites=two": "6ef9d612fe84e4516458699e8ffb3506c486d4c704932917c67825e7b73d6102",
  "remote telegram named=two ask=true sites=none": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=two ask=true sites=one": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote telegram named=two ask=true sites=two": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote mcp named=none ask=false sites=none": "7834221bdf91d6768c9969d3adeb70831d6ac52a4b583b63e0bb13fe1f7cc86c",
  "remote mcp named=none ask=false sites=one": "8c267ec09a5cf239563f0bb8f35c02b6408fb6860d4c2bb5b5864cb687c55c4e",
  "remote mcp named=none ask=false sites=two": "ad349abdc37a157d25fb6ca8afb8c30852752c71846e5ba410296cde6861899b",
  "remote mcp named=none ask=true sites=none": "8bcf36ea8960b9e952f8885fd2871ab0751b81e1d5c6fed710b641edf1011183",
  "remote mcp named=none ask=true sites=one": "e323025a63bc53809b660a199e6596f9cb45486d7d3dcc7232b24e1296c854a3",
  "remote mcp named=none ask=true sites=two": "ca3a29e9093f971af8ef7b1a17ed01eda68d62fd24fb7c7a7f7fdd85927ac8b6",
  "remote mcp named=one ask=false sites=none": "3645a1c7250c7b5d20a32ea51cda758a0c4549fc200ee250b9ee3c603879f87c",
  "remote mcp named=one ask=false sites=one": "108df35062e8561c6774e7dd97bf803e2fb5601ffaee97c7224dde48e8a892f5",
  "remote mcp named=one ask=false sites=two": "9431c0e77314e53422fb483980b8e18dcfb3624e0be72fb19c3dba5997538e4a",
  "remote mcp named=one ask=true sites=none": "2afcb703e737272cd9620d9ea9b0ee7f678364cdfa1ebd7ad24aae967999049a",
  "remote mcp named=one ask=true sites=one": "bfb26ede621321ce9ec4c9dad7e868ef066f6a0b3590d166b1f6fd872c262ff0",
  "remote mcp named=one ask=true sites=two": "bce156e77d95ed0ea4553cd609b631c6767e08b85f66d87f6b4b4f3108923bd8",
  "remote mcp named=two ask=false sites=none": "524eb4e71f07d5b9429076dfbe3f92f4cf042a37b53130a5e5d12c0cd100ab1c",
  "remote mcp named=two ask=false sites=one": "98e8146e5aea9fbd75d7a62dbe0cebf16aa397ea2e6aefe333d081a4a6f62989",
  "remote mcp named=two ask=false sites=two": "01c2e51f75a943dfb4745463b47e14fd808d7567af0c526ac0e053c0e23f1def",
  "remote mcp named=two ask=true sites=none": "ba5917ff1f40e12cfc15ca1650c606cae652cf7b22ad471be9b8ebff94b145f6",
  "remote mcp named=two ask=true sites=one": "a8a606110bfb87f087e96714274c42fc8e811587f892b01c10ada74468a2b0f4",
  "remote mcp named=two ask=true sites=two": "c1238aa3883bb3ba2d2491cca984bd903564e84fc857906f312fc77be9736321",
  "remote panel default-sites ask=false": "e9b5c931c33c7c34b03c3b973c16a2baa89ace5e0310f4cbbcc0c8bd686395d0",
  "remote panel default-sites ask=true": "3e23b414a935bcb352f8e71b7cdcbbbff7048e5ad8520d36aa5342ab2a86248d",
  "remote telegram default-sites ask=false": "e9b5c931c33c7c34b03c3b973c16a2baa89ace5e0310f4cbbcc0c8bd686395d0",
  "remote telegram default-sites ask=true": "550b8ee0bdae16aa11a2d3fd86e2a414c79c8c9a4906bb2f54ab813e22f7d14c",
  "remote mcp default-sites ask=false": "7834221bdf91d6768c9969d3adeb70831d6ac52a4b583b63e0bb13fe1f7cc86c",
  "remote mcp default-sites ask=true": "8bcf36ea8960b9e952f8885fd2871ab0751b81e1d5c6fed710b641edf1011183",
  "TARGET_CHANGED_NOTE": "ade59da01b07fdd83268930a53e71ef6716d3dada3b0e5269a4247ea1dd0d87a",
  "TASK_MODE_NOTE": "005077764e71dffdebd5bbe7080c10908d6da03e06479ff4fa7e00cc96a3c4ec",
  "REMOTE_REFUSED_NOTE": "1a96ca3be5ac4b52cb01e9cd69631e6537b75889c608838a555823f6bb9500df",
  "REMOTE_STOP_NOTE": "ad7789034ac1d9fefc7a71a32f61029c337cd28fcb60b68194c47dcc1f7b71fd",
  "LIMIT_STOP_NOTE": "e7bccfe3a87d52c94bdbf55af278767b26146729672ed29db75d060356efe9fe",
  "LIMIT_NO_ANSWER_NOTE": "1a17dd6edb80b995cfe407a08951574fcaeaf7f24db0611436b4d4649ce39100",
  "spin": "905059407491467eb2d8baf940756e4ec08a2396c3a7fa90d497c54f86a16054",
};

test("composeSystemPrompt: 빠르게 생각 켬·끔 × Google 있음·없음 × 사용자 지침 유무 스냅숏", () => {
  for (const g of [false, true]) {
    for (const q of [false, true]) {
      for (const c of ["", CUSTOM]) {
        setGoogle(g);
        const key = `system g=${g} q=${q} c=${c ? 1 : 0}`;
        assert.equal(sha(P.composeSystemPrompt(c, { quickThinking: q })), SNAP[key], key);
      }
    }
  }
  // 하네스 진단(prompt-fingerprint.mjs "panel system 기본")과 같은 글이다.
  assert.equal(SNAP["system g=false q=false c=0"], "a5f5e8ef2a62dfd5662ae907af29b467aaafb057fc226d688617f6114ad9c3c2");
});

test("composeSystemPrompt: Google 지침은 설정됐을 때만, 빠르게 생각은 Thought 규칙만 바꾼다", () => {
  setGoogle(true);
  assert.ok(P.composeSystemPrompt("").includes("Google Workspace 모드:"));
  setGoogle(false);
  const full = P.composeSystemPrompt("");
  const quick = P.composeSystemPrompt("", { quickThinking: true });
  assert.ok(!full.includes("Google Workspace 모드:"));
  assert.ok(full.includes("(a) 관측 결과에 근거한") && !full.includes("한 문장으로 말한다(Thought)"));
  assert.ok(quick.includes("한 문장으로 말한다(Thought)") && !quick.includes("(a) 관측 결과에 근거한"));
  assert.ok(!full.includes("\u0000"), "Thought 자리표시가 남지 않음");
});

test("availableTools: Google이 없으면 google_ 도구를 뺀다", () => {
  setGoogle(true);
  assert.deepEqual(P.availableTools(), functionDeclarations);
  setGoogle(false);
  const off = P.availableTools();
  assert.ok(functionDeclarations.some((f) => f.name.startsWith("google_")));
  assert.deepEqual(off, functionDeclarations.filter((f) => !f.name.startsWith("google_")));
});

test("remoteTurnNote: 채널 × 적은 사이트 × 물을 수 있음 × 원격 허용 사이트 전 조합 스냅숏", () => {
  setGoogle(false);
  for (const ch of ["panel", "telegram", "mcp"]) {
    for (const [nk, named] of Object.entries(NAMED)) {
      for (const ask of [false, true]) {
        for (const [sk, sites] of Object.entries(SITES)) {
          const key = `remote ${ch} named=${nk} ask=${ask} sites=${sk}`;
          assert.equal(sha(P.remoteTurnNote(ch, named, ask, sites)), SNAP[key], key);
        }
      }
    }
    // remoteSites를 빼면 빈 목록과 같다.
    for (const ask of [false, true]) {
      const key = `remote ${ch} default-sites ask=${ask}`;
      assert.equal(sha(P.remoteTurnNote(ch, [], ask)), SNAP[key], key);
      assert.equal(P.remoteTurnNote(ch, [], ask), P.remoteTurnNote(ch, [], ask, []));
    }
  }
  // 하네스 진단과 같은 글(원격 안내 + 요청 글).
  assert.equal(sha(`${P.remoteTurnNote("telegram", [], true)}\n\n요청: 오늘 경제 뉴스 정리해줘`), "5b2053387f0352cbc9d12a77f2cdee3b1e12007de4538e50fa5cffb760507896");
  assert.equal(sha(`${P.remoteTurnNote("mcp", ["https://news.naver.com"], false)}\n\n요청: news.naver.com 사회 뉴스 정리해줘`), "0793ebda90ab2862dcc377b5acb9fd1cec072560d3a13f7e8a0d2e083e0572cd");
});

test("안내 상수·spinStopNote 스냅숏", () => {
  for (const k of ["TARGET_CHANGED_NOTE", "TASK_MODE_NOTE", "REMOTE_REFUSED_NOTE", "REMOTE_STOP_NOTE", "LIMIT_STOP_NOTE", "LIMIT_NO_ANSWER_NOTE"]) assert.equal(sha(P[k]), SNAP[k], k);
  assert.equal(sha(P.spinStopNote("같은 클릭 3번")), SNAP.spin);
  assert.ok(P.spinStopNote("같은 클릭 3번").includes("(같은 클릭 3번)"));
});

test("repeatFailureNote(#318): 확장 안내 머리, 도구 이름·수·멈춤 수만 넣는다", () => {
  const n = P.repeatFailureNote("click_element", 2, 3);
  assert.ok(n.startsWith("[확장 안내 — 사용자 글 아님]"));
  assert.ok(n.includes("같은 도구(click_element)") && n.includes("2번 실패") && n.includes("3번째 실패하면"));
  assert.equal(P.repeatFailureNote("click_element", 2, 3).replace("click_element", "X"), P.repeatFailureNote("X", 2, 3));
});
