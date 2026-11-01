import { HistoryPickField } from "./HistoryPickField";

interface Props {
  open: boolean;
  onClose: () => void;
}

// 방문 기록에서 기억할 페이지 찾기(#175)의 패널 시트(#127). 추천을 이 패널 대화의 저장 카드로 띄우므로 설정 페이지가 아니라 패널에 둔다.
// 닫으면(✕·바깥·카드 보기) HistoryPickField가 사라지며 포트를 끊어 진행 중인 작업을 버린다.
export function HistoryPickSheet({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer history-pick-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>방문 기록에서 찾기</h2>
          <button type="button" className="ghost-btn" onClick={onClose}>
            닫기
          </button>
        </div>
        <div className="drawer-body">
          <HistoryPickField onOpened={onClose} />
        </div>
      </div>
    </div>
  );
}
