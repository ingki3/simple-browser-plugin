// 자동 로그인(docs/design/login-automation.md): KeePassXC 프로토콜, 비밀 값 가리기, 로그인 판정, 설정 정리.
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { incrementNonce, KpxSession, parseEntries, hostManifest } from "../src/lib/keepassxc.ts";
import { MASK, maskDeep, maskMessages, maskText, secretForms } from "../src/lib/secretMask.ts";
import { loginOrigin, loginShapeBlock, normalizeLoginSites, signInDecision } from "../src/lib/loginPolicy.ts";
import { normalizeSettings } from "../src/lib/settings.ts";

const b64 = (u) => Buffer.from(u).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

// KeePassXC를 흉내 내는 가짜 포트: change-public-keys와 암호화 요청을 실제 프로토콜대로 처리한다.
function fakeKeePassXC({ entries = [], totp = "123456", tamperNonce = false, deny = null } = {}) {
  // 실제 KeePassXC처럼 키 교환마다 새 키 쌍을 만든다.
  let host = nacl.box.keyPair();
  let clientKey = null;
  const msgL = [];
  const discL = [];
  const store = new Map();
  const sent = [];
  const reply = (m) => queueMicrotask(() => msgL.forEach((cb) => cb(m)));
  const port = {
    postMessage(m) {
      sent.push(m);
      if (m.action === "change-public-keys") {
        host = nacl.box.keyPair();
        clientKey = unb64(m.publicKey);
        reply({ action: m.action, publicKey: b64(host.publicKey), nonce: b64(incrementNonce(unb64(m.nonce))), success: "true" });
        return;
      }
      const nonce = unb64(m.nonce);
      const plain = nacl.box.open(unb64(m.message), nonce, clientKey, host.secretKey);
      const req = JSON.parse(Buffer.from(plain).toString("utf8"));
      if (deny === req.action) {
        reply({ action: m.action, error: "No logins found.", errorCode: "15" });
        return;
      }
      let body;
      if (req.action === "associate") {
        store.set("me", req.idKey);
        body = { id: "me", hash: "h" };
      } else if (req.action === "test-associate") {
        if (store.get(req.id) !== req.key) {
          reply({ action: m.action, error: "association failed", errorCode: "5" });
          return;
        }
        body = { id: req.id, hash: "h" };
      } else if (req.action === "get-logins") {
        body = { count: String(entries.length), entries, url: req.url };
      } else if (req.action === "get-totp") {
        body = { totp };
      }
      const rn = tamperNonce ? nonce : incrementNonce(nonce);
      const boxed = nacl.box(Buffer.from(JSON.stringify({ ...body, success: "true" })), rn, clientKey, host.secretKey);
      reply({ action: m.action, message: b64(boxed), nonce: b64(rn) });
    },
    onMessage: { addListener: (cb) => msgL.push(cb) },
    onDisconnect: { addListener: (cb) => discL.push(cb) },
    disconnect() {
      discL.forEach((cb) => cb());
    },
  };
  return { port, sent, disconnect: () => discL.forEach((cb) => cb()) };
}

const ENTRY = { login: "alice", name: "Example", password: "s3cr3t-pw!", uuid: "0123456789abcdef0123456789abcdef", totp: "000111" };

test("nonce 1 증가는 리틀 엔디안 올림", () => {
  assert.deepEqual([...incrementNonce(new Uint8Array([255, 0, 1]))], [0, 1, 1]);
  assert.deepEqual([...incrementNonce(new Uint8Array([255, 255]))], [0, 0]);
});

test("KeePassXC: 연결·확인·항목·일회용 코드", async () => {
  const kp = fakeKeePassXC({ entries: [ENTRY] });
  const s = new KpxSession(kp.port);
  const a = await s.associate();
  assert.equal(a.id, "me");
  await s.testAssociate(a);
  const got = await s.getLogins(a, "https://example.com/login");
  assert.equal(got.length, 1);
  assert.equal(got[0].password, ENTRY.password);
  assert.equal(await s.getTotp(ENTRY.uuid), "123456");
  // 보낸 메시지에는 비밀 값이 평문으로 없다(요청 자체에는 비밀이 없지만 action 외 필드는 암호화된다).
  assert.ok(kp.sent.every((m) => m.action === "change-public-keys" || typeof m.message === "string"));
});

test("KeePassXC: 동시에 들어온 첫 요청은 키 교환을 한 번만 한다", async () => {
  const kp = fakeKeePassXC({ entries: [ENTRY] });
  const s = new KpxSession(kp.port);
  const [a, code] = await Promise.all([s.associate(), s.getTotp(ENTRY.uuid)]);
  assert.equal(a.id, "me");
  assert.equal(code, "123456");
  assert.equal(kp.sent.filter((m) => m.action === "change-public-keys").length, 1);
});

