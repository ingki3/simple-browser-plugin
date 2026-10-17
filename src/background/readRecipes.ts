import { READ_RECIPES_KEY } from "@/lib/messages";
import type { PageKey } from "@/lib/actionLog";
import {
  applyObservations,
  hintsFor,
  pruneRecipes,
  type ReadHint,
  type ReadObservation,
  type RecipeTool,
} from "@/lib/readRecipe";
import { getSettings } from "./storage";
import { debugLog } from "./debug";
import { enqueue, turnKey } from "./actionLog";
import type { TurnTab } from "./tools/handlers";

// 한 턴에서 본 읽기 도구 호출을 모아 두었다가, 턴이 정상으로 끝나면 한꺼번에 레시피에 반영한다.
// 턴 단위로 모아야 "모델이 선택자를 고쳐 가며 시도한 것 중 마지막으로 통한 것"을 고를 수 있다.
const MAX_OBS_PER_TURN = 30;
const MAX_TURNS = 10;
const pendingReads = new Map<string, ReadObservation[]>();

export function noteRead(
  turnTab: TurnTab,
  page: PageKey,
  tool: RecipeTool,
  args: ReadObservation["args"],
  useful: boolean,
): void {
  const key = turnKey(turnTab);
  const list = pendingReads.get(key) ?? [];
  if (list.length >= MAX_OBS_PER_TURN) return;
  list.push({ page, tool, args, useful });
  pendingReads.delete(key);
  pendingReads.set(key, list);
  while (pendingReads.size > MAX_TURNS) {
    const oldest = pendingReads.keys().next().value;
    if (oldest === undefined) break;
    pendingReads.delete(oldest);
  }
}

// 턴이 끝날 때 부른다. 중단·오류로 끝난 턴의 관찰은 버린다.
export function commitReads(turnTab: TurnTab, ok: boolean): void {
  const key = turnKey(turnTab);
  const obs = pendingReads.get(key);
  pendingReads.delete(key);
  if (!ok || !obs?.length) return;
  void enqueue(async () => {
    // 끈 뒤에 끝난 턴은 남기지 않는다.
    if (!(await getSettings()).actionLogEnabled) return;
    const now = Date.now();
    const obj = await chrome.storage.local.get(READ_RECIPES_KEY);
    const next = applyObservations(pruneRecipes(obj[READ_RECIPES_KEY], now), obs, now);
    await chrome.storage.local.set({ [READ_RECIPES_KEY]: next });
  }).catch((err) => {
    debugLog("read_recipe:write_fail", err instanceof Error ? err.message : String(err), "warn");
  });
}

export async function readHintsFor(page: PageKey): Promise<ReadHint[]> {
  const obj = await chrome.storage.local.get(READ_RECIPES_KEY);
  return hintsFor(pruneRecipes(obj[READ_RECIPES_KEY], Date.now()), page, Date.now());
}

// 개수를 셀 때 만료·꺼진 레시피도 저장소에서 지운다.
export function readRecipeCount(): Promise<number> {
  return enqueue(async () => {
    const obj = await chrome.storage.local.get(READ_RECIPES_KEY);
    const raw = obj[READ_RECIPES_KEY];
    const kept = pruneRecipes(raw, Date.now());
    if (raw !== undefined && (!Array.isArray(raw) || raw.length !== kept.length)) {
      if (kept.length) await chrome.storage.local.set({ [READ_RECIPES_KEY]: kept });
      else await chrome.storage.local.remove(READ_RECIPES_KEY);
    }
    return kept.length;
  });
}

export function clearPendingReads(): void {
  pendingReads.clear();
}
