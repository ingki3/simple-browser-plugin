interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 자동 실행 켜기·끄기. 켜도 결제와 개인정보 제출은 승인 카드를 띄운다(src/lib/autoApprove.ts).
export function AutoApproveField({ enabled, onToggle }: Props) {
  return (
    <div className="field">
      <span className="field-label">자동 실행</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>페이지 이동·클릭·입력을 묻지 않고 실행</span>
      </label>
      <span className="field-help">
        켜도 결제·주문 버튼과 결제 화면의 버튼, 가입·신청·제출 버튼, 개인정보(이름·연락처·주소 등)·비밀번호·결제 정보 칸 입력,
        개인정보가 채워진 양식의 버튼, 요청을 시작한 사이트(또는 카드로 이동을 허락한 사이트) 밖으로 가는 이동·링크와 그 밖의
        사이트에서의 클릭·입력은 계속 묻습니다. 이미지 저장·파일 읽기·Google 문서
        쓰기도 계속 묻습니다. 웹페이지에 숨겨진 지시문이 모델을 속여
        원치 않는 곳으로 이동하거나 누르게 할 수 있으니, 믿을 수 있는 사이트에서만 켜 두세요.
      </span>
    </div>
  );
}
