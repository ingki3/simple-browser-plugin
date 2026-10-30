import { useCallback, useEffect, useState } from "react";
import type { SuggestionRule } from "@/lib/pageSuggest";

const KEY = "pageSuggestions";

type Req =
  | { kind: "page_suggest_list" }
  | { kind: "page_suggest_add"; origin: string; path: string; label: string; request: string }
  | { kind: "page_suggest_update"; id: string; origin?: string; path?: string; label?: string; request?: string; enabled?: boolean }
  | { kind: "page_suggest_delete"; id: string };

// 페이지 제안 규칙(#173). 저장소가 바뀌면(다른 화면에서 고쳐도) 다시 읽는다. 쓰기는 백그라운드가 검증한다.
export function useSuggestionRules() {
  const [rules, setRules] = useState<SuggestionRule[]>([]);
  const request = useCallback(async (msg: Req): Promise<SuggestionRule[]> => {
    const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: SuggestionRule[]; error?: string } | undefined;
    if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
    const list = res.data ?? [];
    setRules(list);
    return list;
  }, []);
  useEffect(() => {
    void request({ kind: "page_suggest_list" }).catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && KEY in changes) void request({ kind: "page_suggest_list" }).catch(() => {});
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [request]);
  return { rules, request };
}
