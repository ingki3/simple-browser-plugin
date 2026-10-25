// KeePassXC 연결(자동 로그인, docs/design/login-automation.md). KeePassXC-Browser 프로토콜을 native messaging(keepassxc-proxy)으로
// 주고받는다. 이 파일은 순수 프로토콜(암호화·nonce·요청 짝 맞추기)만 다루고, 포트는 부르는 쪽이 넘긴다(테스트에서 가짜 포트).
// - 세션마다 새 키 쌍(client key)을 만들어 change-public-keys로 KeePassXC의 세션 키(host key)를 받는다.
// - 그 뒤 요청은 nacl.box(JSON, nonce, host 공개 키, client 비밀 키)로 보내고, 응답의 nonce는 요청 nonce를 1 올린 값이어야 한다.
// - 연결 정보(associate로 받은 id와 식별 공개 키)만 저장한다. 프로토콜은 식별 키의 공개 부분만 쓴다(KeePassXC 문서의 한계).
// 받은 비밀번호·일회용 코드는 여기서 저장하거나 기록하지 않는다. 오류 문구에도 넣지 않는다.
import nacl from "tweetnacl";

export const KEEPASSXC_HOST = "com.simple_browser_helper.keepassxc";

// 연결 정보(associate 결과). chrome.storage.local에 둔다(비밀 값 아님 — KeePassXC가 잠금 해제·접근 허락을 다시 확인한다).
export interface KpxAssociation {
  id: string;
  idKey: string;
}

export interface KpxEntry {
  uuid: string;
  name: string;
  login: string;
  password: string;
  // 항목에 TOTP가 있으면 KeePassXC가 지금 코드를 함께 준다.
  totp?: string;
  expired?: boolean;
}

