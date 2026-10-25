// 하네스용 가짜 KeePassXC(native messaging 호스트). Chrome이 keepassxc-proxy 대신 이 스크립트를 띄운다(래퍼 셸 스크립트가
// 상태 파일 경로를 첫 인자로 넘긴다). KeePassXC-Browser 프로토콜의 change-public-keys·associate·test-associate·get-logins·
// get-totp를 실제 암호화(tweetnacl box)로 처리한다. 상태 파일: { entries, associations, totp, log }.
// 항목 조회는 실제 KeePassXC처럼 호스트 이름으로 맞춘다(같은 호스트의 다른 포트도 돌려준다 — 출처 묶음 시험용).
import { readFileSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";

const statePath = process.argv[2];
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
const log = (entry) => {
  const s = load();
  (s.log ??= []).push(entry);
  save(s);
};

const b64 = (u) => Buffer.from(u).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
function inc(nonce) {
  const out = new Uint8Array(nonce);
  let carry = 1;
  for (let i = 0; i < out.length; i++) {
    carry += out[i];
    out[i] = carry & 0xff;
    carry >>= 8;
  }
  return out;
}

const host = nacl.box.keyPair();
let clientKey = null;
let associated = false;

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([len, body]));
}

function handle(m) {
  if (m.action === "change-public-keys") {
    clientKey = unb64(m.publicKey);
    log({ action: m.action });
    return send({ action: m.action, publicKey: b64(host.publicKey), nonce: b64(inc(unb64(m.nonce))), success: "true", version: "2.7.9" });
  }
  const nonce = unb64(m.nonce);
  const plain = nacl.box.open(unb64(m.message), nonce, clientKey, host.secretKey);
  if (!plain) return send({ action: m.action, error: "Cannot decrypt message", errorCode: "4" });
  const req = JSON.parse(Buffer.from(plain).toString("utf8"));
  const state = load();
  const err = (error, errorCode) => {
    log({ action: req.action, error });
    send({ action: m.action, error, errorCode: String(errorCode) });
  };
  let body;
  if (req.action === "associate") {
    const id = "harness";
    state.associations = { ...(state.associations ?? {}), [id]: req.idKey };
    save(state);
    associated = true;
    body = { id, hash: "h" };
  } else if (req.action === "test-associate") {
    if ((state.associations ?? {})[req.id] !== req.key) return err("Association failed", 5);
    associated = true;
    body = { id: req.id, hash: "h" };
  } else if (req.action === "get-logins") {
    if (!associated) return err("Association failed", 5);
    let hostName = "";
    try {
      hostName = new URL(req.url).hostname;
    } catch {
      /* 빈 이름 */
    }
    const found = (state.entries ?? []).filter((e) => {
      try {
        return new URL(e.url).hostname === hostName;
      } catch {
        return false;
      }
    });
    log({ action: req.action, url: req.url, count: found.length });
    if (!found.length) return err("No logins found", 15);
    body = { count: String(found.length), entries: found.map(({ url: _u, ...rest }) => rest), hash: "h" };
  } else if (req.action === "get-totp") {
    log({ action: req.action, uuid: req.uuid });
    body = { totp: state.totp ?? "" };
  } else {
    return err("Unknown action", 12);
  }
  if (req.action !== "get-logins") log({ action: req.action });
  const rn = inc(nonce);
  const boxed = nacl.box(Buffer.from(JSON.stringify({ ...body, success: "true", version: "2.7.9" })), rn, clientKey, host.secretKey);
  send({ action: m.action, message: b64(boxed), nonce: b64(rn) });
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    try {
      handle(msg);
    } catch (e) {
      send({ action: msg.action, error: String(e), errorCode: "0" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
