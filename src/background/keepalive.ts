const ALARM_NAME = "openrouter-heartbeat";
let refCount = 0;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // no-op; the purpose is to tickle the service worker
  }
});

export function beginKeepalive(): void {
  refCount += 1;
  if (refCount === 1) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  }
}

export function endKeepalive(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    chrome.alarms.clear(ALARM_NAME).catch(() => {
      /* ignore */
    });
  }
}
