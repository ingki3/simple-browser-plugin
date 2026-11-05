// 긴 작업(모델 응답 기다리기·연결 확인 등) 동안 서비스 워커가 유휴로 끝나지 않게 붙잡는다.
// 30초 알람은 Chrome 120부터라 최소 지원 버전(116~119)에서는 1분으로 올림된다 — 그래서 기다리는 동안 20초마다
// 확장 API를 불러(Chrome 110+에서 유휴 타이머를 되돌림) 붙잡고, 알람은 워커가 그래도 멈췄을 때 깨우는 용도로 함께 둔다(#222).
const ALARM_NAME = "openrouter-heartbeat";
const PING_MS = 20_000;
let refCount = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // no-op; the purpose is to tickle the service worker
  }
});

function ping(): void {
  void chrome.runtime.getPlatformInfo().catch(() => {});
}

export function beginKeepalive(): void {
  refCount += 1;
  if (refCount === 1) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    ping();
    pingTimer = setInterval(ping, PING_MS);
  }
}

export function endKeepalive(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    chrome.alarms.clear(ALARM_NAME).catch(() => {
      /* ignore */
    });
  }
}