test("KeePassXC: 항목 없음(15)은 빈 목록, 다른 연결 키는 거부", async () => {
  const kp = fakeKeePassXC({ deny: "get-logins" });
  const s = new KpxSession(kp.port);
  const a = await s.associate();
  assert.deepEqual(await s.getLogins(a, "https://example.com/"), []);
  await assert.rejects(s.testAssociate({ id: "me", idKey: "other" }), /association failed/);
});

test("KeePassXC: 응답 nonce가 맞지 않으면 버린다", async () => {
  const kp = fakeKeePassXC({ tamperNonce: true });
  const s = new KpxSession(kp.port);
  await assert.rejects(s.associate(), /nonce/);
});

test("KeePassXC: 연결이 끊기면 기다리던 요청이 실패", async () => {
  const kp = fakeKeePassXC();
  const s = new KpxSession(kp.port);
  await s.handshake();
  const p = s.call({ action: "get-totp", uuid: "x" }, 5_000);
  kp.disconnect();
  await assert.rejects(p, /끊겼/);
});

test("KeePassXC: 시간 초과면 세션을 버린다(늦은 응답이 다음 요청에 섞이지 않게)", async () => {
  let disconnected = false;
  const port = {
    postMessage() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    disconnect() {
      disconnected = true;
    },
  };
  const s = new KpxSession(port);
  await assert.rejects(s.handshake(20), /제때/);
  assert.ok(s.isClosed && disconnected);
});

test("항목 정리: uuid·비밀번호 없는 항목은 뺀다", () => {
  const out = parseEntries([ENTRY, { login: "x" }, { uuid: "u", password: "p", expired: "true" }]);
  assert.equal(out.length, 2);
  assert.equal(out[1].expired, true);
});

test("호스트 manifest는 이 확장 ID만 허용", () => {
  const m = JSON.parse(hostManifest("abcdefghijklmnopabcdefghijklmnop", "/x/keepassxc-proxy"));
  assert.deepEqual(m.allowed_origins, ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]);
  assert.equal(m.type, "stdio");
});

test("가리기: 값과 흔한 표현", () => {
  const pw = "p@ss w/rd+1";
  const forms = secretForms(pw);
  assert.ok(forms.includes(encodeURIComponent(pw)));
  assert.ok(forms.includes(Buffer.from(pw).toString("base64")));
  // 퍼센트 이스케이프만 소문자인 모양(일반 글자 대소문자는 그대로).
  assert.ok(maskText("x Ab%2fcD%2bEf y", ["Ab/cD+Ef"]).masked);
  // 입력 칸이 정리한 값(앞뒤 공백 제거)의 인코딩.
  assert.ok(maskText(`v=${Buffer.from("alice@example.com").toString("base64")}`, [" alice@example.com "]).masked);
  // 폼 인코딩(URLSearchParams)과 그 소문자 이스케이프.
  const formPw = "p@ss!w (x)~";
  const enc = new URLSearchParams({ password: formPw }).toString();
  assert.ok(maskText(`/login?${enc}`, [formPw]).masked, enc);
  assert.ok(maskText(`/login?${enc.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`, [formPw]).masked);
  for (const f of forms) {
    const r = maskText(`앞 ${f} 뒤`, [pw]);
    assert.ok(r.masked, f);
    assert.ok(!r.text.includes(f));
  }
  assert.equal(maskText("no secret", [pw]).masked, false);
  // 1~2글자는 가리지 않는다(문장 전체를 망가뜨림).
  assert.equal(maskText("a b", ["a"]).masked, false);
});

test("가리기: 공백을 줄이거나 한도로 자른 글자", () => {
  const pw = "correct  horse  battery";
  assert.ok(maskText("보임 correct horse battery 끝", [pw]).masked);
  const cut = maskText("앞 글자 correct horse bat", [pw]);
  assert.ok(cut.masked);
  assert.ok(!cut.text.includes("horse"));
  assert.ok(maskText("battery 뒤 글자", ["horse battery"]).masked);
  // 잘린 행 문맥이 오류 문장 중간에 들어간 경우(6글자 이상 조각).
  const mid = maskText("대상 'f1'의 행 내용 '…로그인됨 Harness-Pw'. 다시 찾으세요", ["Harness-Pw-7731!"]);
  assert.ok(mid.masked && !mid.text.includes("Harness-Pw"));
  // 잘림 표시가 붙은 조각(본문 한도), 직렬화한 글자 안에서도.
  const trunc = maskText(JSON.stringify({ mainText: "본문 Harness-Pw…", n: 1 }), ["Harness-Pw-7731!"]);
  assert.ok(trunc.masked && !trunc.text.includes("Harness-Pw"));
});

