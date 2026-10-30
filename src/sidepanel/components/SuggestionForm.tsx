import { useState } from "react";
import { MAX_LABEL, MAX_PATH, MAX_REQUEST } from "@/lib/pageSuggest";

export interface SuggestionDraft {
  origin: string;
  path: string;
  label: string;
  request: string;
}

interface Props {
  initial: SuggestionDraft;
  // 출처를 고칠 수 있는지(말풍선에서 만들 때는 지금 탭의 출처로 고정).
  originEditable: boolean;
  onSave: (d: SuggestionDraft) => Promise<void>;
  onCancel: () => void;
}

// 페이지 제안 규칙 입력(#173): 사이트(출처)·경로 패턴·제안 문구·보낼 요청. 검증은 백그라운드가 다시 한다.
export function SuggestionForm({ initial, originEditable, onSave, onCancel }: Props) {
  const [d, setD] = useState<SuggestionDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="suggestion-form">
      <label className="field">
        <span className="field-label">사이트</span>
        {originEditable ? (
          <input className="suggestion-origin" value={d.origin} placeholder="https://medium.com" onChange={(e) => setD({ ...d, origin: e.target.value })} />
        ) : (
          <span className="suggestion-origin-fixed">{d.origin}</span>
        )}
      </label>
      <label className="field">
        <span className="field-label">경로 패턴</span>
        <input className="suggestion-path" value={d.path} maxLength={MAX_PATH} onChange={(e) => setD({ ...d, path: e.target.value })} />
        <span className="field-help">'*'는 경로 한 칸(예: /@글쓴이/*), 끝의 '**'는 그 아래 전부. 쿼리·해시는 보지 않습니다.</span>
      </label>
      <label className="field">
        <span className="field-label">제안 문구</span>
        <input className="suggestion-label-input" value={d.label} maxLength={MAX_LABEL} placeholder="번역해 드릴까요?" onChange={(e) => setD({ ...d, label: e.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">실행하면 보낼 요청</span>
        <textarea className="suggestion-request" value={d.request} maxLength={MAX_REQUEST} rows={2} onChange={(e) => setD({ ...d, request: e.target.value })} />
      </label>
      {error && <span className="field-help error-text">{error}</span>}
      <div className="page-offer-actions">
        <button type="button" className="btn-cancel" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="btn-approve suggestion-save" disabled={saving || !d.request.trim()} onClick={() => void save()}>
          저장
        </button>
      </div>
    </div>
  );
}
