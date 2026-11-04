import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../state/chatStore";
import type { DebugEvent } from "@/lib/messages";
import { maskDiagnostics, maskSummary } from "@/lib/diagMask";

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
  // 공유 전 미리보기(#132): "진단 복사"를 누른 순간의 목록으로 원문·가린 글을 고정한다(그 뒤 로그가 늘거나 필터가 바뀌어도 확인한 글만 복사).
  const [preview, setPreview] = useState<{ raw: string; masked: string; summary: string } | null>(null);
  const [rawCopy, setRawCopy] = useState(false);
  useEffect(() => {
    if (!open) setPreview(null);
  }, [open]);

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

  const openPreview = () => {
    const raw = serialize(filtered);
    const m = maskDiagnostics(raw);
    setPreview({ raw, masked: m.text, summary: maskSummary(m.counts) });
    // 새 미리보기는 늘 가린 글로 시작한다.
    setRawCopy(false);
  };

  const handleCopy = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(rawCopy ? preview.raw : preview.masked);
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
          <h2>문제 신고용 진단</h2>
          <div className="debug-actions">
            <input
              className="debug-filter"
              placeholder="필터 (tag/source/detail)"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <button type="button" className="ghost-btn" onClick={openPreview}>
              진단 복사
            </button>
            <button type="button" className="ghost-btn" onClick={clearDebugEvents}>
              지우기
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="닫기">
              ✕
            </button>
          </div>
        </div>
        <p className="debug-note">
          문제를 알릴 때 복사해 붙여 주세요. 복사하기 전에 주소의 경로·이메일·파일 이름·긴 값을 가린 글을 먼저 보여 줍니다.
        </p>
        {preview && (
          <div className="diag-preview" role="dialog" aria-label="복사할 진단 미리보기">
            <div className="diag-preview-head">
              <span>가린 것: {preview.summary}</span>
              <label className="check-row">
                <input type="checkbox" checked={rawCopy} onChange={(e) => setRawCopy(e.target.checked)} />
                <span>원문 그대로 복사(가리지 않음)</span>
              </label>
            </div>
            <pre className="diag-preview-body">{rawCopy ? preview.raw : preview.masked}</pre>
            <div className="diag-preview-actions">
              <button type="button" className="primary" onClick={handleCopy}>
                {copyState === "copied" ? "복사됨" : copyState === "failed" ? "실패" : "복사"}
              </button>
              <button type="button" className="ghost-btn" onClick={() => setPreview(null)}>
                닫기
              </button>
            </div>
          </div>
        )}
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
