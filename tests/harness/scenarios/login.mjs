// 자동 로그인(sign_in, docs/design/login-automation.md): 가짜 KeePassXC(native messaging 호스트)로 승인 사이트 자동 로그인,
// 카드에서 고르고 승인 사이트로 묶기, 구조로 막는 경우(GET·다른 출처), 연결 전 손 넘기기, 값 가리기를 본다.
import { expect, lastTool, okResult } from "../lib.mjs";

const UUID = "0123456789abcdef0123456789abcdef";
const PW = "Harness-Pw-7731!";
const USER = "alice.harness";
const findF = { tool: "find_form_fields", args: {} };
const describe = { tool: "describe_page", args: {} };

// action·method를 바꿔 쓰는 로그인 양식. 제출하면 양식을 지우고 받은 값을 화면에 다시 보여 준다(가리기 시험).
const loginPage = ({ action = "/session", method = "post" } = {}) => `<title>Login</title><main>
<form id=f action="${action}" method="${method}" onsubmit="event.preventDefault();const u=this.u.value,p=this.p.value;this.remove();document.getElementById('out').textContent='로그인됨 '+u+' / '+p">
<label>아이디 <input name=u autocomplete=username></label>
<label>비밀번호 <input name=p type=password autocomplete=current-password></label>
<button>로그인</button></form><p id=out></p></main>`;

async function connect(h, { approve = true } = {}) {
  const kp = h.installKeePassXC({
    entries: [{ url: `${h.base}/`, uuid: UUID, name: "Harness", login: USER, password: PW }],
    associations: { harness: "IDKEY" },
    totp: "424242",
  });
  await h.sw.evaluate(async () => {
    await chrome.storage.local.set({ keepassxcAssociation: { id: "harness", idKey: "IDKEY" } });
  });
  if (approve) await h.settings({ loginSites: [{ origin: h.base, uuid: UUID, entryName: "Harness", totp: false }] });
  return kp;
}

const modelSaw = (h, needle) =>
  h.sw.evaluate((n) => (globalThis.__modelReqs ?? []).some((r) => JSON.stringify(r.body).includes(n)), needle);

