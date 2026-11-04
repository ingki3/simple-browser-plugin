import { FLAGS_KEY, SETTINGS_KEY, type Flags, type Settings, type SettingsPatch } from "@/lib/messages";
import { mergeSettingsPatch, normalizeSettings, settingsForStorage } from "@/lib/settings";
import { newGrantId } from "@/lib/loginPolicy";
import { makeGenCache } from "@/lib/genCache";
import {
  applyLoginSiteOp as applyLoginSiteOpTo,
  applyManualSiteOp as applyManualSiteOpTo,
  applyRemoteSiteOp as applyRemoteSiteOpTo,
  type RemoteSiteOp,
  withGrantIds,
  type LoginSiteOp,
  type ManualSiteOp,
} from "@/lib/settingsOps";

export { DEFAULT_SETTINGS } from "@/lib/settings";

export async function readSettings(): Promise<Settings> {
  const obj = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(obj[SETTINGS_KEY] as Partial<Settings> | undefined);
}

export async function writeSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsForStorage(next) });
}

// 바꾼 필드만 최신 설정에 합쳐 쓴다(#99). 읽기·합치기·쓰기를 차례로 처리해, 여러 패널의 저장이 겹쳐도 서로의 변경을
// 오래된 값으로 덮지 않는다.
let patchQueue: Promise<unknown> = Promise.resolve();
export function applySettingsPatch(patch: SettingsPatch): Promise<void> {
  const run = patchQueue.then(async () => {
    await writeSettings(mergeSettingsPatch(await readSettings(), patch));
    invalidateSettingsCache();
  });
  patchQueue = run.catch(() => {});
  return run;
}

// 지금 설정을 읽어 바꿀 필드를 정하는 patch(목록에 항목 하나 더하기 등). 같은 차례 안에서 읽고 써서 다른 저장과 엇갈리지 않는다.
export function applySettingsUpdate(fn: (cur: Settings) => SettingsPatch): Promise<void> {
  const run = patchQueue.then(async () => {
    const cur = await readSettings();
    const patch = fn(cur);
    // 바꿀 것이 없으면 쓰지 않는다(저장소 변경 알림·캐시 무효화를 일으키지 않게).
    if (!Object.keys(patch).length) return;
    await writeSettings(mergeSettingsPatch(cur, patch));
    invalidateSettingsCache();
  });
  patchQueue = run.catch(() => {});
  return run;
}

// 설정 캐시. 읽는 사이 저장·변경 알림으로 무효화되면 옛 조회 결과를 넣지 않고 다시 읽는다(옛 제공자·모델·키로 요청하지 않게,
// #127 리뷰에서 찾은 경합 — src/lib/genCache.ts).
const cache = makeGenCache(readSettings);

export function getSettings(): Promise<Settings> {
  return cache.get();
}

export function invalidateSettingsCache(): void {
  cache.invalidate();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTINGS_KEY in changes) invalidateSettingsCache();
});

// 직접 조작할 사이트·자동 로그인 목록의 항목 하나를 바꾼다(#127). 저장 직렬화 안에서 그때의 저장 목록에 적용한다.
export async function applyManualSiteOp(op: ManualSiteOp): Promise<void> {
  const out = { error: "" };
  await applySettingsUpdate((cur) => {
    const r = applyManualSiteOpTo(cur.manualSites, op);
    if (r.ok) return { manualSites: r.list };
    out.error = r.error;
    return {};
  });
  if (out.error) throw new Error(out.error);
}

// 원격 요청에서 묻지 않을 사이트(#192)의 항목 하나를 바꾼다(직접 조작할 사이트와 같은 방식).
export async function applyRemoteSiteOp(op: RemoteSiteOp): Promise<void> {
  const out = { error: "" };
  await applySettingsUpdate((cur) => {
    const r = applyRemoteSiteOpTo(cur.remoteSites, op);
    if (r.ok) return { remoteSites: r.list };
    out.error = r.error;
    return {};
  });
  if (out.error) throw new Error(out.error);
}

export async function applyLoginSiteOp(op: LoginSiteOp): Promise<void> {
  const out = { error: "" };
  await applySettingsUpdate((cur) => {
    const r = applyLoginSiteOpTo(cur.loginSites, op);
    if (r.ok) return { loginSites: r.list };
    out.error = r.error;
    return {};
  });
  if (out.error) throw new Error(out.error);
}

// grantId가 없는 옛 자동 로그인 항목에 한 번 채워 저장한다(백그라운드 시작 때). 저장 직렬화 안이라 그 뒤의 항목 변경은 채운 값과 비교한다.
export function migrateLoginGrantIds(): Promise<void> {
  return applySettingsUpdate((cur) => {
    const next = withGrantIds(cur.loginSites, newGrantId);
    return next ? { loginSites: next } : {};
  });
}

export async function readFlags(): Promise<Flags> {
  const obj = await chrome.storage.local.get(FLAGS_KEY);
  return (obj[FLAGS_KEY] as Flags | undefined) ?? {};
}

export async function setFlag<K extends keyof Flags>(key: K, value: Flags[K]): Promise<void> {
  const current = await readFlags();
  const next: Flags = { ...current, [key]: value };
  await chrome.storage.local.set({ [FLAGS_KEY]: next });
}

