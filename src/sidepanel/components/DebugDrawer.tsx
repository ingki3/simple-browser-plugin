import { useMemo, useState } from "react";
import { useChatStore } from "../state/chatStore";
import type { DebugEvent } from "@/lib/messages";

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function serialize(events: DebugEvent[]): string {
  return events
    .map(
      (e) =>
        `${fmtTime(e.ts)} [${e.source}] ${e.tag}${e.detail ? " · " + e.detail : ""}`,
    )
    .join("\n");
}

export function DebugDrawer({ open, onClose }: Props) {
  const events = useChatStore((s) => s.debugEvents);
  const clearDebugEvents = useChatStore((s) => s.clearDebugEvents);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!filter.trim()) return events;
    const q = filter.toLowerCase();
    return events.filter(
      (e) =>
        e.tag.toLowerCase().includes(q) ||
        (e.detail ?? "").toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q),
    );
  }, [events, filter]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(serialize(filtered));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1500);
    }
  };

  if (!open) return null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer debug-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>디버그 타임라인</h2>
          <div className="debug-actions">
            <input
              className="debug-filter"
              placeholder="필터 (tag/source/detail)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button type="button" className="ghost-btn" onClick={handleCopy}>
              {copyState === "copied" ? "복사됨" : copyState === "failed" ? "실패" : "복사"}
            </button>
            <button type="button" className="ghost-btn" onClick={clearDebugEvents}>
              지우기
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
              ✕
            </button>
          </div>
        </div>
        <div className="drawer-body debug-body">
          {filtered.length === 0 ? (
            <div className="debug-empty">이벤트 없음</div>
          ) : (
            <ul className="debug-list">
              {filtered.map((e, i) => (
                <li key={`${e.ts}-${i}`} className={`debug-row debug-${e.level}`}>
                  <span className="debug-time">{fmtTime(e.ts)}</span>
                  <span className={`debug-src debug-src-${e.source}`}>{e.source}</span>
                  <span className="debug-tag">{e.tag}</span>
                  {e.detail && <span className="debug-detail">{e.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
