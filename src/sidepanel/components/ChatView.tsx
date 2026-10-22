import type { useChatSession } from "../hooks/useChatSession";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { HopProgress } from "./HopProgress";

interface Props {
  session: ReturnType<typeof useChatSession>;
}

export function ChatView({ session }: Props) {
  const { sendUser, approveTool, cancelTool, abortStream } = session;

  return (
    <>
      <MessageList onApprove={approveTool} onCancel={cancelTool} />
      <HopProgress />
      <Composer onSend={sendUser} onAbort={abortStream} />
    </>
  );
}
