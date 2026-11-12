import { READ_RECIPES_KEY } from "@/lib/messages";
import { pageKeyId, type PageKey } from "@/lib/actionLog";
import {
  applyObservations,
  groupRecipes,
  hintsFor,
  pruneRecipes,
  READ_KEY_PREFIX,
  recipeKey,
  removeRecipeKeys,
  type ReadHint,
  type ReadObservation,
  type ReadRecipe,
  type RecipeSite,
  type RecipeTool,
} from "@/lib/readRecipe";
import { getSettings } from "./storage";
import { debugLog } from "./debug";
import { containsSecret, maskSyncDeep } from "./loginSecrets";
import { enqueue, turnKey } from "./actionQueue";
import type { TurnTab } from "./tools/handlers";

// 한 턴에서 본 읽기 도구 호출을 모아 두었다가, 턴이 정상으로 끝나면 한꺼번에 레시피에 반영한다.
// 턴 단위로 모아야 "모델이 선택자를 고쳐 가며 시도한 것 중 마지막으로 통한 것"을 고를 수 있다.
const MAX_OBS_PER_TURN = 30;
const MAX_TURNS = 10;

// 관찰마다 받는 순번(#297). 삭제도 같은 순번을 나눠 쓰므로 삭제 순번은 그 전의 모든 관찰 순번보다 크다.
type PendingObservation = ReadObservation & { seq: number };
const pendingReads = new Map<string, PendingObservation[]>();
let seq = 0;

// 지운 key → 지운 때의 순번. 그보다 앞선 관찰은 커밋해도 반영하지 않는다(지운 뒤 끝난 턴이 되살리지 않게).
// 워커가 죽으면 대기 관찰도 함께 사라지므로 저장하지 않는다.
export const MAX_DELETE_MARKS = 400;
const deleteMarks = new Map<string, number>();
// 이 순번보다 앞선 관찰은 key와 무관하게 버린다(전체 지우기, 표식을 버릴 때).
let invalidBefore = 0;

const observationKey = (o: ReadObservation) => recipeKey(pageKeyId(o.page), o.tool, o.args);

function dropped(o: PendingObservation): boolean {
  return o.seq < invalidBefore || o.seq < (deleteMarks.get(observationKey(o)) ?? 0);
}

export function noteRead(
  turnTab: TurnTab,
  page: PageKey,
  tool: RecipeTool,
  args: ReadObservation["args"],
  useful: boolean,
): void {
  // 페이지 주소·인자에 자동 로그인으로 넣은 값이 보이면 이 관찰은 남기지 않는다(가리면 레시피로 쓸 수 없다).
  if (maskSyncDeep({ page, args }).masked) return;
  const key = turnKey(turnTab);
  const list = pendingReads.get(key) ?? [];
  if (list.length >= MAX_OBS_PER_TURN) return;
  list.push({ page, tool, args, useful, seq: ++seq });
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
    // 저장하기 직전에도 가릴 값이 든 관찰은 뺀다(관찰한 뒤 로그인한 값 포함).
    const safe: PendingObservation[] = [];
    for (const o of obs) if (!(await containsSecret({ page: o.page, args: o.args }))) safe.push(o);
    if (!safe.length) return;
    const now = Date.now();
    const obj = await chrome.storage.local.get(READ_RECIPES_KEY);
    // 반영 직전(마지막 await 뒤)에 삭제 표식을 본다: Map에서 꺼낸 뒤에 온 삭제도, 큐에서 앞선 삭제도 이 관찰을 되살리지 못한다.
    const live = safe.filter((o) => !dropped(o));
    if (!live.length) return;
    const next = applyObservations(pruneRecipes(obj[READ_RECIPES_KEY], now), live, now);
    await chrome.storage.local.set({ [READ_RECIPES_KEY]: next });
  }).catch((err) => {
    debugLog("read_recipe:write_fail", err instanceof Error ? err.message : String(err), "warn");
  });
}

