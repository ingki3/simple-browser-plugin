import { useEffect, useState } from "react";

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 동작 기록 켜기·끄기와 지우기. 개수 조회와 지우기는 백그라운드에 맡긴다(기록 쓰기와 순서를 맞추려고).
export function ActionLogField({ enabled, onToggle }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async (kind: "action_log_count" | "action_log_clear") => {
    try {
      const res = (await chrome.runtime.sendMessage({ kind })) as { ok: boolean; data?: number } | undefined;
      if (res?.ok && typeof res.data === "number") setCount(res.data);
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
        <span>클릭·입력 동작을 이 브라우저에 기록</span>
      </label>
      <div className="key-row">
        <span className="field-help">저장된 기록 {count ?? "…"}건</span>
        <button type="button" className="ghost-btn" disabled={busy || !count} onClick={clear}>
          {busy ? "지우는 중…" : "기록 지우기"}
        </button>
      </div>
      <span className="field-help">
        어느 페이지에서 무엇을 누르거나 채웠는지와 그 결과만 남깁니다. 입력한 값은 남기지 않고, 외부로 보내지
        않습니다. 시크릿 창은 기록하지 않습니다. 30일이 지나거나 500건을 넘으면 오래된 것부터 지웁니다.
      </span>
    </div>
  );
}
