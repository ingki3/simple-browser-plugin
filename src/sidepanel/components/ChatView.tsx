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

interface Props {
  session: ReturnType<typeof useChatSession>;
  onOpenSettings: () => void;
}

export function ChatView({ session, onOpenSettings }: Props) {
  const { sendUser, approveTool, cancelTool, abortStream, revokeChatGrant, revokeTask, continueRepeat } = session;
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
      <Composer onSend={sendUser} onAbort={abortStream} needsKey={needsKey} onOpenSettings={onOpenSettings} />
      <RunModeSelect />
    </>
  );
}
