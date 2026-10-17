import { useEffect, useState } from "react";

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 동작 기록 켜기·끄기와 지우기. 개수 조회와 지우기는 백그라운드에 맡긴다(기록 쓰기와 순서를 맞추려고).
export function ActionLogField({ enabled, onToggle }: Props) {
  const [count, setCount] = useState<{ log: number; recipes: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (kind: "action_log_count" | "action_log_clear") => {
    try {
      const res = (await chrome.runtime.sendMessage({ kind })) as
        | { ok: boolean; data?: { log: number; recipes: number } }
        | undefined;
      if (res?.ok && res.data) setCount(res.data);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void request("action_log_count");
  }, []);

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
        <span>클릭·입력 동작과 통한 읽기 방법을 이 브라우저에 기록</span>
      </label>
      <div className="key-row">
        <span className="field-help">
          저장된 기록 {count?.log ?? "…"}건 · 읽기 방법 {count?.recipes ?? "…"}개
        </span>
        <button type="button" className="ghost-btn" disabled={busy || !count || !(count.log || count.recipes)} onClick={clear}>
          {busy ? "지우는 중…" : "기록 지우기"}
        </button>
      </div>
      <span className="field-help">
        어느 페이지에서 무엇을 누르거나 채웠는지와 그 결과, 같은 구조의 페이지에서 내용을 읽는 데 통한 방법(선택자·검색어)만
        남깁니다. 읽기 방법은 다음에 같은 구조의 페이지를 볼 때 먼저 시도합니다. 입력한 값과 페이지 내용은 남기지 않고,
        외부로 보내지 않습니다. 시크릿 창은 기록하지 않습니다. 30일이 지나거나 500건을 넘으면 오래된 것부터 지웁니다.
      </span>
    </div>
  );
}
