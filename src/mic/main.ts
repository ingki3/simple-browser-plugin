// 음성 입력(#184)의 마이크 권한 받기. 사이드 패널은 권한 대화상자를 띄우지 못할 수 있어, 확장 출처의 이 탭에서 한 번 허용받는다
// (권한은 확장 출처 단위라 패널에도 적용된다). 받으면 바로 트랙을 멈추고 녹음하지 않는다.
const statusEl = document.getElementById("status");
const show = (t: string) => {
  if (statusEl) statusEl.textContent = t;
};

void (async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of stream.getTracks()) t.stop();
    show("허용했습니다. 사이드 패널로 돌아가 🎤를 다시 누르세요. 이 탭은 곧 닫힙니다.");
    window.setTimeout(() => window.close(), 2500);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    show(
      name === "NotFoundError"
        ? "마이크를 찾지 못했습니다."
        : "허용하지 않았습니다. 다시 하려면 주소창 왼쪽의 사이트 정보에서 마이크를 허용하거나 chrome://settings/content/microphone 에서 이 확장을 허용하세요.",
    );
  }
})();
export {};
