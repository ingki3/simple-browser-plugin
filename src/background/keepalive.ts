// 긴 작업(모델 응답 기다리기·연결 확인 등) 동안 서비스 워커가 유휴로 끝나지 않게 붙잡는다.
// 30초 알람은 Chrome 120부터라 최소 지원 버전(116~119)에서는 1분으로 올림된다 — 그래서 기다리는 동안 20초마다
// 확장 API를 불러(Chrome 110+에서 유휴 타이머를 되돌림) 붙잡고, 알람은 워커가 그래도 멈췄을 때 깨우는 용도로 함께 둔다(#222).
// 알람 만들기·지우기는 큐 하나로 한 줄로 세우고, 각 작업은 실행될 때의 참조 수에 맞춘다(#307 — 지우기와 바로 뒤의 만들기가
// 겹쳐 순서가 뒤바뀌지 않게, 그래서 마지막 작업이 마지막 참조 상태를 반영한다). 앞 작업이 실패해도 다음 작업은 돈다.
import { createSerial } from "@/lib/async";

const ALARM_NAME = "openrouter-heartbeat";
const PING_MS = 20_000;
let refCount = 0;
let pingTimer: ReturnType<typeof setInterval> | null = null;
const alarmQueue = createSerial();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // 깨우는 것이 목적이다. 잡은 참조가 없으면(강제 종료 뒤 새 워커가 남은 알람에 깨어난 경우 등) 알람을 지운다 — 다시 만들지는 않는다.
  void alarmQueue(async () => {
    if (refCount === 0) await chrome.alarms.clear(ALARM_NAME);
  }).catch(() => {});
});

function ping(): void {
  void chrome.runtime.getPlatformInfo().catch(() => {});
}

// 실행될 때의 참조 수에 알람을 맞춘다(0보다 크면 만들고, 0이면 지운다).
function syncAlarm(): void {
  void alarmQueue(async () => {
    if (refCount > 0) await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
    else await chrome.alarms.clear(ALARM_NAME);
  }).catch(() => {});
}

export function beginKeepalive(): void {
  refCount += 1;
  if (refCount === 1) {
    syncAlarm();
    ping();
    pingTimer = setInterval(ping, PING_MS);
  }
}

export function endKeepalive(): void {
  if (refCount === 0) return;
  refCount -= 1;
  if (refCount === 0) {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
    syncAlarm();
  }
}
