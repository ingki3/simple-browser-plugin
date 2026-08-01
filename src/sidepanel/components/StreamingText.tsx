import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  text: string;
  streaming: boolean;
}

export function StreamingText({ text, streaming }: Props) {
  return (
    <div className="streaming-text markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 외부 링크는 새 탭에서 열기.
          a: ({ href, children, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="caret" />}
    </div>
  );
}
