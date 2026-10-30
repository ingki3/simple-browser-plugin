import type { useChatSession } from "../hooks/useChatSession";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { HopProgress } from "./HopProgress";
import { ChatGrantBar } from "./ChatGrantBar";
import { TaskBar } from "./TaskBar";
import { RepeatBar } from "./RepeatBar";
import { RunModeSelect } from "./RunModeSelect";
import { useSettings } from "../hooks/useSettings";
import { activeModel } from "@/lib/settings";
import { SuggestionChip } from "./SuggestionChip";
import { useSuggestionRules } from "../hooks/useSuggestionRules";

interface Props {
  session: ReturnType<typeof useChatSession>;
  onOpenSettings: () => void;
}

export function ChatView({ session, onOpenSettings }: Props) {
  const { sendUser, approveTool, cancelTool, abortStream, revokeChatGrant, revokeTask, continueRepeat, runSuggestion } = session;
  // 페이지 제안 규칙(#173).
  const { rules, request } = useSuggestionRules();
  // 키가 없으면 첫 화면에서 키 안내를 보이고, 보내기는 설정을 연다(쓴 글은 남긴다, #129).
  const { settings, loaded } = useSettings();
  const needsKey = loaded && !activeModel(settings).apiKey;

  return (
    <>
      <MessageList
        onApprove={approveTool}
        onCancel={cancelTool}
        needsKey={needsKey}
        onOpenSettings={onOpenSettings}
        onSend={sendUser}
      />
      <RepeatBar onContinue={continueRepeat} />
      <TaskBar onRevoke={revokeTask} />
      <ChatGrantBar onRevoke={revokeChatGrant} />
      <HopProgress />
      <SuggestionChip
        rules={rules}
        onRun={runSuggestion}
        onDisable={(rule) => void request({ kind: "page_suggest_update", id: rule.id, enabled: false }).catch(() => {})}
      />
      <Composer onSend={sendUser} onAbort={abortStream} needsKey={needsKey} onOpenSettings={onOpenSettings} />
      <RunModeSelect />
    </>
  );
}