export default [
  {
    name: "승인한 사이트: 카드 없이 넣고 제출하며, 화면에 다시 보인 값은 모델에 가지 않는다",
    pages: { "/login": loginPage() },
    async run(h) {
      await connect(h);
      const r = await h.turn([findF, { signIn: "password" }, describe], { path: "/login" });
      expect(r.cards === 0, `카드 없이 실행(cards=${r.cards})`);
      expect(r.out === `로그인됨 ${USER} / ${PW}`, `값이 들어가 제출됨(out='${r.out}')`);
      const res = okResult(r, "sign_in");
      expect(res.submitted === true && res.step === "password", `제출함(${JSON.stringify(res)})`);
      const d = lastTool(r, "describe_page");
      expect(d && JSON.stringify(d).includes("[가린 값]"), "관측 결과에서 값을 가림");
      expect(!(await modelSaw(h, PW)), "비밀번호가 모델 요청에 없다");
      expect(!(await modelSaw(h, USER)), "아이디가 모델 요청에 없다");
    },
  },
  {
    name: "비밀번호 앞의 주소 칸을 아이디로 쓰지 않고 묻는다",
    pages: {
      "/addr": `<title>Addr</title><main><form method=post action="/update" onsubmit="event.preventDefault();document.getElementById('out').textContent='저장됨'">
<label>주소 <input name=a autocomplete=street-address></label>
<label>비밀번호 <input name=p type=password autocomplete=current-password></label>
<button>저장</button></form><p id=out></p></main>`,
    },
    async run(h) {
      await connect(h);
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/addr",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /입력 칸/.test(summary), `카드에 이유(${summary})`);
      expect((await h.tab.locator("input[name=a]").inputValue()) === "", "주소 칸에 넣지 않음");
    },
  },
  {
    name: "일회용 코드: 코드 켠 사이트에서 넣고, 입력하자마자 페이지가 제출하면 다시 제출하지 않는다",
    pages: {
      "/otp": `<title>OTP</title><main><form id=f method=post action="/otp" oninput="if(this.c.value.length===6)this.requestSubmit()" onsubmit="event.preventDefault();const o=document.getElementById('out');o.textContent=String(Number(o.textContent||0)+1)">
<label>인증 코드 <input name=c autocomplete=one-time-code inputmode=numeric></label><button>확인</button></form><p id=out></p></main>`,
    },
    async run(h) {
      const kp = await connect(h, { approve: false });
      await h.settings({ loginSites: [{ origin: h.base, uuid: UUID, entryName: "Harness", totp: true }] });
      const r = await h.turn([findF, { signIn: "인증 코드" }], { path: "/otp" });
      expect(r.cards === 0, `카드 없이(cards=${r.cards})`);
      expect(r.out === "1", `한 번만 제출(out='${r.out}')`);
      expect(kp.state().log.some((l) => l.action === "get-totp"), "KeePassXC에서 코드를 받음");
    },
  },
  {
    name: "Enter용 숨은 제출 버튼이 있어도 로그인한다",
    pages: {
      "/login": `<title>Login</title><main><form method=post action="/session" onsubmit="event.preventDefault();this.remove();document.getElementById('out').textContent='제출됨'">
<button type=submit style="display:none">숨은 제출</button>
<label>아이디 <input name=u autocomplete=username></label>
<label>비밀번호 <input name=p type=password autocomplete=current-password></label></form><p id=out></p></main>`,
    },
    async run(h) {
      await connect(h);
      const r = await h.turn([findF, { signIn: "password" }], { path: "/login" });
      expect(r.cards === 0 && r.out === "제출됨", `카드 없이 제출(cards=${r.cards}, out='${r.out}')`);
    },
  },
  {
    name: "기본 제출이 '계정 삭제' 이미지 버튼이면 묻는다",
    pages: {
      "/reauth": `<title>Reauth</title><main><form method=post action="/confirm" onsubmit="event.preventDefault();document.getElementById('out').textContent='제출됨'">
<label>비밀번호 <input name=p type=password autocomplete=current-password></label>
<input type=image alt="계정 삭제" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width=40 height=20></form><p id=out></p></main>`,
    },
    async run(h) {
      await connect(h);
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/reauth",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /되돌리기 어려운|삭제/.test(summary), `카드에 이유(${summary})`);
      expect(r.out === "", "제출하지 않음");
    },
  },
  {
    name: "브라우저 입력 검사에 막히면 제출했다고 하지 않는다",
    pages: {
      "/login": `<title>Login</title><main><form method=post action="/session" onsubmit="event.preventDefault();document.getElementById('out').textContent='제출됨'">
<label>아이디 <input name=u autocomplete=username pattern="[0-9]+"></label>
<label>비밀번호 <input name=p type=password autocomplete=current-password></label><button>로그인</button></form><p id=out></p></main>`,
    },
    async run(h) {
      await connect(h);
      const r = await h.turn([findF, { signIn: "password" }], { path: "/login" });
      const t = lastTool(r, "sign_in");
      expect(r.out === "", `제출되지 않음(out='${r.out}')`);
      expect(t?.result?.submitted === false, `결과가 제출 안 함(${JSON.stringify(t)})`);
    },
  },
  {
    name: "값을 넣어야 켜지는 로그인 버튼도 제출한다",
    pages: {
      "/login": `<title>Login</title><main>
<form id=f action="/session" method="post" oninput="document.getElementById('go').disabled=!(this.u.value&&this.p.value)" onsubmit="event.preventDefault();this.remove();document.getElementById('out').textContent='제출됨'">
<label>아이디 <input name=u autocomplete=username></label>
<label>비밀번호 <input name=p type=password autocomplete=current-password></label>
<button id=go disabled>로그인</button></form><p id=out></p></main>`,
    },
    async run(h) {
      await connect(h);
      const r = await h.turn([findF, { signIn: "password" }], { path: "/login" });
      expect(r.cards === 0, `카드 없이(cards=${r.cards})`);
      expect(r.out === "제출됨", `제출됨(out='${r.out}')`);
    },
  },
  {
    name: "승인하지 않은 사이트: 카드에서 항목을 골라 로그인하고 앞으로 자동 로그인으로 묶는다",
    pages: { "/login": loginPage() },
    async run(h) {
      await connect(h, { approve: false });
      let sawChoice = false;
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/login",
        onCard: async (card) => {
          sawChoice = (await card.locator(".tool-card-choices li").count()) === 1;
          await card.locator(".tool-card-choices input").check();
          await card.locator(".btn-approve-login-site").click();
        },
      });
      expect(sawChoice, "항목 하나를 고르는 카드");
      expect(r.out === `로그인됨 ${USER} / ${PW}`, `값이 들어가 제출됨(out='${r.out}')`);
      const sites = await h.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings.loginSites);
      expect(sites?.length === 1 && sites[0].origin === h.base && sites[0].uuid === UUID, `승인 사이트로 묶음(${JSON.stringify(sites)})`);
    },
  },
  {
    name: "공백이 붙은 method(' post ')는 브라우저가 GET으로 보므로 묻는다",
    pages: { "/login": loginPage({ method: " post " }) },
    async run(h) {
      await connect(h);
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/login",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /POST/.test(summary), `카드에 이유(${summary})`);
    },
  },
  {
    name: "GET 양식은 승인한 사이트라도 묻고, 취소하면 넣지 않는다",
    pages: { "/login": loginPage({ method: "get" }) },
    async run(h) {
      await connect(h);
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/login",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /POST/.test(summary), `카드에 이유(${summary})`);
      expect(r.out === "", `넣지 않음(out='${r.out}')`);
      const v = await h.tab.locator("input[name=p]").inputValue();
      expect(v === "", "비밀번호 칸이 비어 있다");
    },
  },
  {
    name: "다른 출처로 보내는 양식은 묻는다",
    pages: { "/login": "" },
    async run(h) {
      h.pages.set("1/login", loginPage({ action: `${h.base2}/collect` }));
      await connect(h);
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/login",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /다른 출처/.test(summary), `카드에 이유(${summary})`);
      expect(r.out === "", "넣지 않음");
    },
  },
  {
    name: "로그인 칸 밖의 입력 칸이 있는 양식(정보 수정)은 승인한 사이트라도 묻는다",
    pages: {
      "/profile": `<title>Profile</title><main><form method=post action="/update" onsubmit="event.preventDefault();document.getElementById('out').textContent='저장됨'">
<label>주소 <input name=addr value="서울시 어딘가 1"></label>
<label>아이디 <input name=u autocomplete=username></label>
<label>현재 비밀번호 <input name=p type=password autocomplete=current-password></label>
<button>저장</button></form><p id=out></p></main>`,
    },
    async run(h) {
      await connect(h);
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/profile",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /입력 칸/.test(summary), `카드에 이유(${summary})`);
      expect(r.out === "", "제출하지 않음");
    },
  },
  {
    name: "비밀번호 관리자를 연결하지 않았으면 칸을 표시해 직접 로그인하게 한다",
    pages: { "/login": loginPage() },
    async run(h) {
      let handoff = false;
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/login",
        onCard: async (card, n) => {
          if (n > 1) return;
          handoff = (await card.locator(".tool-card-title").innerText()).length > 0 && (await card.locator(".tool-card-summary").innerText()).includes("직접 로그인");
          await card.locator(".btn-approve").click();
        },
      });
      expect(handoff, "직접 로그인 안내 카드");
      const res = okResult(r, "sign_in");
      expect(res.handedOff === true, `손 넘기기 결과(${JSON.stringify(res)})`);
      expect(r.out === "", "값을 넣지 않음");
    },
  },
  {
    name: "같은 대화에서 같은 사이트를 다시 자동으로 하지 않는다",
    pages: { "/login": loginPage() },
    async run(h) {
      await connect(h);
      await h.turn([findF, { signIn: "password" }], { path: "/login" });
      let summary = "";
      const r = await h.turn([findF, { signIn: "password" }], {
        path: "/login",
        onCard: async (card) => {
          summary = await card.locator(".tool-card-summary").innerText();
          await card.locator(".btn-cancel").click();
        },
      });
      expect(r.cards === 1 && /이미 자동 로그인/.test(summary), `두 번째는 묻는다(${summary})`);
    },
  },
];
