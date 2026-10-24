interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 실제 입력 클릭(0.2.0) 켜기·끄기. 기본은 꺼짐.
export function TrustedInputField({ enabled, onToggle }: Props) {
  return (
    <div className="field">
      <span className="field-label">실제 마우스 입력으로 클릭</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>클릭을 페이지 스크립트 대신 브라우저의 실제 마우스 입력으로 보내기</span>
      </label>
      <span className="field-help">
        스크립트 클릭에 반응하지 않는 사이트에서도 누를 수 있습니다. 누르는 동안 탭 위에 "디버깅 중" 막대가 뜨고, 막대의 취소를 누르면 이
        대화에서는 다시 스크립트로 누릅니다. 승인 카드와 자동 실행 규칙은 같습니다. 예매 사이트처럼 자동화를 금지하는 사이트의 차단을
        피하는 기능이 아니며, 그런 사이트에서는 직접 조작해 주세요.
      </span>
    </div>
  );
}
