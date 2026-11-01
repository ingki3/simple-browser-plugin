import { useCallback, useEffect, useState } from "react";
import type { RepeatTask } from "@/lib/repeatTask";
import { useChatStore } from "../state/chatStore";
import { useLatestGate, useStorageKeys } from "./syncHelpers";

// 백그라운드 반복 작업 저장 키(src/background/repeatTasks.ts의 STORE_KEY).
const REPEAT_TASKS_KEY = "repeatTasks";

export type RepeatAction = "repeat_pause" | "repeat_resume" | "repeat_delete" | "repeat_run_now";

// 반복 작업 목록(#138). 백그라운드가 바뀌었다고 알리면(repeatVersion) 다시 읽는다.
export function useRepeatTasks() {
  const version = useChatStore((s) => s.repeatVersion);
  const [tasks, setTasks] = useState<RepeatTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 누르는 중인 버튼(동작:작업 id). 여러 요청이 겹칠 수 있다(확인 중에 멈추기).
  const [busy, setBusy] = useState<string | null>(null);

  // 늦게 온 옛 목록(먼저 보낸 조회)이 나중 조작의 결과를 되돌리지 않게 마지막 요청의 응답만 쓴다(#127).
  const gate = useLatestGate();
  const request = useCallback(
    async (msg: { kind: "repeat_list" } | { kind: RepeatAction; id: string }) => {
      const latest = gate();
      setError(null);
      try {
        const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: RepeatTask[]; error?: string } | undefined;
        if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
        if (latest()) setTasks(res.data ?? []);
      } catch (err) {
        if (latest() || msg.kind !== "repeat_list") setError(err instanceof Error ? err.message : String(err));
      }
    },
    [gate],
  );

  useEffect(() => {
    void request({ kind: "repeat_list" });
  }, [request, version]);
  // 패널 대화 포트가 없는 화면(설정 탭)도 등록·일시 정지·알람 실행 뒤 목록을 따라가게 저장소 변경을 본다.
  useStorageKeys([REPEAT_TASKS_KEY], () => void request({ kind: "repeat_list" }));

  const act = useCallback(
    async (kind: RepeatAction, id: string) => {
      const key = `${kind}:${id}`;
      setBusy(key);
      try {
        await request({ kind, id });
      } finally {
        setBusy((b) => (b === key ? null : b));
      }
    },
    [request],
  );

  return { tasks, error, busy, act };
}
