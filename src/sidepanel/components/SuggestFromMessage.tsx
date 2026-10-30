import { useState } from "react";
import { defaultPattern } from "@/lib/pageSuggest";
import { useCurrentTabContext } from "../state/currentTab";
import { SuggestionForm } from "./SuggestionForm";

// 사용자 말풍선의 "이 페이지에서 제안"(#173): 이 요청을 지금 페이지와 같은 주소 형태에서 다시 제안하도록 규칙을 만든다.
// 사용자가 출처(지금 탭)·경로 패턴·문구·요청을 확인하고 저장할 때만 만든다.
export function SuggestFromMessage({ text }: { text: string }) {
  const { tab } = useCurrentTabContext();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!tab || !tab.web) return null;
  if (saved) return <div className="suggest-from-msg saved">✓ 이 페이지 형태에서 제안합니다(설정 → 페이지 제안에서 고칠 수 있음).</div>;
  if (!open) {
    return (
      <button type="button" className="link-btn suggest-from-msg-open" onClick={() => setOpen(true)}>
        이 페이지에서 제안
      </button>
    );
  }
  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return null;
  }
  return (
    <div className="suggest-from-msg">
      <SuggestionForm
        initial={{ origin, path: defaultPattern(tab.url), label: text.replace(/\s+/g, " ").trim().slice(0, 40), request: text }}
        originEditable={false}
        onCancel={() => setOpen(false)}
        onSave={async (d) => {
          const res = (await chrome.runtime.sendMessage({ kind: "page_suggest_add", ...d })) as { ok: boolean; error?: string } | undefined;
          if (!res?.ok) throw new Error(res?.error ?? "응답이 없습니다.");
          setSaved(true);
        }}
      />
    </div>
  );
}