test("가리기: JSON으로 직렬화한 글자 안의 값(따옴표·역슬래시)", () => {
  const pw = 'a"b\\c';
  const json = JSON.stringify({ text: `보임 ${pw}` });
  const r = maskText(json, [pw]);
  assert.ok(r.masked);
  assert.ok(!JSON.parse(r.text).text.includes(pw));
});

test("가리기: 메시지는 본문만(역할·도구 id는 그대로)", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "제목: 안녕 user" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "user", type: "function", function: { name: "sign_in", arguments: '{"id":"user"}' } }] },
    { role: "tool", tool_call_id: "user", name: "describe_page", content: "user 님" },
  ];
  const r = maskMessages(msgs, ["user"]);
  assert.ok(r.masked);
  assert.deepEqual(r.value.map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(r.value[2].tool_call_id, "user");
  assert.equal(r.value[1].tool_calls[0].id, "user");
  assert.equal(r.value[0].content[0].type, "text");
  assert.ok(!r.value[0].content[0].text.includes("user"));
  assert.ok(!r.value[2].content.includes("user"));
});

test("가리기: JSON 값 안 깊이(키는 그대로)", () => {
  const r = maskDeep({ a: ["hello alice"], alice: 1, n: 3 }, ["alice"]);
  assert.ok(r.masked);
  assert.deepEqual(r.value, { a: [`hello ${MASK}`], alice: 1, n: 3 });
  const same = { a: 1 };
  assert.equal(maskDeep(same, []).value, same);
});

