import { useChatSession } from "../hooks/useChatSession";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ChatView() {
  const { sendUser, approveTool, cancelTool, abortStream } = useChatSession();

  return (
    <>
      <MessageList onApprove={approveTool} onCancel={cancelTool} />
      <Composer onSend={sendUser} onAbort={abortStream} />
    </>
  );
}
