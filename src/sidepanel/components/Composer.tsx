import { useRef, useState, type KeyboardEvent } from "react";
import { useChatStore } from "../state/chatStore";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { KO } from "../i18n/ko";

interface Props {
  onSend: (text: string) => void;
  onAbort: () => void;
  needsKey: boolean;
  onOpenSettings: () => void;
}

export function Composer({ onSend, onAbort, needsKey, onOpenSettings }: Props) {
  const [value, setValue] = useState("");
  const streaming = useChatStore((s) => s.streaming);
  const conversationId = useChatStore((s) => s.conversationId);
  const input = useRef<HTMLTextAreaElement>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  // 음성 입력(#184): 받아쓴 글자는 입력창의 커서 자리에 끼워 넣기만 한다(기존 글자 보존, 자동으로 보내지 않음).
  const voice = useVoiceInput({
    conversationId,
    onText: (text, truncated) => {
      const el = input.current;
      setValue((cur) => {
        const at = el && document.activeElement === el ? el.selectionStart : cur.length;
        const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
        const before = cur.slice(0, at);
        const after = cur.slice(end);
        const sep = before && !/\s$/.test(before) ? " " : "";
        return `${before}${sep}${text}${after}`;
      });
      setVoiceNote(truncated ? "받아쓴 글자가 길어 앞부분만 넣었습니다." : null);
      el?.focus();
    },
  });
  const vs = voice.state;

  const submit = () => {
    const v = value.trim();
    // 응답 중 Enter로 보내면 백그라운드에서 두 턴이 같은 대화 기록에 동시에 쓴다.
    if (!v || streaming) return;
    // 키가 없으면 보내지 않고 설정을 연다. 쓴 글은 지우지 않는다.
    if (needsKey) {
      onOpenSettings();
      return;
    }
    onSend(v);
    setValue("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const micTitle =
    vs.phase === "recording"
      ? `듣는 중 · ${vs.label} · 누르면 멈추고 글자로 바꿉니다`
      : vs.phase === "starting"
        ? "준비 중 · 누르면 취소"
        : vs.phase === "transcribing"
          ? `${vs.label}로 글자로 바꾸는 중 · 누르면 취소`
          : "말로 입력(음성 입력)";

  return (
    <>
      {needsKey && value.trim() && <div className="composer-hint">{KO.composerNeedsKey}</div>}
      {vs.phase === "recording" && (
        <div className="composer-hint voice-live" role="status">
          <span className="voice-dot" aria-hidden="true" /> 듣는 중 {vs.seconds}초 · {vs.label} {vs.model}로 받아씁니다
        </div>
      )}
      {vs.phase === "transcribing" && (
        <div className="composer-hint" role="status">
          {vs.label}로 글자로 바꾸는 중…
        </div>
      )}
      {vs.phase === "error" && (
        <div className="composer-hint voice-error" role="alert">
          {vs.message}
          {vs.settings && (
            <button type="button" className="ghost-btn" onClick={onOpenSettings}>
              설정 열기
            </button>
          )}
          <button type="button" className="ghost-btn" onClick={voice.dismiss} aria-label="안내 닫기">
            ✕
          </button>
        </div>
      )}
      {voiceNote && vs.phase === "idle" && <div className="composer-hint">{voiceNote}</div>}
      <div className="composer">
        <button
          type="button"
          className={`composer-btn mic${vs.phase === "recording" ? " live" : ""}`}
          onClick={() => {
            setVoiceNote(null);
            voice.toggle();
          }}
          title={micTitle}
          aria-label={micTitle}
          aria-pressed={vs.phase === "recording"}
        >
          {vs.phase === "recording" ? "■" : vs.phase === "starting" || vs.phase === "transcribing" ? "…" : "🎤"}
        </button>
        <textarea
          ref={input}
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
    </>
  );
}