test("로그인 출처: https만(localhost 예외)", () => {
  assert.equal(loginOrigin("https://a.example/login?x=1"), "https://a.example");
  assert.equal(loginOrigin("http://a.example/"), null);
  assert.equal(loginOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(loginOrigin("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080");
  assert.equal(loginOrigin("chrome://settings"), null);
});

test("승인 사이트 정리: 정확한 출처·uuid만, 중복 없음", () => {
  const ok = { origin: "https://a.example", uuid: "0123456789ABCDEF0123456789ABCDEF", entryName: "A", totp: true };
  const out = normalizeLoginSites([
    ok,
    { ...ok, entryName: "dup" },
    { origin: "https://b.example/path", uuid: ok.uuid },
    { origin: "http://b.example", uuid: ok.uuid },
    { origin: "https://c.example", uuid: "nope" },
  ]);
  assert.deepEqual(out, [{ ...ok, uuid: ok.uuid.toLowerCase() }]);
  assert.deepEqual(normalizeSettings({}).loginSites, []);
  assert.equal(normalizeSettings({ loginSites: [ok] }).loginSites.length, 1);
});

const ORIGIN = "https://acc.example";
const shape = (over = {}) => ({
  step: "password",
  frameUrl: `${ORIGIN}/login`,
  topUrl: `${ORIGIN}/login`,
  newPassword: false,
  otherFields: false,
  hasForm: true,
  submitUrls: [`${ORIGIN}/session`],
  submitMethods: ["post"],
  usernameId: "f1",
  passwordId: "f2",
  submitId: "c1",
  fields: [{ tag: "input", role: "", text: "", href: "", name: "Password", fieldType: "password", sensitive: "password" }],
  submit: { tag: "button", role: "button", text: "로그인", href: "", name: "로그인", fieldType: "", sensitive: null },
  ...over,
});

test("로그인 모양: 막는 구조", () => {
  assert.equal(loginShapeBlock(shape(), ORIGIN), null);
  assert.match(loginShapeBlock(shape({ submitUrls: ["https://evil.example/collect"] }), ORIGIN), /다른 출처/);
  // 다른 승인 사이트라도 출처가 다르면 막는다.
  assert.match(loginShapeBlock(shape({ submitUrls: ["https://www.acc.example/s"] }), ORIGIN), /다른 출처/);
  assert.match(loginShapeBlock(shape({ submitMethods: ["get"] }), ORIGIN), /POST/);
  assert.match(loginShapeBlock(shape({ submitMethods: ["post", "dialog"] }), ORIGIN), /POST/);
  assert.match(loginShapeBlock(shape({ newPassword: true }), ORIGIN), /새 비밀번호/);
  assert.match(loginShapeBlock(shape({ otherFields: true }), ORIGIN), /입력 칸/);
  assert.match(loginShapeBlock(shape({ otherTarget: true }), ORIGIN), /다른 창/);
  assert.match(loginShapeBlock(shape({ fields: [{ ...shape().fields[0], sensitive: "payment" }] }), ORIGIN), /결제/);
  assert.match(loginShapeBlock(shape({ topUrl: "https://other.example/" }), ORIGIN), /끼워 넣은/);
  assert.match(loginShapeBlock(shape({ frameUrl: "http://acc.example/login" }), ORIGIN), /https/);
  assert.match(loginShapeBlock(shape({ submitUrls: ["about:too-many-forms"] }), ORIGIN), /다른 출처/);
  // 같은 출처 주소 안에 실린 다른 출처(리다이렉트 매개변수), 숨은 칸 값으로 실린 목적지.
  assert.match(loginShapeBlock(shape({ submitUrls: [`${ORIGIN}/redirect?next=https%3A%2F%2Fevil.test%2Fcollect`] }), ORIGIN), /다른 출처/);
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, submitUrl: `${ORIGIN}/session?next=https://evil.test/c` } }), ORIGIN));
  assert.equal(loginShapeBlock(shape({ submitUrls: [`${ORIGIN}/session?next=${encodeURIComponent(`${ORIGIN}/home`)}`] }), ORIGIN), null);
  // 계정 삭제 재인증처럼 삭제 신호가 있는 제출 버튼, 결제 버튼은 묻는다.
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, name: "계정 삭제", text: "계정 삭제" } }), ORIGIN));
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, deleteMethod: true } }), ORIGIN));
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, name: "결제하기", text: "결제하기" } }), ORIGIN));
  // 결제 주소로 보내는 양식(결제 재인증), 결제 주소를 가리키는 제출 버튼은 묻는다.
  assert.match(loginShapeBlock(shape({ submitUrls: [`${ORIGIN}/checkout/confirm`] }), ORIGIN), /결제/);
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, submitTo: `${ORIGIN}/checkout/pay` } }), ORIGIN));
  // 숨은 칸 값까지 합친 제출 주소에 결제 신호(operation=pay)가 있으면 묻는다.
  assert.match(loginShapeBlock(shape({ submit: { ...shape().submit, submitUrl: `${ORIGIN}/session?operation=pay` } }), ORIGIN), /결제/);
  assert.match(loginShapeBlock(shape({ fields: [{ ...shape().fields[0], submitUrl: `${ORIGIN}/session?operation=checkout` }] }), ORIGIN), /결제/);
  // htmx 요청: 다른 출처, 같은 출처라도 GET(값이 주소에 실림), 확인할 수 없는 요청은 묻는다.
  const pwField = shape().fields[0];
  assert.match(loginShapeBlock(shape({ fields: [{ ...pwField, requestUrls: ["https://collector.example/c"] }] }), ORIGIN), /다른 출처/);
  assert.match(loginShapeBlock(shape({ fields: [{ ...pwField, requestUrls: [`${ORIGIN}/check`] }] }), ORIGIN), /GET/);
  assert.ok(loginShapeBlock(shape({ hasForm: false, submitMethods: [], fields: [{ ...pwField, opaqueRequest: true }] }), ORIGIN));
  // 양식이 없으면(채우기만) 메서드는 보지 않는다.
  assert.equal(loginShapeBlock(shape({ hasForm: false, submitMethods: [], submitUrls: [] }), ORIGIN), null);
});

const SITE = { origin: ORIGIN, uuid: ENTRY.uuid, entryName: "A", totp: false };
const decide = (over = {}) =>
  signInDecision({
    shape: shape(),
    origin: ORIGIN,
    site: SITE,
    entryUuids: [ENTRY.uuid],
    attempted: false,
    maskedHere: false,
    guarded: false,
    ...over,
  });

test("자동 로그인 판정", () => {
  assert.deepEqual(decide(), { auto: true });
  assert.equal(decide({ site: null }).auto, false);
  assert.equal(decide({ entryUuids: ["ffffffffffffffffffffffffffffffff"] }).auto, false);
  assert.equal(decide({ attempted: true }).auto, false);
  assert.equal(decide({ maskedHere: true }).auto, false);
  assert.equal(decide({ guarded: true }).auto, false);
  assert.equal(decide({ shape: shape({ step: "otp" }) }).auto, false);
  assert.deepEqual(decide({ shape: shape({ step: "otp" }), site: { ...SITE, totp: true } }), { auto: true });
  assert.equal(decide({ shape: shape({ submitMethods: ["get"] }) }).auto, false);
});
