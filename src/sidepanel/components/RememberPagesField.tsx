import { useEffect, useState } from "react";
import type { SavedPage } from "@/lib/savedPages";

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 페이지 기억하기(#30) 켜기·끄기와 저장 목록·지우기.
export function RememberPagesField({ enabled, onToggle }: Props) {
  const [pages, setPages] = useState<SavedPage[] | null>(null);

  const request = async (msg: { kind: "saved_pages_list" } | { kind: "saved_pages_delete"; url: string | null }) => {
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: SavedPage[] } | undefined;
      if (res?.ok && res.data) setPages(res.data);
      else if (res?.ok) setPages([]);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void request({ kind: "saved_pages_list" });
  }, []);

  return (
    <div className="field">
      <span className="field-label">페이지 기억하기</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>답을 마친 뒤 도착한 페이지를 "이 페이지 기억하기"로 저장하고, 같은 사이트에서 이동 후보로 쓰기</span>
      </label>
      {pages && pages.length > 0 && (
        <ul className="saved-pages">
          {pages.map((p) => (
            <li key={p.url}>
              <span className="saved-name">{p.name}</span>
              <span className="saved-url">{p.url}</span>
              <button type="button" className="ghost-btn" onClick={() => void request({ kind: "saved_pages_delete", url: p.url })}>
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="key-row">
        <span className="field-help">저장한 페이지 {pages?.length ?? "…"}개</span>
        <button
          type="button"
          className="ghost-btn"
          disabled={!pages?.length}
          onClick={() => void request({ kind: "saved_pages_delete", url: null })}
        >
          모두 지우기
        </button>
      </div>
      <span className="field-help">
        저장은 직접 누를 때만 합니다(요청 문장은 저장하지 않음). 저장한 이름과 주소는 같은 사이트에서 도우미를 쓸 때 모델(OpenRouter)에
        이동 후보로 전송됩니다. 지우거나 끄면 다음 요청부터 후보로 보내지 않지만, 이미 대화에서 쓰거나 인용한 이름·주소는 새 대화 전까지
        대화 기록에 남아 전송될 수 있고 이미 보낸 요청은 되돌릴 수 없습니다. 시크릿 창에서는 저장·후보 제공을 하지 않습니다.
      </span>
    </div>
  );
}
