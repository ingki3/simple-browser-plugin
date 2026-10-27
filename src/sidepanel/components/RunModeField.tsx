import { RUN_MODES, type RunMode } from "@/lib/messages";
import { KO } from "../i18n/ko";
import { FieldHelp } from "./FieldHelp";

interface Props {
  mode: RunMode;
  onChange: (mode: RunMode) => void;
}

// 실행 방식(#123): 설정 → 동작. 입력창 아래의 RunModeSelect와 같은 설정 값이다.
export function RunModeField({ mode, onChange }: Props) {
  return (
    <div className="field" role="radiogroup" aria-label={KO.runModeLabel}>
      <span className="field-label">{KO.runModeLabel}</span>
      {RUN_MODES.map((m) => (
        <label key={m} className="check-row">
          <input type="radio" name="run-mode" value={m} checked={mode === m} onChange={() => onChange(m)} />
          <span>{KO.runModeLabels[m]}</span>
        </label>
      ))}
      <FieldHelp summary={KO.runModeHelp[mode]}>
        <b>{KO.runModeLabels.auto}</b>: 결제·주문 버튼과 결제 화면의 버튼, 가입·신청·제출 버튼, 개인정보(이름·연락처·주소 등)·비밀번호·결제 정보
        칸 입력, 개인정보가 채워진 양식의 버튼, 요청을 시작한 사이트(같은 등록 도메인 포함)나 카드로 이동을 허락한 사이트 밖으로 가는
        이동·링크와 그 밖의 사이트에서의 클릭·입력, 이미지 저장·파일 읽기·Google 문서 쓰기는 계속 묻습니다.
        <br />
        <b>{KO.runModeLabels.task}</b>: 승인이 필요한 첫 동작 전에 할 일과 위험을 보이고 한 번 묻습니다. 맡기면 새 대화를 시작하거나,
        다른 방식으로 바꾸거나, 입력창 위의 "{KO.taskRevoke}"를 누를 때까지 위 동작을 모두 묻지 않고 실행합니다. {KO.taskKeepAsking}
        <br />
        웹페이지에 숨겨진 지시문이 모델을 속여 원치 않는 곳으로 이동하거나 누르게 할 수 있으니, 묻지 않고 실행하는 방식은 믿을 수 있는
        사이트에서만 쓰세요.
      </FieldHelp>
    </div>
  );
}
