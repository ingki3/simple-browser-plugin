// 목록형 승인 설정의 항목 단위 변경(#127). 설정 화면(옵션 탭)을 여러 개·오래 열어 두면 화면이 들고 있는 옛 배열 전체를
// 저장해 다른 곳에서 뺀 항목이 되살아날 수 있다(직접 조작할 사이트가 빠지면 대신 클릭·입력하게 되고, 자동 로그인 승인이
// 되살아난다). 그래서 화면은 항목 하나의 변경만 보내고, 백그라운드가 저장 직렬화 안에서 그때의 저장 목록에 적용한다.
import { MAX_MANUAL_SITES, manualSiteOf } from "./manualSites.ts";
import { GRANT_ID_RE, loginOrigin, type LoginSite } from "./loginPolicy.ts";

export type ManualSiteOp = { op: "add" | "remove"; site: string };
export type LoginSiteOp = { op: "remove"; origin: string; grantId: string } | { op: "set_totp"; origin: string; grantId: string; totp: boolean };
export type OpResult<T> = { ok: true; list: T[] } | { ok: false; error: string };

// 메시지 값 검사. 사이트는 출처로 정규화한 값과 같아야 한다(경로·대소문자가 다른 값은 받지 않음).
export function parseManualSiteOp(raw: unknown): ManualSiteOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if ((r.op !== "add" && r.op !== "remove") || typeof r.site !== "string") return null;
  if (manualSiteOf(r.site) !== r.site) return null;
  return { op: r.op, site: r.site };
}

export function parseLoginSiteOp(raw: unknown): LoginSiteOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.origin !== "string" || loginOrigin(r.origin) !== r.origin) return null;
  if (typeof r.grantId !== "string" || !GRANT_ID_RE.test(r.grantId)) return null;
  if (r.op === "remove") return { op: "remove", origin: r.origin, grantId: r.grantId };
  if (r.op === "set_totp" && typeof r.totp === "boolean") return { op: "set_totp", origin: r.origin, grantId: r.grantId, totp: r.totp };
  return null;
}

export function applyManualSiteOp(list: readonly string[], op: ManualSiteOp): OpResult<string> {
  if (op.op === "remove") return { ok: true, list: list.filter((s) => s !== op.site) };
  if (list.includes(op.site)) return { ok: true, list: [...list] };
  if (list.length >= MAX_MANUAL_SITES) return { ok: false, error: `직접 조작할 사이트는 ${MAX_MANUAL_SITES}개까지입니다.` };
  return { ok: true, list: [...list, op.site] };
}

// 사용자가 보던 승인(grantId)과 지금 그 출처의 승인이 같을 때만 적용한다. 지웠다 다시 승인했으면(같은 항목이어도 새 grantId)
// 거절한다 — 다시 승인할 때 코드 자동 입력을 끄는 보호를 옛 화면의 변경이 되돌리지 않게.
export function applyLoginSiteOp(list: readonly LoginSite[], op: LoginSiteOp): OpResult<LoginSite> {
  const cur = list.find((s) => s.origin === op.origin);
  if (!cur || !cur.grantId || cur.grantId !== op.grantId) {
    // 이미 없는 항목을 빼는 것은 원하는 결과와 같다.
    if (op.op === "remove" && !cur) return { ok: true, list: [...list] };
    return { ok: false, error: "자동 로그인 목록이 다른 곳에서 바뀌었습니다. 목록을 다시 확인하세요." };
  }
  if (op.op === "remove") return { ok: true, list: list.filter((s) => s !== cur) };
  return { ok: true, list: list.map((s) => (s === cur ? { ...s, totp: op.totp } : s)) };
}

// grantId가 없는 옛 항목에 새 grantId를 채운다. 채울 것이 없으면 null(저장하지 않음).
export function withGrantIds(list: readonly LoginSite[], make: () => string): LoginSite[] | null {
  if (list.every((s) => s.grantId)) return null;
  return list.map((s) => (s.grantId ? s : { ...s, grantId: make() }));
}
