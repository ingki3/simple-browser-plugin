import type { ReactNode } from "react";

// 설정 항목 설명(#99): 한 줄 요약만 보이고, 자세한 내용은 "자세히"로 펼친다.
export function FieldHelp({ summary, children }: { summary: ReactNode; children?: ReactNode }) {
  return (
    <span className="field-help">
      {summary}
      {children && (
        <details className="field-more">
          <summary>자세히</summary>
          <span>{children}</span>
        </details>
      )}
    </span>
  );
}
