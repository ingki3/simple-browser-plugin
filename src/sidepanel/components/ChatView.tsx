import type { useChatSession } from "../hooks/useChatSession";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { HopProgress } from "./HopProgress";
import { ChatGrantBar } from "./ChatGrantBar";

interface Props {
  session: ReturnType<typeof useChatSession>;
}

export function ChatView({ session }: Props) {
  const { sendUser, approveTool, cancelTool, abortStream, revokeChatGrant } = session;

  return (
    <>
      <MessageList onApprove={approveTool} onCancel={cancelTool} />
      <ChatGrantBar onRevoke={revokeChatGrant} />
      <HopProgress />
      <Composer onSend={sendUser} onAbort={abortStream} />
    </>
  );
}
