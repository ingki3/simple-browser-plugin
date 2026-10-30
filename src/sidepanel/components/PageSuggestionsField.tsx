import { useState } from "react";
import { displayPath } from "@/lib/pageSuggest";
import { useSuggestionRules } from "../hooks/useSuggestionRules";
import { SuggestionForm } from "./SuggestionForm";

interface Props {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}

// 페이지 제안(#173) 켜기·끄기와 규칙 목록(켜기·끄기·고치기·지우기·직접 추가).
export function PageSuggestionsField({ enabled, onToggle }: Props) {
  const { rules, request } = useSuggestionRules();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (msg: Parameters<typeof request>[0]) => {
    setError(null);
    try {
      await request(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="field page-suggestions">
      <span className="field-label">페이지 제안</span>
      <label className="check-row">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <span>정해 둔 주소의 페이지를 열면 입력창 위에 할 일을 제안하기(주소만 보고 판단, 실행은 누를 때만)</span>
      </label>
      <span className="field-help">채팅의 내 요청 아래 "이 페이지에서 제안"으로 만들거나 여기서 직접 추가합니다.</span>
      {error && <span className="field-help error-text">{error}</span>}
      <ul className="suggestion-list">
        {rules.map((r) =>
          editing === r.id ? (
            <li key={r.id}>
              <SuggestionForm
                initial={{ origin: r.origin, path: displayPath(r.path), label: r.label, request: r.request }}
                originEditable
                onCancel={() => setEditing(null)}
                onSave={async (d) => {
                  await request({ kind: "page_suggest_update", id: r.id, ...d });
                  setEditing(null);
                }}
              />
            </li>
          ) : (
            <li key={r.id} className={r.enabled ? "" : "disabled"}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => void run({ kind: "page_suggest_update", id: r.id, enabled: e.target.checked })}
                />
                <span>
                  <strong>{r.label}</strong> — {r.origin}
                  {displayPath(r.path)}
                </span>
              </label>
              <span className="field-help">요청: {r.request}</span>
              <span>
                <button type="button" className="link-btn" onClick={() => setEditing(r.id)}>
                  고치기
                </button>
                <button type="button" className="link-btn suggestion-delete" onClick={() => void run({ kind: "page_suggest_delete", id: r.id })}>
                  지우기
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
      {editing === "new" ? (
        <SuggestionForm
          initial={{ origin: "", path: "/**", label: "", request: "" }}
          originEditable
          onCancel={() => setEditing(null)}
          onSave={async (d) => {
            await request({ kind: "page_suggest_add", ...d });
            setEditing(null);
          }}
        />
      ) : (
        <button type="button" className="ghost-btn suggestion-add" onClick={() => setEditing("new")}>
          제안 추가
        </button>
      )}
    </div>
  );
}
