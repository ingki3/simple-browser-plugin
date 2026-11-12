import { useState } from "react";
import { READ_RECIPES_KEY } from "@/lib/messages";
import type { RecipeSite } from "@/lib/readRecipe";
import { toolLabel } from "@/lib/toolLabels";
import { useLatestGate, useStorageKeys } from "../../sidepanel/hooks/syncHelpers";

// 저장된 읽기 방법(읽기 레시피) 보기·지우기(#297 1단계). 목록·지우기는 백그라운드에 맡긴다(기록 쓰기와 같은 큐에서 순서를 맞추려고).
// 모든 값은 React 텍스트로만 보인다(주소 틀·인자는 페이지에서 온 낱말일 수 있다). 고치기는 없다.
export function ReadRecipesList() {
  const [open, setOpen] = useState(false);
  const [sites, setSites] = useState<RecipeSite[] | null>(null);
  const [busy, setBusy] = useState(false);
  // 조회 오류와 삭제 오류를 따로 둔다: 삭제가 실패한 뒤 다시 읽기가 성공해도 삭제 실패 안내(항목이 남은 이유)가 지워지지 않게.
  // 삭제 오류는 다음 삭제를 시도할 때만 지운다.
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const gate = useLatestGate();

  const load = async () => {
    const latest = gate();
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "recipes_list" })) as
        | { ok: boolean; data?: { sites: RecipeSite[] }; error?: string }
        | undefined;
      if (!res?.ok || !res.data) throw new Error(res?.error ?? "응답이 없습니다.");
      if (!latest()) return;
      setSites(res.data.sites);
      setError(null);
    } catch (err) {
      if (!latest()) return;
      // 목록을 읽지 못하면(가림 목록 읽기 실패 포함) 옛 목록을 보이지 않는다.
      setSites(null);
      setError(`읽기 방법 목록을 읽지 못했습니다(${err instanceof Error ? err.message : String(err)}).`);
    }
  };

  // 다른 화면·턴이 레시피를 바꾸면 다시 읽는다(열어 둔 동안만).
  useStorageKeys([READ_RECIPES_KEY], () => {
    if (open) void load();
  });

  const remove = async (keys: string[]) => {
    setBusy(true);
    setDeleteError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ kind: "recipe_delete", keys })) as { ok: boolean; error?: string } | undefined;
      if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
    } catch (err) {
      setDeleteError(`지우지 못했습니다(${err instanceof Error ? err.message : String(err)}).`);
    }
    setBusy(false);
    // 아무것도 지우지 않았으면(이미 지워짐) 저장소 변경 알림이 없으므로 직접 다시 읽는다.
    await load();
  };

  return (
    <details
      className="recipe-view"
      onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(isOpen);
        if (isOpen) void load();
      }}
    >
      <summary>저장된 읽기 방법 보기</summary>
      {deleteError && <span className="field-help error-text recipe-delete-error">{deleteError}</span>}
      {error && <span className="field-help error-text recipe-list-error">{error}</span>}
      {open && sites === null && !error && <span className="field-help">읽는 중…</span>}
      {sites && !sites.length && <span className="field-help">저장된 읽기 방법이 없습니다.</span>}
      {sites?.map((site) => (
        <div className="recipe-site" key={site.origin || "(unknown)"}>
          <div className="recipe-site-head">
            <strong className="recipe-origin">{site.origin || "알 수 없는 사이트"}</strong>
            <button type="button" className="link-btn recipe-delete-site" disabled={busy} onClick={() => void remove(site.reads.map((r) => r.key))}>
              이 사이트 모두 지우기
            </button>
          </div>
          <ul className="recipe-list">
            {site.reads.map((r) => (
              <li key={r.key} className="recipe-row">
                <span className="recipe-pattern">{r.pattern}</span>
                <span className="field-help">
                  {toolLabel(r.tool)} · {argsText(r.args)}
                </span>
                <span className="field-help">
                  쓴 횟수 {r.successes}번{r.failures ? ` · 최근 연속 실패 ${r.failures}번` : ""} · 마지막 사용 {dateText(r.lastUsed)}
                  <button type="button" className="link-btn recipe-delete" disabled={busy} onClick={() => void remove([r.key])}>
                    지우기
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

function argsText(args: Record<string, string | number | boolean>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length ? parts.join(", ") : "인자 없음";
}

function dateText(at: number): string {
  try {
    return new Date(at).toLocaleDateString("ko-KR");
  } catch {
    return "알 수 없음";
  }
}
