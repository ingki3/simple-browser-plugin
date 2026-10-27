import type { useChatSession } from "../hooks/useChatSession";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { HopProgress } from "./HopProgress";
import { ChatGrantBar } from "./ChatGrantBar";
import { TaskBar } from "./TaskBar";
import { RunModeSelect } from "./RunModeSelect";

interface Props {
  session: ReturnType<typeof useChatSession>;
}

export function ChatView({ session }: Props) {
  const { sendUser, approveTool, cancelTool, abortStream, revokeChatGrant, revokeTask } = session;

  return (
    <>
      <MessageList onApprove={approveTool} onCancel={cancelTool} />
      <TaskBar onRevoke={revokeTask} />
      <ChatGrantBar onRevoke={revokeChatGrant} />
      <HopProgress />
      <Composer onSend={sendUser} onAbort={abortStream} />
      <RunModeSelect />
    </>
  );
}
