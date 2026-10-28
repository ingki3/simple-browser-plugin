import { useState } from "react";

// 확장 옵션 페이지(#99). 설정은 사이드 패널의 설정(⚙) 한 곳에서 한다 — 같은 항목을 두 곳에서 따로 고치면 서로 덮어쓰고 문구·검증이
// 두 벌이 되어서다. 이 페이지는 그곳으로 안내만 한다.
export function Options() {
  const [error, setError] = useState<string | null>(null);

  const openPanel = async () => {
    setError(null);
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id === undefined) throw new Error("창을 찾지 못했습니다.");
      await chrome.sidePanel.open({ windowId: win.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="options">
      <h1>간편 브라우저 도우미 설정</h1>
      <p className="intro">
        모든 설정(모델 제공자·API 키·모델, 실행 방식, 직접 조작할 사이트, 저장한 링크, 동작 기록, Google 연결 등)은 사이드 패널의
        설정(⚙)에서 바꿉니다. 바꾸면 바로 저장됩니다.
      </p>
      <button className="primary" onClick={() => void openPanel()}>
        사이드 패널 열기
      </button>
      {error && <p className="intro">사이드 패널을 열지 못했습니다({error}). 도구 모음의 확장 아이콘을 눌러 여세요.</p>}
    </div>
  );
}
