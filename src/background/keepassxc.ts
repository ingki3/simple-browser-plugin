// KeePassXC 연결 관리(자동 로그인). 프로토콜은 src/lib/keepassxc.ts. 연결 정보(associate 결과)는 chrome.storage.local의
// 별도 키에 두고(설정과 섞지 않는다 — 설정은 패널과 주고받는다), 세션(포트·세션 키)은 메모리에만 둔다.
// nativeMessaging은 선택 권한이다. 설정에서 켤 때 패널이 요청하고, 없으면 연결하지 않는다.
import {
  KEEPASSXC_HOST,
  KPX_ERROR_DB_NOT_OPENED,
  KpxError,
  KpxSession,
  type KpxAssociation,
  type KpxEntry,
  type KpxPort,
} from "@/lib/keepassxc";
import { debugLog } from "./debug";

const ASSOC_KEY = "keepassxcAssociation";

let session: KpxSession | null = null;
// 이 세션에서 test-associate가 통과했는지(KeePassXC는 세션마다 한 번 확인해야 항목을 준다).
let verified = false;

export type KpxStatus =
  | { state: "no_permission" }
  | { state: "not_connected" }
  | { state: "connected"; id: string }
  | { state: "error"; message: string; id?: string };

async function hasPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  } catch {
    return false;
  }
}

async function loadAssociation(): Promise<KpxAssociation | null> {
  const raw = (await chrome.storage.local.get(ASSOC_KEY))[ASSOC_KEY] as Partial<KpxAssociation> | undefined;
  if (raw && typeof raw.id === "string" && typeof raw.idKey === "string" && raw.id && raw.idKey) return { id: raw.id, idKey: raw.idKey };
  return null;
}

function openSession(): KpxSession {
  if (session && !session.isClosed) return session;
  if (!chrome.runtime.connectNative) throw new KpxError("KeePassXC 연결 권한(nativeMessaging)이 없습니다. 설정에서 켜 주세요.");
  const port = chrome.runtime.connectNative(KEEPASSXC_HOST) as unknown as KpxPort;
  const s = new KpxSession(port);
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message;
    if (why) debugLog("keepassxc:disconnect", why, "warn");
    if (session === s) {
      session = null;
      verified = false;
    }
  });
  session = s;
  verified = false;
  return s;
}

// 호스트를 찾지 못한 오류를 설치 안내로 바꾼다.
function friendly(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/native messaging host not found|Specified native messaging host/i.test(msg)) {
    return new KpxError("KeePassXC 연결 도우미(호스트 manifest)를 찾지 못했습니다. 설정 → 자동 로그인의 설치 안내를 따라 주세요.");
  }
  if (/Access to the specified native messaging host is forbidden/i.test(msg)) {
    return new KpxError("호스트 manifest의 allowed_origins에 이 확장 ID가 없습니다. 설정 → 자동 로그인에 보이는 내용으로 다시 설치해 주세요.");
  }
  return err instanceof Error ? err : new Error(msg);
}

export async function keepassxcStatus(): Promise<KpxStatus> {
  if (!(await hasPermission())) return { state: "no_permission" };
  const a = await loadAssociation();
  if (!a) return { state: "not_connected" };
  try {
    await ensureVerified(a);
    return { state: "connected", id: a.id };
  } catch (err) {
    return { state: "error", message: friendly(err).message, id: a.id };
  }
}

// unlockWaitMs: 데이터베이스가 잠겨 있으면 잠금 해제 창을 띄우고 이만큼 기다린다(로그인할 때만 — 설정의 상태 확인은 기다리지 않는다).
async function ensureVerified(a: KpxAssociation, unlockWaitMs = 0): Promise<KpxSession> {
  try {
    const s = openSession();
    if (!verified) {
      await s.testAssociate(a, 10_000, unlockWaitMs);
      verified = true;
    }
    return s;
  } catch (err) {
    throw friendly(err);
  }
}

// 새 연결. KeePassXC 창에서 사용자가 승인하고 이름을 정한다.
export async function keepassxcAssociate(): Promise<KpxStatus> {
  if (!(await hasPermission())) return { state: "no_permission" };
  try {
    const s = openSession();
    const a = await s.associate();
    await chrome.storage.local.set({ [ASSOC_KEY]: a });
    verified = true;
    debugLog("keepassxc:associated", a.id);
    return { state: "connected", id: a.id };
  } catch (err) {
    return { state: "error", message: friendly(err).message };
  }
}

export async function keepassxcForget(): Promise<void> {
  await chrome.storage.local.remove(ASSOC_KEY);
  session?.close();
  session = null;
  verified = false;
}

// 연결돼 있으면 그 주소의 항목, 연결하지 않았으면 null(손 넘기기로 간다). 연결 오류는 던진다.
export async function keepassxcLogins(url: string): Promise<KpxEntry[] | null> {
  if (!(await hasPermission())) return null;
  const a = await loadAssociation();
  if (!a) return null;
  const s = await ensureVerified(a, 90_000);
  try {
    return await s.getLogins(a, url);
  } catch (err) {
    // 확인한 뒤 데이터베이스가 잠겼으면 잠금 해제를 기다려 한 번 더 묻는다.
    if (err instanceof KpxError && err.code === KPX_ERROR_DB_NOT_OPENED) {
      verified = false;
      const again = await ensureVerified(a, 90_000);
      try {
        return await again.getLogins(a, url);
      } catch (err2) {
        throw friendly(err2);
      }
    }
    throw friendly(err);
  }
}

// 그 항목의 지금 일회용 코드(항목에 TOTP가 없으면 오류).
export async function keepassxcTotp(uuid: string): Promise<string> {
  const a = await loadAssociation();
  if (!a) throw new KpxError("KeePassXC가 연결되어 있지 않습니다.");
  const s = await ensureVerified(a);
  try {
    return await s.getTotp(uuid);
  } catch (err) {
    throw friendly(err);
  }
}
