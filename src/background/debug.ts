import type { BgToPanel, DebugEvent, DebugLevel } from "@/lib/messages";

const subscribers = new Set<chrome.runtime.Port>();

export function registerDebugSink(port: chrome.runtime.Port): () => void {
  subscribers.add(port);
  port.onDisconnect.addListener(() => subscribers.delete(port));
  return () => subscribers.delete(port);
}

export function debugLog(tag: string, detail?: string, level: DebugLevel = "info"): void {
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
