interface Props {
  text: string;
  streaming: boolean;
}

export function StreamingText({ text, streaming }: Props) {
  return (
    <span className="streaming-text">
      {text}
      {streaming && <span className="caret" />}
    </span>
  );
}
