import { useState } from "react";
import { ChatView } from "./components/ChatView";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { DebugDrawer } from "./components/DebugDrawer";
import { KO } from "./i18n/ko";
import { useChatStore } from "./state/chatStore";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const reset = useChatStore((s) => s.reset);
  const debugCount = useChatStore((s) => s.debugEvents.length);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">{KO.appTitle}</h1>
        <div className="app-actions">
          <button className="icon-btn" onClick={() => reset()} title={KO.newChat}>
            ＋
          </button>
          <button
            className="icon-btn debug-btn"
            onClick={() => setDebugOpen(true)}
            title={`디버그 타임라인 (${debugCount})`}
          >
            🐞
            {debugCount > 0 && <span className="debug-badge">{debugCount}</span>}
          </button>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title={KO.settings}>
            ⚙
          </button>
        </div>
      </header>
      <main className="app-main">
        <ChatView />
      </main>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DebugDrawer open={debugOpen} onClose={() => setDebugOpen(false)} />
    </div>
  );
}
