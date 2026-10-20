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
          // 원격 이미지는 불러오지 않는다. 페이지 속 지시문에 속은 모델이 대화 내용을 이미지 주소의 쿼리에 실어 답하면
          // 패널이 그 주소를 자동으로 요청해 승인 없이 밖으로 보내게 된다. 대체 글자와 주소를 글자로만 보여 준다.
          img: ({ alt, src }) => (
            <span className="md-image-placeholder" title={typeof src === "string" ? src : undefined}>
              [이미지{alt ? `: ${alt}` : ""}]{typeof src === "string" && src ? ` ${src}` : ""}
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="caret" />}
    </div>
  );
}
