import { useLayoutEffect, useRef, useState } from "react";

interface Props {
  text: string;
  // 생각 스트리밍 중이고 아직 본문 답변이 시작되지 않은 상태.
  live: boolean;
}

// 바닥에서 이 거리 안이면 "끝에 붙어 있음"으로 보고 자동 스크롤을 유지.
const STICK_THRESHOLD_PX = 24;

export function ThoughtBox({ text, live }: Props) {
  // 사용자가 직접 펼침/접음을 바꾸면 그 선택을 우선한다. null이면 live를 따라감.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? live;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open]);

  return (
    <details
      className="thought-box"
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) setUserOpen(next);
      }}
    >
      <summary>
        🧠 생각 과정
        {live && <span className="thought-live" aria-hidden="true" />}
      </summary>
      <div
        ref={bodyRef}
        className="thought-body"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
        }}
      >
        {text}
      </div>
    </details>
  );
}
