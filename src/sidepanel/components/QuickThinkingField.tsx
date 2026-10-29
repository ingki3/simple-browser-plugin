import { FieldHelp } from "./FieldHelp";
interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 빠르게 생각(#160): 생각을 줄여 단계마다 빨리 답한다. 승인·자동 실행 판정은 바뀌지 않는다.
export function QuickThinkingField({ enabled, onToggle }: Props) {
  return (
    <div className="field">
      <span className="field-label">빠르게 생각</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>생각을 줄여 단계마다 빨리 답하기</span>
      </label>
      <FieldHelp summary="모델이 단계마다 생각하는 양을 줄여 더 빨리 진행합니다.">
        어려운 작업은 정확도가 떨어질 수 있습니다. 바꾼 값은 다음 요청부터 적용됩니다. 승인 카드·자동 실행 규칙은 그대로입니다.
      </FieldHelp>
    </div>
  );
}