// native messaging 포트의 필요한 부분(chrome.runtime.Port와 같은 모양).
export interface KpxPort {
  postMessage(msg: unknown): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

export class KpxError extends Error {
  // KeePassXC가 준 오류 번호(없으면 0). 15: 항목 없음, 1: 데이터베이스가 열려 있지 않음 등.
  readonly code: number;
  constructor(message: string, code = 0) {
    super(message);
    this.code = code;
  }
}

export const KPX_ERROR_NO_LOGINS = 15;
export const KPX_ERROR_DB_NOT_OPENED = 1;

const b64 = (u: Uint8Array): string => {
  let s = "";
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// libsodium sodium_increment과 같은 리틀 엔디안 1 증가(KeePassXC 응답 nonce 확인용).
export function incrementNonce(nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(nonce);
  let carry = 1;
  for (let i = 0; i < out.length; i++) {
    carry += out[i];
    out[i] = carry & 0xff;
    carry >>= 8;
  }
  return out;
}

interface Pending {
  action: string;
  nonce: string;
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// 한 포트의 세션. 요청은 한 번에 하나씩 보낸다(KeePassXC는 차례로 답하고, 응답은 action으로 짝을 맞춘다).
export class KpxSession {
  private readonly keys = nacl.box.keyPair();
  private readonly clientId = b64(nacl.randomBytes(24));
  private hostKey: Uint8Array | null = null;
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed: string | null = null;

  private readonly port: KpxPort;

  constructor(port: KpxPort) {
    this.port = port;
    port.onMessage.addListener((msg) => this.onMessage(msg));
    port.onDisconnect.addListener(() => this.fail("KeePassXC 연결이 끊겼습니다."));
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  close(): void {
    this.fail("KeePassXC 연결을 닫았습니다.");
    try {
      this.port.disconnect();
    } catch {
      /* 이미 끊김 */
    }
  }

  private fail(why: string): void {
    if (this.closed === null) this.closed = why;
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new KpxError(why));
    }
  }

  private onMessage(raw: unknown): void {
    const p = this.pending;
    if (!p || !raw || typeof raw !== "object") return;
    const msg = raw as Record<string, unknown>;
    // 잠금·잠금 해제 알림 등 요청하지 않은 메시지는 건너뛴다.
    if (msg.action !== p.action) return;
    this.pending = null;
    clearTimeout(p.timer);
    if (typeof msg.error === "string" || (msg.errorCode !== undefined && msg.success !== "true")) {
      p.reject(new KpxError(`KeePassXC: ${String(msg.error ?? "요청이 거부되었습니다")}`, Number(msg.errorCode) || 0));
      return;
    }
    p.resolve(msg);
  }

  // 요청 하나를 보내고 같은 action의 응답을 기다린다. 앞 요청이 끝난 뒤 보낸다.
  private request(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const run = () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (this.closed !== null) return reject(new KpxError(this.closed));
        const action = String(body.action);
        const timer = setTimeout(() => {
          if (this.pending?.action === action) this.pending = null;
          reject(new KpxError("KeePassXC가 제때 답하지 않았습니다(잠금 해제나 허락 창을 확인하세요)."));
        }, timeoutMs);
        this.pending = { action, nonce: String(body.nonce ?? ""), resolve, reject, timer };
        try {
          this.port.postMessage(body);
        } catch (err) {
          clearTimeout(timer);
          this.pending = null;
          reject(new KpxError(`KeePassXC에 보내지 못했습니다: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // 세션 키 교환. 다른 요청 전에 한 번.
  async handshake(timeoutMs = 10_000): Promise<void> {
    const nonce = nacl.randomBytes(24);
    const res = await this.request(
      { action: "change-public-keys", publicKey: b64(this.keys.publicKey), nonce: b64(nonce), clientID: this.clientId },
      timeoutMs,
    );
    if (res.success !== "true" || typeof res.publicKey !== "string") throw new KpxError("KeePassXC와 키를 교환하지 못했습니다.");
    if (res.nonce !== b64(incrementNonce(nonce))) throw new KpxError("KeePassXC 응답의 nonce가 맞지 않습니다.");
    const key = unb64(res.publicKey);
    if (key.length !== nacl.box.publicKeyLength) throw new KpxError("KeePassXC 공개 키 형식이 맞지 않습니다.");
    this.hostKey = key;
  }

  // 암호화한 요청. 응답을 풀어 success가 "true"인 내용만 돌려준다.
  async call(message: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.hostKey) await this.handshake();
    const hostKey = this.hostKey!;
    const nonce = nacl.randomBytes(24);
    const plain = new TextEncoder().encode(JSON.stringify(message));
    const boxed = nacl.box(plain, nonce, hostKey, this.keys.secretKey);
    const res = await this.request(
      { action: message.action, message: b64(boxed), nonce: b64(nonce), clientID: this.clientId },
      timeoutMs,
    );
    if (typeof res.message !== "string" || typeof res.nonce !== "string") throw new KpxError("KeePassXC 응답 형식이 맞지 않습니다.");
    const expected = incrementNonce(nonce);
    if (res.nonce !== b64(expected)) throw new KpxError("KeePassXC 응답의 nonce가 맞지 않습니다.");
    const opened = nacl.box.open(unb64(res.message), expected, hostKey, this.keys.secretKey);
    if (!opened) throw new KpxError("KeePassXC 응답을 풀지 못했습니다.");
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(new TextDecoder().decode(opened)) as Record<string, unknown>;
    } catch {
      throw new KpxError("KeePassXC 응답 형식이 맞지 않습니다.");
    }
    if (data.success !== "true") throw new KpxError("KeePassXC가 요청을 거부했습니다.");
    return data;
  }

  // 새 연결 등록. KeePassXC 창이 사용자에게 승인과 이름을 묻는다.
  async associate(timeoutMs = 120_000): Promise<KpxAssociation> {
    const idKeys = nacl.box.keyPair();
    const idKey = b64(idKeys.publicKey);
    const res = await this.call({ action: "associate", key: b64(this.keys.publicKey), idKey }, timeoutMs);
    if (typeof res.id !== "string" || !res.id) throw new KpxError("KeePassXC가 연결 이름을 돌려주지 않았습니다.");
    return { id: res.id, idKey };
  }

  // 저장한 연결이 지금 열린 데이터베이스에 등록돼 있는지. 다른 요청 전에 이 세션에서 한 번 성공해야 한다.
  async testAssociate(a: KpxAssociation, timeoutMs = 10_000): Promise<void> {
    await this.call({ action: "test-associate", id: a.id, key: a.idKey }, timeoutMs);
  }

  // 그 주소에 맞는 항목. KeePassXC가 사이트별 접근 허락 창을 띄울 수 있어 오래 기다린다. 항목이 없으면 빈 목록.
  async getLogins(a: KpxAssociation, url: string, timeoutMs = 90_000): Promise<KpxEntry[]> {
    let res: Record<string, unknown>;
    try {
      res = await this.call({ action: "get-logins", url, keys: [{ id: a.id, key: a.idKey }] }, timeoutMs);
    } catch (err) {
      if (err instanceof KpxError && err.code === KPX_ERROR_NO_LOGINS) return [];
      throw err;
    }
    return parseEntries(res.entries);
  }

  async getTotp(uuid: string, timeoutMs = 10_000): Promise<string> {
    const res = await this.call({ action: "get-totp", uuid }, timeoutMs);
    if (typeof res.totp !== "string" || !res.totp) throw new KpxError("KeePassXC가 일회용 코드를 주지 않았습니다.");
    return res.totp;
  }
}

export function parseEntries(raw: unknown): KpxEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: KpxEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    if (typeof r.uuid !== "string" || !r.uuid || typeof r.password !== "string") continue;
    out.push({
      uuid: r.uuid,
      name: typeof r.name === "string" ? r.name : "",
      login: typeof r.login === "string" ? r.login : "",
      password: r.password,
      ...(typeof r.totp === "string" && r.totp ? { totp: r.totp } : {}),
      ...(r.expired === "true" ? { expired: true } : {}),
    });
  }
  return out;
}

// 설정 화면이 보여 줄 호스트 manifest(사용자가 직접 설치한다).
export function hostManifest(extensionId: string, proxyPath: string): string {
  return JSON.stringify(
    {
      name: KEEPASSXC_HOST,
      description: "간편 브라우저 도우미 ↔ KeePassXC",
      path: proxyPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  );
}
