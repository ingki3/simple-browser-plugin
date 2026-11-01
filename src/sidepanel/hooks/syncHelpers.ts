import { useCallback, useEffect, useRef, useState } from "react";

// 설정 화면을 오래·여러 개 열어 두어도 화면이 최신 값을 따라가게 하는 도구(#127).

// 요청 순번: 시작할 때 받은 확인 함수가 true일 때만(그 뒤에 시작한 요청이 없을 때만) 응답을 화면에 쓴다 — 늦게 온 옛 목록이
// 나중 조작의 결과를 되돌리지 않게.
export function useLatestGate(): () => () => boolean {
  const seq = useRef(0);
  return useCallback(() => {
    const n = ++seq.current;
    return () => n === seq.current;
  }, []);
}

// chrome.storage.local의 키가 바뀌면 부른다(다른 화면·백그라운드가 바꿔도).
export function useStorageKeys(keys: readonly string[], onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  const joined = keys.join("\n");
  useEffect(() => {
    const list = joined.split("\n");
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && list.some((k) => k in changes)) cb.current();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [joined]);
}

// 저장 값과 편집 초안을 나눈 입력 칸. 고치지 않은 칸은 저장 값이 바뀌면 따라가고, 고치는 중이면 초안을 두고 conflict를 켠다
// ("다른 곳에서 바뀌었습니다 — 저장하면 덮어씁니다"). 저장을 보낼 때 commit()(저장 뒤 칸이 저장 값을 따라감) 또는 expect(저장될 값)
// (입력하는 대로 저장하는 칸 — 그 값이 저장돼 돌아오면 내 저장으로 보고 초안을 그대로 둔다), 되돌릴 때 reset()을 부른다.
// resetKey가 바뀌면(제공자 바꾸기 등) 저장 값으로 새로 시작한다.
export function useSyncedDraft(saved: string, resetKey: string = "") {
  const [value, setValue] = useState(saved);
  const [conflict, setConflict] = useState(false);
  const edited = useRef(false);
  const base = useRef(saved);
  // 보낸(또는 보낼) 저장 값, 보낸 순서대로. 하나가 돌아오면 그보다 앞의 것(입력 중 지나간 값·먼저 보낸 저장)도 함께 지운다.
  const pending = useRef<string[]>([]);
  const key = useRef(resetKey);
  useEffect(() => {
    if (key.current !== resetKey) {
      key.current = resetKey;
      base.current = saved;
      edited.current = false;
      pending.current = [];
      setConflict(false);
      setValue(saved);
      return;
    }
    if (base.current === saved) return;
    base.current = saved;
    // 내가 보낸 저장이 돌아왔다: 기다리는 저장이 더 없으면 칸은 저장 값과 맞춰진 것으로 본다(이후 다른 곳의 변경을 따라간다).
    const i = pending.current.lastIndexOf(saved);
    if (i >= 0) {
      pending.current = pending.current.slice(i + 1);
      if (!pending.current.length) {
        edited.current = false;
        setConflict(false);
      }
      return;
    }
    if (edited.current) setConflict(true);
    else setValue(saved);
  }, [saved, resetKey]);
  // 저장 값과 같은 글자로 돌아오면(저장해도 저장 값이 바뀌지 않아 돌아오는 알림이 없다) 고치지 않은 칸으로 본다.
  const set = useCallback((v: string) => {
    edited.current = v !== base.current;
    if (!edited.current) {
      pending.current = [];
      setConflict(false);
    }
    setValue(v);
  }, []);
  const commit = useCallback(() => {
    edited.current = false;
    pending.current = [];
    setConflict(false);
  }, []);
  const expect = useCallback((v: string) => {
    if (v === base.current) {
      // 저장될 값이 이미 저장 값이다: 기다릴 알림이 없다.
      pending.current = [];
      edited.current = false;
      setConflict(false);
      return;
    }
    if (pending.current.at(-1) !== v) pending.current.push(v);
    if (pending.current.length > 50) pending.current = pending.current.slice(-50);
    setConflict(false);
  }, []);
  const reset = useCallback(() => {
    edited.current = false;
    pending.current = [];
    setConflict(false);
    setValue(base.current);
  }, []);
  return { value, set, commit, expect, reset, conflict };
}
