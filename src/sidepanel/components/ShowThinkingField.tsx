interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

export function ShowThinkingField({ enabled, onToggle }: Props) {
  return (
    <div className="field">
      <span className="field-label">생각 과정 보기</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>모델이 생각하는 글을 펼쳐 보기</span>
      </label>
      <span className="field-help">
        끄면(기본) 모델이 생각하는 동안 "생각 중…" 표시만 보입니다. 도구를 쓰기 전 짧은 설명과 답변은 그대로 보입니다.
      </span>
    </div>
  );
}
