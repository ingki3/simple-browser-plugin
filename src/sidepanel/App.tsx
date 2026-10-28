import { useState } from "react";
import { ChatView } from "./components/ChatView";
import { SettingsDrawer } from "./components/SettingsDrawer";
import { DebugDrawer } from "./components/DebugDrawer";
import { KO } from "./i18n/ko";
import { useChatSession } from "./hooks/useChatSession";

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  // 포트는 패널당 하나. 새 대화 버튼도 백그라운드에 알려야 진행 중인 턴·번역이 멈춘다.
  const session = useChatSession();

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">{KO.appTitle}</h1>
        <div className="app-actions">
          <button className="icon-btn" onClick={session.resetConversation} title={KO.newChat}>
            ＋
          </button>
          {/* 문제 신고용 진단(#130). 개수 배지는 알림처럼 보여 뺐다. */}
          <button className="icon-btn debug-btn" onClick={() => setDebugOpen(true)} title="문제 신고용 진단">
            🐞
          </button>
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} title={KO.settings}>
            ⚙
          </button>
        </div>
      </header>
      <main className="app-main">
        <ChatView session={session} onOpenSettings={() => setSettingsOpen(true)} />
      </main>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DebugDrawer open={debugOpen} onClose={() => setDebugOpen(false)} />
    </div>
  );
}
