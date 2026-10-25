import type { BgToPanel, DebugEvent, DebugLevel } from "@/lib/messages";
import { maskSyncText } from "./loginSecrets";

const subscribers = new Set<chrome.runtime.Port>();

export function registerDebugSink(port: chrome.runtime.Port): () => void {
  subscribers.add(port);
  port.onDisconnect.addListener(() => subscribers.delete(port));
  return () => subscribers.delete(port);
}

export function debugLog(tag: string, rawDetail?: string, level: DebugLevel = "info"): void {
  // 자동 로그인으로 넣은 값이 페이지 글자·도구 요약에 섞여 와도 로그에 남기지 않는다.
  const detail = rawDetail === undefined ? undefined : maskSyncText(rawDetail);
  const event: DebugEvent = {
    ts: Date.now(),
    source: "bg",
    tag,
    level,
    detail,
  };
  const msg: BgToPanel = { kind: "debug", event };
  for (const port of subscribers) {
    try {
      port.postMessage(msg);
    } catch {
      subscribers.delete(port);
    }
  }
  const prefix = `[SBP ${tag}]`;
  if (level === "error") console.error(prefix, detail ?? "");
  else if (level === "warn") console.warn(prefix, detail ?? "");
  else console.log(prefix, detail ?? "");
}

export function timeSpan(tag: string): (extra?: string) => void {
  const start = Date.now();
  debugLog(`${tag}:start`);
  return (extra?: string) => {
    const dur = Date.now() - start;
    debugLog(`${tag}:end`, `${dur}ms${extra ? " · " + extra : ""}`);
  };
}
