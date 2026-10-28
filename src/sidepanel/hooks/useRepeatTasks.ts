import { useCallback, useEffect, useState } from "react";
import type { RepeatTask } from "@/lib/repeatTask";
import { useChatStore } from "../state/chatStore";

export type RepeatAction = "repeat_pause" | "repeat_resume" | "repeat_delete" | "repeat_run_now";

// 반복 작업 목록(#138). 백그라운드가 바뀌었다고 알리면(repeatVersion) 다시 읽는다.
export function useRepeatTasks() {
  const version = useChatStore((s) => s.repeatVersion);
  const [tasks, setTasks] = useState<RepeatTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 누르는 중인 버튼(동작:작업 id). 여러 요청이 겹칠 수 있다(확인 중에 멈추기).
  const [busy, setBusy] = useState<string | null>(null);

  const request = useCallback(async (msg: { kind: "repeat_list" } | { kind: RepeatAction; id: string }) => {
    setError(null);
    try {
      const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: RepeatTask[]; error?: string } | undefined;
      if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
      setTasks(res.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void request({ kind: "repeat_list" });
  }, [request, version]);

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
