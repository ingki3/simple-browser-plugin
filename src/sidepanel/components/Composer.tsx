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
    if (!v) return;
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
