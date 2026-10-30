import { createContext, useContext } from "react";
import type { CurrentTab } from "../hooks/useCurrentTab";

// 패널 창의 활성 탭(App이 한 번 추적해 내려준다 — 기억하기 버튼·페이지 제안·말풍선의 제안 만들기, #174·#173).
export const CurrentTabContext = createContext<{ tab: CurrentTab | null; loadSeq: number }>({ tab: null, loadSeq: 0 });

export function useCurrentTabContext() {
  return useContext(CurrentTabContext);
}
