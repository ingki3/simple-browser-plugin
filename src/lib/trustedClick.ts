// 실제 입력 클릭(chrome.debugger Input.dispatchMouseEvent, 0.2.0)에서 content script와 백그라운드가 같이 쓰는 값과 순수 계산.
//
// 보안 모델: 실제 입력 클릭은 사람이 그 자리를 누른 것과 같다. 브라우저가 좌표로 대상을 정하므로, 확인한 뒤 누르기 전 틈에
// 페이지가 다른 요소(다른 출처 iframe 포함)를 그 자리에 옮겨 놓을 수 있다(사람의 클릭이 받는 클릭재킹과 같은 노출).
// 다른 출처 사이트를 끼워 누르게 하는 공격의 경계는 그 사이트의 X-Frame-Options·frame-ancestors다(사람에게도 같음).
// 이 모듈과 가드(content/trustedClick.ts)는 그 틈을 줄이고, 누른 결과가 승인한 대상이 아니면 막거나 실패로 알리는
// 다중 방어다: 누르기 직전 같은 문서·같은 대상·같은 자리 확인, top 문서에서 다른 요소로 간 입력 차단, 다른 프레임의 입력 차단.

// 가드가 보고 막는 실제 입력 이벤트. 마우스·포인터의 누르기·떼기·클릭 계열만(hover 계열은 활성화를 일으키지 않는다).
export const GUARDED_EVENTS = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
] as const;

// 가드가 걸려 있는 최대 시간. 지나면 가드는 모든 실제 입력을 막다가(만료) 해제된다.
export const GUARD_MS = 8_000;
// 누르기 직전 확인에서 가드에 이만큼 남아 있지 않으면 누르지 않는다(누르는 동안 만료되지 않게).
export const GUARD_MIN_REMAINING_MS = 3_000;
// 다른 프레임에 가드를 거는 메시지의 응답 대기.
export const FRAME_ARM_TIMEOUT_MS = 600;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

// 누를 점: 화면(viewport)과 겹치는 첫 사각형에서, 겹친 부분의 가운데. 겹치는 사각형이 없으면 null.
// 가장자리를 피하려고 겹친 부분이 1px보다 작으면 쓰지 않는다.
export function clickPoint(rects: readonly Rect[], viewport: { width: number; height: number }): Point | null {
  for (const r of rects) {
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(viewport.width, r.left + r.width);
    const bottom = Math.min(viewport.height, r.top + r.height);
    if (right - left < 1 || bottom - top < 1) continue;
    return { x: Math.round(((left + right) / 2) * 100) / 100, y: Math.round(((top + bottom) / 2) * 100) / 100 };
  }
  return null;
}

// 누를 후보 점(#89): 화면과 겹치는 사각형마다 겹친 부분의 가운데, 그다음 가장자리에서 안쪽으로 들어간 네 점(가로·세로 25%·75%).
// 가운데가 고정 바·작은 배지에 가려져도 대상의 다른 자리를 누를 수 있게 한다. 겹친 부분이 1px보다 작은 사각형은 쓰지 않는다.
export function clickPoints(rects: readonly Rect[], viewport: { width: number; height: number }): Point[] {
  const out: Point[] = [];
  const round = (v: number) => Math.round(v * 100) / 100;
  for (const r of rects) {
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(viewport.width, r.left + r.width);
    const bottom = Math.min(viewport.height, r.top + r.height);
    if (right - left < 1 || bottom - top < 1) continue;
    const w = right - left;
    const h = bottom - top;
    out.push({ x: round(left + w / 2), y: round(top + h / 2) });
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
      const p = { x: round(left + w * fx), y: round(top + h * fy) };
      if (!out.some((q) => q.x === p.x && q.y === p.y)) out.push(p);
    }
  }
  return out;
}

// 가드가 기록한 결과. clicked: 승인한 대상에 click까지 갔음. blocked: 가드가 막음(이유). none: 실제 입력이 오지 않음.
export type TrustedClickStatus =
  | { status: "clicked" }
  | { status: "blocked"; reason: string }
  | { status: "none" };

// 백그라운드가 읽는 가드 기록: 결과와, 결과가 none일 때 원인을 좁히는 진단(이 문서가 받은 실제 입력 종류·화면 크기).
export type TrustedClickReport = TrustedClickStatus & {
  seen: string[];
  viewport: { width: number; height: number };
  // 결과를 읽을 때 탭이 화면에 보이지 않았는지(뒤에 있는 탭에는 실제 입력이 오지 않을 수 있다).
  hidden?: boolean;
};

// 실제 입력이 대상에 오지 않았을 때(none) 원인을 좁히는 설명. frameBlocked: 다른 프레임 가드가 막은 입력 수.
export function describeMissedClick(r: {
  seen: readonly string[];
  viewport: { width: number; height: number };
  point: Point;
  frameBlocked: number;
  hidden?: boolean;
}): string {
  const parts: string[] = [];
  if (r.hidden) parts.push("탭이 화면에 보이지 않음(뒤에 있는 탭)");
  if (r.frameBlocked > 0) parts.push(`그 자리의 다른 프레임이 입력 ${r.frameBlocked}개를 받아 막음`);
  const { x, y } = r.point;
  if (x < 0 || y < 0 || x >= r.viewport.width || y >= r.viewport.height) {
    parts.push(`누른 점(${x}, ${y})이 화면(${r.viewport.width}×${r.viewport.height}) 밖`);
  }
  if (r.seen.length === 0) parts.push("이 문서에 입력이 오지 않음");
  else parts.push(`이 문서가 받은 입력: ${r.seen.join(", ")} — click이 생기지 않음`);
  return parts.join("; ");
}

// content script가 click_element를 실제 입력으로 준비한 결과(tool_exec 응답의 trusted).
export type TrustedPrepare =
  | { mode: "trusted"; x: number; y: number }
  // 실제 입력을 쓸 수 없는 대상이라 지금처럼 스크립트로 눌렀다(이유).
  | { mode: "script"; reason: string }
  // 승인 뒤 대상이 바뀌어 누르지 않았다(effect의 aborted로 알린다).
  | { mode: "aborted" };

// content script가 있어야 하는 프레임 문서(사이트가 내려 준 문서). about:blank·srcdoc·data:·blob: 문서는 그 문서를 만든
// 쪽의 내용이라 요구하지 않는다(그 안의 http(s) 프레임은 따로 나온다).
export function frameNeedsGuard(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

// 가드를 건 문서 밖에 새로 생기거나 다시 읽힌, 가드가 필요한 프레임 문서. 없으면 null.
export function unguardedFrame<T extends { documentId: string; url: string }>(
  frames: readonly T[],
  guarded: ReadonlySet<string>,
): T | null {
  return frames.find((f) => frameNeedsGuard(f.url) && !guarded.has(f.documentId)) ?? null;
}

// 가드를 걸기 시작한 시각(armedAt)부터 재어, 지금 누르기 시작해도 가드가 GUARD_MIN_REMAINING_MS 넘게 남는지.
export function guardTimeLeft(armedAt: number, now: number): boolean {
  return armedAt + GUARD_MS - now >= GUARD_MIN_REMAINING_MS;
}
