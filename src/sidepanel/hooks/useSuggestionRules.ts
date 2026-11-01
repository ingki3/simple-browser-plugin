import { useCallback, useEffect, useState } from "react";
import { useLatestGate } from "./syncHelpers";
import type { SuggestionRule } from "@/lib/pageSuggest";

const KEY = "pageSuggestions";

type Req =
  | { kind: "page_suggest_list" }
  | { kind: "page_suggest_add"; origin: string; path: string; label: string; request: string }
  | { kind: "page_suggest_update"; id: string; origin?: string; path?: string; label?: string; request?: string; enabled?: boolean; expectVersion?: number }
  | { kind: "page_suggest_delete"; id: string };

// 페이지 제안 규칙(#173). 저장소가 바뀌면(다른 화면에서 고쳐도) 다시 읽는다. 쓰기는 백그라운드가 검증한다.
export function useSuggestionRules() {
  const [rules, setRules] = useState<SuggestionRule[]>([]);
  // 마지막 요청의 응답만 화면에 쓴다(늦게 온 옛 목록이 나중 조작을 되돌리지 않게, #127).
  const gate = useLatestGate();
  const request = useCallback(
    async (msg: Req): Promise<SuggestionRule[]> => {
      const latest = gate();
      const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: SuggestionRule[]; error?: string } | undefined;
      if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
      const list = res.data ?? [];
      if (latest()) setRules(list);
      return list;
    },
    [gate],
  );
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
