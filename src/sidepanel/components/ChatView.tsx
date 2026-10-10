import type { useChatSession } from "../hooks/useChatSession";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

interface Props {
  session: ReturnType<typeof useChatSession>;
}

export function ChatView({ session }: Props) {
  const { sendUser, approveTool, cancelTool, abortStream } = session;

  return (
    <>
      <MessageList onApprove={approveTool} onCancel={cancelTool} />
      <Composer onSend={sendUser} onAbort={abortStream} />
    </>
  );
}
