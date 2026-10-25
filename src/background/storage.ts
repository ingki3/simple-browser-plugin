import { FLAGS_KEY, SETTINGS_KEY, type Flags, type Settings } from "@/lib/messages";
import { mergeSettingsPatch, normalizeSettings, settingsForStorage } from "@/lib/settings";

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
export function applySettingsPatch(patch: Partial<Settings>): Promise<void> {
  const run = patchQueue.then(async () => {
    await writeSettings(mergeSettingsPatch(await readSettings(), patch));
    invalidateSettingsCache();
  });
  patchQueue = run.catch(() => {});
  return run;
}

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  cache = await readSettings();
  return cache;
}

export function invalidateSettingsCache(): void {
  cache = null;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTINGS_KEY in changes) {
    cache = null;
  }
});

export async function readFlags(): Promise<Flags> {
  const obj = await chrome.storage.local.get(FLAGS_KEY);
  return (obj[FLAGS_KEY] as Flags | undefined) ?? {};
}

export async function setFlag<K extends keyof Flags>(key: K, value: Flags[K]): Promise<void> {
  const current = await readFlags();
  const next: Flags = { ...current, [key]: value };
  await chrome.storage.local.set({ [FLAGS_KEY]: next });
}

