import { FieldHelp } from "./FieldHelp";
import { useEffect, useState } from "react";
import { MAX_LINKS, MAX_PURPOSE, templateText, type SavedLink } from "@/lib/savedPages";

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 페이지 기억하기(#30) 켜기·끄기와 저장 목록·지우기.
export function RememberPagesField({ enabled, onToggle }: Props) {
  const [pages, setPages] = useState<SavedLink[] | null>(null);
  // 고치는 중인 링크(id)와 고친 이름·용도.
  const [editing, setEditing] = useState<{ id: string; name: string; purpose: string } | null>(null);

  const request = async (
    msg:
      | { kind: "saved_pages_list" }
      | { kind: "saved_pages_delete"; id: string | null }
      | { kind: "saved_link_update"; id: string; name: string; purpose: string },
  ) => {
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: SavedLink[] } | undefined;
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
        <span>답을 마친 뒤 도착한 페이지를 "이 페이지 기억하기"로 저장하고, 용도에 맞는 요청에 다시 쓰기</span>
      </label>
      {pages && pages.length > 0 && (
        <ul className="saved-pages">
          {pages.map((p) =>
            editing?.id === p.id ? (
              <li key={p.id} className="saved-edit">
                <input value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <input
                  value={editing.purpose}
                  maxLength={MAX_PURPOSE}
                  placeholder="용도(예: 쇼핑을 위한 가격 비교 검색)"
                  onChange={(e) => setEditing({ ...editing, purpose: e.target.value })}
                />
                <div className="key-row">
                  <button type="button" className="ghost-btn" onClick={() => setEditing(null)}>
                    취소
                  </button>
                  <button
                    type="button"
                    className="ghost-btn"
                    disabled={!editing.name.trim()}
                    onClick={() => {
                      void request({ kind: "saved_link_update", ...editing });
                      setEditing(null);
                    }}
                  >
                    저장
                  </button>
                </div>
              </li>
            ) : (
              <li key={p.id}>
                <span className="saved-name">
                  {p.name}
                  {p.purpose ? <span className="saved-purpose"> — {p.purpose}</span> : null}
                </span>
                <span className="saved-url">{templateText(p.template)}</span>
                <span className="saved-actions">
                  <button type="button" className="ghost-btn" onClick={() => setEditing({ id: p.id, name: p.name, purpose: p.purpose })}>
                    고치기
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => void request({ kind: "saved_pages_delete", id: p.id })}>
                    지우기
                  </button>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="key-row">
        <span className="field-help">
          저장한 링크 {pages?.length ?? "…"}/{MAX_LINKS}개
        </span>
        <button
          type="button"
          className="ghost-btn"
          disabled={!pages?.length}
          onClick={() => void request({ kind: "saved_pages_delete", id: null })}
        >
          모두 지우기
        </button>
      </div>
      <FieldHelp summary="저장한 링크는 요청이 용도에 맞으면 도우미가 값을 넣어 엽니다.">
        저장은 직접 누를 때만 합니다(요청 문장과 입력 자리의 값은 저장하지 않음). 저장한 이름·용도·입력 자리 이름·사이트는 사이트와
        관계없이 설정에서 고른 모델 제공자에 후보로 전송되고, 요청이 용도에 맞으면 도우미가 자리에 값을 넣어 엽니다(자동 실행이 켜져 있으면
        카드 없이). {MAX_LINKS}개를 넘으면 가장 오래 쓰지 않은 링크부터 지웁니다. 지우거나 끄면 다음 요청부터 후보로 보내지 않지만,
        이미 대화에서 쓰거나 인용한 내용은 새 대화 전까지 대화 기록에 남아 전송될 수 있습니다. 시크릿 창에서는 저장·후보 제공을 하지
        않습니다.
      </FieldHelp>
    </div>
  );
}
