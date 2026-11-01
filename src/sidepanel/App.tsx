import { useState } from "react";
import { ChatView } from "./components/ChatView";
import { DebugDrawer } from "./components/DebugDrawer";
import { HistoryPickSheet } from "./components/HistoryPickSheet";
import { KO } from "./i18n/ko";
import { useChatSession } from "./hooks/useChatSession";
import { useCurrentTab } from "./hooks/useCurrentTab";
import { useSettings } from "./hooks/useSettings";
import { RememberPageButton } from "./components/RememberPageButton";
import { CurrentTabContext } from "./state/currentTab";
import { openSettingsPage } from "./openSettings";
import type { SettingsSection } from "@/lib/settingsSections";

export function App() {
  const [debugOpen, setDebugOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // 포트는 패널당 하나. 새 대화 버튼도 백그라운드에 알려야 진행 중인 턴·번역이 멈춘다.
  const session = useChatSession();
  // 패널 창의 활성 탭(기억하기 버튼 표시용).
  const current = useCurrentTab();
  const { tab } = current;
  const { settings, loaded } = useSettings();

  // 전체 설정은 브라우저 탭의 설정 페이지에서 한다(#127).
  const openSettings = (section?: SettingsSection) => {
    setSettingsError(null);
    openSettingsPage(section).catch((err: unknown) => setSettingsError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <CurrentTabContext.Provider value={current}>
      <div className="app">
        <header className="app-header">
          <h1 className="app-title">{KO.appTitle}</h1>
          <div className="app-actions">
            <RememberPageButton tab={tab} />
            {loaded && settings.rememberPages && (
              <button className="icon-btn history-pick-btn" onClick={() => setHistoryOpen(true)} title="방문 기록에서 기억할 페이지 찾기">
                🕘
              </button>
            )}
            <button className="icon-btn" onClick={session.resetConversation} title={KO.newChat}>
              ＋
            </button>
            {/* 문제 신고용 진단(#130). 개수 배지는 알림처럼 보여 뺐다. */}
            <button className="icon-btn debug-btn" onClick={() => setDebugOpen(true)} title="문제 신고용 진단">
              🐞
            </button>
            <button className="icon-btn" onClick={() => openSettings()} title={KO.settings}>
              ⚙
            </button>
          </div>
        </header>
        {settingsError && (
          <div className="drawer-alert settings-open-error" role="alert">
            설정 페이지를 열지 못했습니다({settingsError}).
          </div>
        )}
        <main className="app-main">
          <ChatView session={session} onOpenSettings={() => openSettings("model")} />
        </main>
        <DebugDrawer open={debugOpen} onClose={() => setDebugOpen(false)} />
        <HistoryPickSheet open={historyOpen && settings.rememberPages} onClose={() => setHistoryOpen(false)} />
      </div>
    </CurrentTabContext.Provider>
  );
}
