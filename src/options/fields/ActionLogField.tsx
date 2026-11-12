import { FieldHelp } from "./FieldHelp";
import { useEffect, useState } from "react";
import { ACTION_LOG_KEY, PATH_RECIPES_KEY, READ_RECIPES_KEY } from "@/lib/messages";
import { useLatestGate, useStorageKeys } from "../../sidepanel/hooks/syncHelpers";
import { ReadRecipesList } from "./ReadRecipesList";

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 동작 기록 켜기·끄기와 지우기. 개수 조회와 지우기는 백그라운드에 맡긴다(기록 쓰기와 순서를 맞추려고).
export function ActionLogField({ enabled, onToggle }: Props) {
  const [count, setCount] = useState<{ log: number; recipes: number; paths?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 지우기·개수 조회가 실패하면 알린다(#130).
  const gate = useLatestGate();
  const request = async (kind: "action_log_count" | "action_log_clear") => {
    const latest = gate();
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage({ kind })) as
        | { ok: boolean; data?: { log: number; recipes: number; paths?: number }; error?: string }
        | undefined;
      if (!res?.ok || !res.data) throw new Error(res?.error ?? "응답이 없습니다.");
      if (latest()) setCount(res.data);
    } catch (err) {
      if (!latest() && kind === "action_log_count") return;
      const why = err instanceof Error ? err.message : String(err);
      setError(kind === "action_log_clear" ? `기록을 지우지 못했습니다(${why}).` : `기록 개수를 읽지 못했습니다(${why}).`);
    }
  };

  useEffect(() => {
    void request("action_log_count");
  }, []);
  // 기록이 쌓이거나 다른 화면에서 지우면 개수를 다시 읽는다(설정 탭을 오래 열어 두어도, #127).
  useStorageKeys([ACTION_LOG_KEY, READ_RECIPES_KEY, PATH_RECIPES_KEY], () => void request("action_log_count"));

  const clear = async () => {
    setBusy(true);
    await request("action_log_clear");
    setBusy(false);
  };

  return (
    <div className="field">
      <span className="field-label">동작 기록</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>클릭·입력 동작과 통한 읽기 방법·이동 경로를 이 브라우저에 기록</span>
      </label>
      <div className="key-row">
        <span className="field-help">
          저장된 기록 {count?.log ?? "…"}건 · 읽기 방법 {count?.recipes ?? "…"}개 · 이동 경로 {count?.paths ?? "…"}개
        </span>
        <button type="button" className="ghost-btn" disabled={busy || !count || !(count.log || count.recipes || count.paths)} onClick={clear}>
          {busy ? "지우는 중…" : "기록 지우기"}
        </button>
      </div>
      {error && <span className="field-help error-text">{error}</span>}
      <ReadRecipesList />
      <FieldHelp summary="누르거나 채운 기록과 통한 읽기 방법·이동 경로만 이 브라우저에 남깁니다(입력값·페이지 내용은 남기지 않음).">
        어느 페이지에서 무엇을 누르거나 채웠는지와 그 결과, 같은 구조의 페이지에서 내용을 읽는 데 통한 방법(선택자·검색어)만
        남깁니다. 읽기 방법은 다음에 같은 구조의 페이지를 볼 때 먼저 시도합니다. 입력한 값과 페이지 내용은 남기지 않고,
        외부로 보내지 않습니다. 시크릿 창은 기록하지 않습니다. 30일이 지나거나 500건을 넘으면 오래된 것부터 지웁니다.
        "저장된 읽기 방법 보기"에서 사이트별로 주소 틀·도구·인자·쓴 횟수를 보고 하나씩 또는 사이트째 지울 수 있습니다. 지운 방법은
        다음 페이지 살펴보기부터 후보로 내지 않습니다. 자동 로그인으로 넣은 값이 보이는 항목은 목록에 보이지 않습니다.
        이동 경로는 한 요청에서 같은 사이트 안을 옮겨 다니며 답을 마쳤을 때 거쳐 간 주소 틀(예: /help → /help/notice/list)만 남기고,
        다음에 그 경로의 페이지를 볼 때 남은 구간을 먼저 시도할 후보로 냅니다(승인은 평소대로 묻습니다). 쓴 횟수는 그 경로로 답을 마친
        횟수이지 원하는 것을 찾았다는 뜻이 아니므로, 맞지 않는 경로는 여기서 지워 주세요(30일이 지나면 저절로 지워집니다). 다른 사이트로
        넘어가거나, 주문·결제·개인정보·삭제 낱말이 든 주소를 거치거나, 카드로 물어야 했을 동작·로그인·직접 조작·팝업이 있었던 요청은
        경로로 남기지 않습니다. 그래서 주문 내역(/mypage/order/list 같은 주소)은 경로로 기억하지 못하니 저장 링크로 기억해 주세요.
      </FieldHelp>
    </div>
  );
}
