import { useState, type KeyboardEvent } from "react";
import { useChatStore } from "../state/chatStore";
import { KO } from "../i18n/ko";

interface Props {
  onSend: (text: string) => void;
  onAbort: () => void;
}

export function Composer({ onSend, onAbort }: Props) {
  const [value, setValue] = useState("");
  const streaming = useChatStore((s) => s.streaming);

  const submit = () => {
    const v = value.trim();
    // 응답 중 Enter로 보내면 백그라운드에서 두 턴이 같은 대화 기록에 동시에 쓴다.
    if (!v || streaming) return;
    onSend(v);
    setValue("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        placeholder={KO.composerPlaceholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        rows={2}
      />
      {streaming ? (
        <button className="composer-btn danger" onClick={onAbort} type="button">
          {KO.abort}
        </button>
      ) : (
        <button className="composer-btn primary" onClick={submit} type="button" disabled={!value.trim()}>
          {KO.send}
        </button>
      )}
    </div>
  );
}
