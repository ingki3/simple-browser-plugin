// 자동 로그인(docs/design/login-automation.md): KeePassXC 프로토콜, 비밀 값 가리기, 로그인 판정, 설정 정리.
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { incrementNonce, KpxSession, parseEntries, hostManifest } from "../src/lib/keepassxc.ts";
import { MASK, maskDeep, maskText, secretForms } from "../src/lib/secretMask.ts";
import { loginOrigin, loginShapeBlock, normalizeLoginSites, signInDecision } from "../src/lib/loginPolicy.ts";
import { normalizeSettings } from "../src/lib/settings.ts";

const b64 = (u) => Buffer.from(u).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));

// KeePassXC를 흉내 내는 가짜 포트: change-public-keys와 암호화 요청을 실제 프로토콜대로 처리한다.
function fakeKeePassXC({ entries = [], totp = "123456", tamperNonce = false, deny = null } = {}) {
  const host = nacl.box.keyPair();
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
  for (const f of forms) {
    const r = maskText(`앞 ${f} 뒤`, [pw]);
    assert.ok(r.masked, f);
    assert.ok(!r.text.includes(f));
  }
  assert.equal(maskText("no secret", [pw]).masked, false);
  // 1~2글자는 가리지 않는다(문장 전체를 망가뜨림).
  assert.equal(maskText("a b", ["a"]).masked, false);
});

test("가리기: JSON으로 직렬화한 글자 안의 값(따옴표·역슬래시)", () => {
  const pw = 'a"b\\c';
  const json = JSON.stringify({ text: `보임 ${pw}` });
  const r = maskText(json, [pw]);
  assert.ok(r.masked);
  assert.ok(!JSON.parse(r.text).text.includes(pw));
});

test("가리기: JSON 값 안 깊이(키 포함)", () => {
  const r = maskDeep({ a: ["hello alice"], alice: 1, n: 3 }, ["alice"]);
  assert.ok(r.masked);
  assert.deepEqual(r.value, { a: [`hello ${MASK}`], [MASK]: 1, n: 3 });
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
  assert.match(loginShapeBlock(shape({ topUrl: "https://other.example/" }), ORIGIN), /끼워 넣은/);
  assert.match(loginShapeBlock(shape({ frameUrl: "http://acc.example/login" }), ORIGIN), /https/);
  assert.match(loginShapeBlock(shape({ submitUrls: ["about:too-many-forms"] }), ORIGIN), /다른 출처/);
  // 계정 삭제 재인증처럼 삭제 신호가 있는 제출 버튼, 결제 버튼은 묻는다.
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, name: "계정 삭제", text: "계정 삭제" } }), ORIGIN));
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, deleteMethod: true } }), ORIGIN));
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, name: "결제하기", text: "결제하기" } }), ORIGIN));
  // 결제 주소로 보내는 양식(결제 재인증), 결제 주소를 가리키는 제출 버튼은 묻는다.
  assert.match(loginShapeBlock(shape({ submitUrls: [`${ORIGIN}/checkout/confirm`] }), ORIGIN), /결제/);
  assert.ok(loginShapeBlock(shape({ submit: { ...shape().submit, submitTo: `${ORIGIN}/checkout/pay` } }), ORIGIN));
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
