// 도구 호출 순환 한도와 헛돌기 감지(#55).
// 판정은 구조(도구 이름·인자 동일성·결과 동일성·실패 여부·클릭 뒤 관측한 화면 변화)로만 한다. 오류 문구의 낱말로
// 뜻을 짐작해 동작을 바꾸지 않는다(오류 글자는 같은지 다른지만 본다). npm test(Node 타입 제거 실행)로 시험하므로
// 다른 모듈을 불러오지 않는다.

// 같은 호출이 같은 결과로 연달아 이만큼 나오면 멈춘다.
export const SPIN_REPEAT_LIMIT = 3;
// 한 도구가 사이에 성공 없이 이만큼 실패하면 멈춘다.
export const SPIN_FAILURE_LIMIT = 3;

// 이번 요청(턴)에서 실행을 마친 도구 호출 하나.
export interface ToolRunRecord {
  tool: string;
  // 인자의 정규 문자열(canonicalJson). 인자를 해석하지 못했으면 원문.
  argsKey: string;
  ok: boolean;
  // 사용자가 승인 카드에서 취소한 호출. 실패로 세지 않고, 같은 호출 반복의 연속도 끊는다.
  cancelled?: boolean;
  // 결과(실패면 오류 글자)의 지문. 같은 호출이 같은 결과를 냈는지만 비교한다.
  resultKey: string;
  // 이 호출 뒤 페이지 변화가 관측됐는지. 지금은 클릭(clickObservedChange)만 해당한다.
  changed: boolean;
  // 패널 결과 카드에 보인 한 줄(이어 가기 카드의 요약에 쓴다).
  summary: string;
}

export type SpinVerdict =
  // 같은 도구·같은 인자·같은 결과, 화면 변화 없음이 count번 연속.
  | { kind: "repeat"; tool: string; count: number }
  // 한 도구가 사이에 그 도구의 성공 없이 count번 실패(다른 도구 호출이 끼어도 이어서 셈).
  | { kind: "failure"; tool: string; count: number };

// 마지막 기록까지 보고 헛돌기인지 판정한다.
// - 같은 호출 반복: 관측 도구는 페이지가 그대로면 같은 결과가 나오므로 세 번째는 쓸모가 없다. 클릭은 '다음 달'처럼
//   같은 id를 여러 번 누르는 것이 정당하므로, 클릭 뒤 이동·화면 변경·대화상자·새 탭이 관측된 호출은 반복으로 세지
//   않는다(그 클릭이 연속을 끊는다). 화면 변화 없이 같은 결과만 되풀이한 클릭만 센다. 입력·이동 같은 다른 동작은
//   같은 값으로 세 번 연속 같은 결과면 센다.
// - 같은 실패: 오류 글자에는 대상 id 같은 바뀌는 값이 들어 있어 글자가 같은지로는 "다시 찾기 → 다시 실패" 고리를
//   잡지 못한다. 그래서 오류 글자는 보지 않고 도구 이름과 실패 여부로만 본다. find → click 실패 → find → click 실패처럼
//   다른 도구가 사이에 끼어도 그 도구가 성공하지 않는 한 이어서 센다.
export function detectSpin(records: readonly ToolRunRecord[]): SpinVerdict | null {
  const last = records[records.length - 1];
  if (!last || last.cancelled) return null;

  let repeats = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.cancelled || r.changed) break;
    if (r.tool !== last.tool || r.argsKey !== last.argsKey || r.resultKey !== last.resultKey) break;
    repeats += 1;
  }
  if (repeats >= SPIN_REPEAT_LIMIT) return { kind: "repeat", tool: last.tool, count: repeats };

  if (!last.ok) {
    let failures = 0;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const r = records[i];
      if (r.tool !== last.tool || r.cancelled) continue;
      if (r.ok) break;
      failures += 1;
    }
    if (failures >= SPIN_FAILURE_LIMIT) return { kind: "failure", tool: last.tool, count: failures };
  }
  return null;
}

// 키 순서와 관계없이 같은 값이면 같은 문자열. 순환 참조는 없다고 본다(도구 인자·결과는 JSON에서 온다).
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

// 긴 결과(본문 등)를 기록에 그대로 두지 않으려는 지문(FNV-1a 32비트 + 길이). 같음 비교에만 쓴다.
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${text.length}`;
}

// click_element 결과의 effect(src/lib/actionTarget.ts의 ClickEffect)에서 쓰는 부분.
export interface ClickEffectLike {
  navigation?: string;
  newTab?: boolean;
  sameDocument?: boolean | null;
  dom?: { mutations?: number; dialogOpened?: boolean; frameNavigated?: boolean; aborted?: string | null } | null;
  popup?: { opened?: unknown; closed?: string };
}

// 클릭 뒤 페이지가 바뀐 것이 관측됐는지(이동·다시 불러옴·화면 변경·대화상자·프레임 이동·새 탭).
// 누르기 직전에 멈춘 클릭(aborted)은 변화가 아니다.
export function clickObservedChange(effect: ClickEffectLike | null | undefined): boolean {
  if (!effect || effect.dom?.aborted) return false;
  if (effect.navigation && effect.navigation !== "none") return true;
  if (effect.newTab || effect.sameDocument === false) return true;
  // 팝업 창이 열리거나(새 탭과 같음) 클릭한 팝업 창이 닫혔다(도구가 원래 탭으로 돌아감).
  if (effect.popup?.opened || effect.popup?.closed) return true;
  const dom = effect.dom;
  return !!dom && (!!dom.dialogOpened || !!dom.frameNavigated || (dom.mutations ?? 0) > 0);
}

// 이어 가기 카드에 보일 "지금까지 한 일": 도구별 횟수(많은 순), 실패·취소 수, 최근 결과 몇 줄.
export interface RunSummary {
  total: number;
  failed: number;
  cancelled: number;
  byTool: Array<{ tool: string; count: number }>;
  recent: string[];
}

export function summarizeRuns(records: readonly ToolRunRecord[], recentCount = 3): RunSummary {
  const counts = new Map<string, number>();
  let failed = 0;
  let cancelled = 0;
  for (const r of records) {
    counts.set(r.tool, (counts.get(r.tool) ?? 0) + 1);
    if (r.cancelled) cancelled += 1;
    else if (!r.ok) failed += 1;
  }
  const byTool = [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  const recent = records
    .slice(-recentCount)
    .map((r) => `${r.tool}: ${r.summary.length > 120 ? `${r.summary.slice(0, 119)}…` : r.summary}`);
  return { total: records.length, failed, cancelled, byTool, recent };
}
