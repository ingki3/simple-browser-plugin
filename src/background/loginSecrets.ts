// 자동 로그인으로 페이지에 넣은 값(아이디·비밀번호·일회용 코드)의 가림 목록(docs/design/login-automation.md "비밀 값 가리기").
// - 수명은 대화가 아니라 브라우저 세션: 새 대화를 시작하거나 탭을 닫아도 다른 탭·처리 중인 결과에 복사본이 남을 수 있어 지우지 않는다.
// - 서비스 워커가 다시 시작돼도 잃지 않게 chrome.storage.session(메모리 전용, 디스크에 쓰지 않음, content script는 못 읽음)에 둔다.
// - 거르기는 탭과 관계없이 모든 모델 요청에 쓴다.
import { maskDeep, maskMessages, maskText } from "@/lib/secretMask";

const KEY = "loginSecrets";
const MAX_TABS = 100;

type Store = Record<string, string[]>;

let cache: Store | null = null;
let listening = false;
// 목록 갱신(더하기·탭 지우기)을 차례로 한다(겹친 읽기·쓰기가 서로의 값을 덮어 잃지 않게).
let queue: Promise<unknown> = Promise.resolve();

function update(fn: (store: Store) => Store | null): Promise<void> {
  const run = queue.then(async () => {
    const next = fn({ ...(await load()) });
    if (next) await save(next);
  });
  queue = run.catch(() => undefined);
  return run;
}

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = (await chrome.storage.session.get(KEY))[KEY];
    cache = raw && typeof raw === "object" ? (raw as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function save(store: Store): Promise<void> {
  cache = store;
  try {
    await chrome.storage.session.set({ [KEY]: store });
  } catch {
    /* 메모리 캐시로 이어 간다 */
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  // 탭이 닫혀도 지우지 않는다: 값이 다른 탭(같은 출처의 opener 등)으로 복사됐거나 처리 중인 결과에 남아 있을 수 있다.
  // 브라우저를 끄면 storage.session과 함께 사라진다. 탭별 목록은 늘어나지 않게 최근 MAX_TABS개 탭만 둔다.
}

// 페이지에 넣기 직전에 부른다(넣은 뒤 관측이 먼저 오지 않게).
export async function rememberSecrets(tabId: number, values: string[]): Promise<void> {
  listen();
  await update((store) => {
    const cur = new Set(store[String(tabId)] ?? []);
    for (const v of values) if (v) cur.add(v);
    delete store[String(tabId)];
    store[String(tabId)] = [...cur];
    // 오래된 탭의 목록부터 덜어 낸다(넣은 순서 = 객체 키 순서).
    const keys = Object.keys(store);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TABS))) delete store[k];
    return store;
  });
}

export async function allSecrets(): Promise<string[]> {
  listen();
  const store = await load();
  return [...new Set(Object.values(store).flat())];
}

// 모델로 가는 메시지의 본문을 가린다(프로토콜 필드는 그대로). masked: 하나라도 가렸는지.
export async function maskMessagesForModel<T extends { role: string }>(messages: T[]): Promise<{ value: T[]; masked: boolean }> {
  return maskMessages(messages, await allSecrets());
}

// 저장하기 전의 기록 항목 등 JSON 값의 글자를 가린다.
export async function maskValue<T>(value: T): Promise<T> {
  return maskDeep(value, await allSecrets()).value;
}

export async function maskStringForModel(text: string): Promise<{ text: string; masked: boolean }> {
  return maskText(text, await allSecrets());
}

// 동기 경로(기록에 넣는 자리)용: 마지막으로 읽은 목록으로 가린다. rememberSecrets·allSecrets·warmSecrets가 캐시를 채운다.
// 값은 직렬화하기 전의 모양으로 가린다(JSON 이스케이프로 모양이 바뀌기 전에).
export function maskSyncDeep<T>(value: T): { value: T; masked: boolean } {
  if (!cache) return { value, masked: false };
  return maskDeep(value, [...new Set(Object.values(cache).flat())]);
}

export function maskSyncMessages<T extends { role: string }>(messages: T[]): { value: T[]; masked: boolean } {
  if (!cache) return { value: messages, masked: false };
  return maskMessages(messages, [...new Set(Object.values(cache).flat())]);
}

// 디버그 로그처럼 기다릴 수 없는 곳의 글자.
export function maskSyncText(text: string): string {
  if (!cache) return text;
  return maskText(text, [...new Set(Object.values(cache).flat())]).text;
}

// 서비스 워커가 깨어날 때 캐시를 미리 채운다(동기 거르기가 빈 목록으로 지나가지 않게).
export function warmSecrets(): Promise<unknown> {
  listen();
  return load();
}