export async function readHintsFor(page: PageKey): Promise<ReadHint[]> {
  const obj = await chrome.storage.local.get(READ_RECIPES_KEY);
  return hintsFor(pruneRecipes(obj[READ_RECIPES_KEY], Date.now()), page, Date.now());
}

// 쓰기 큐 안에서 부른다: 읽고 만료·꺼진 것을 정리한 목록. 줄었으면 저장소에도 반영한다.
async function loadPruned(): Promise<ReadRecipe[]> {
  const obj = await chrome.storage.local.get(READ_RECIPES_KEY);
  const raw = obj[READ_RECIPES_KEY];
  const kept = pruneRecipes(raw, Date.now());
  if (raw !== undefined && (!Array.isArray(raw) || raw.length !== kept.length)) await saveRecipes(kept);
  return kept;
}

async function saveRecipes(list: ReadRecipe[]): Promise<void> {
  if (list.length) await chrome.storage.local.set({ [READ_RECIPES_KEY]: list });
  else await chrome.storage.local.remove(READ_RECIPES_KEY);
}

// 개수를 셀 때 만료·꺼진 레시피도 저장소에서 지운다.
export function readRecipeCount(): Promise<number> {
  return enqueue(async () => (await loadPruned()).length);
}

// 설정 화면의 목록(#297). 자동 로그인으로 넣은 값이 보이는 항목은 뺀다 — 가림 목록을 세션 저장소에서 읽는 비동기 검사라
// 워커를 막 깨워 캐시가 비어 있어도 걸러진다. 가림 목록을 읽지 못하면 오류로 끝난다(항목을 하나도 돌려주지 않음).
export function listRecipes(): Promise<{ sites: RecipeSite[] }> {
  return enqueue(async () => {
    const kept = await loadPruned();
    const shown: ReadRecipe[] = [];
    for (const r of kept) if (!(await containsSecret({ page: r.page, args: r.args }))) shown.push(r);
    return { sites: groupRecipes(shown) };
  });
}

// 지운 key를 표식으로 남기고 대기 관찰에서도 뺀다. 큐에 넣기 전에 동기적으로 부른다.
function markDeleted(keys: readonly string[]): void {
  const set = new Set(keys.filter((k) => k.startsWith(READ_KEY_PREFIX)));
  if (!set.size) return;
  for (const k of set) {
    deleteMarks.delete(k);
    deleteMarks.set(k, ++seq);
  }
  // 표식이 너무 많으면 가장 오래된 것을 버리되, 그 순번보다 앞선 관찰은 모두 버리게 해 표식을 잃어도 되살아나지 않게 한다.
  while (deleteMarks.size > MAX_DELETE_MARKS) {
    const [oldest, at] = deleteMarks.entries().next().value as [string, number];
    deleteMarks.delete(oldest);
    invalidBefore = Math.max(invalidBefore, at);
  }
  for (const [turn, list] of pendingReads) {
    const left = list.filter((o) => !set.has(observationKey(o)));
    if (left.length !== list.length) pendingReads.set(turn, left);
  }
}

// 설정 화면에서 고른 레시피를 지운다(#297). 그때의 저장 목록에서 그 key만 뺀다(화면이 든 목록을 통째로 쓰지 않음). 응답은 새 개수.
export function deleteRecipes(keys: readonly string[]): Promise<number> {
  markDeleted(keys);
  const set = new Set(keys);
  return enqueue(async () => {
    const kept = await loadPruned();
    const next = removeRecipeKeys(kept, set);
    if (next.length !== kept.length) await saveRecipes(next);
    return next.length;
  });
}

// 전체 지우기: 대기 관찰을 비우고, 그 전의 모든 관찰을 무효로 한다(이미 커밋 중인 턴도 반영하지 못함).
export function clearPendingReads(): void {
  pendingReads.clear();
  deleteMarks.clear();
  invalidBefore = ++seq;
}
