// CSV·TSV를 Markdown 표로 바꾼다. 결과가 maxChars에 닿으면 칸을 더 모으지 않고 행 수만 센다.
// docling은 입력 전체를 표로 만든 뒤에야 자를 수 있어, 칸이 아주 많은 CSV(예: 4MB에 칸 200만 개)에서 메모리가
// 수백 MB로 커진다. 여기서는 메모리가 입력 크기와 maxChars를 넘지 않는다.

export interface CsvTable {
  markdown: string;
  // 빈 줄을 뺀 전체 행 수(머리글 포함)와 표에 담은 행 수.
  rows: number;
  shownRows: number;
  truncated: boolean;
}

const CANDIDATES = [",", ";", "\t", "|"];

// 따옴표 밖의 구분자 수가 앞쪽 여러 줄에서 고르게 나오는 것을 고른다.
export function detectDelimiter(text: string): string {
  const lines: string[] = [];
  let line = "";
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < 10 && i < 64 * 1024; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === "\n" || c === "\r")) {
      if (line.trim()) lines.push(line);
      line = "";
    } else if (!quoted) {
      line += c;
    }
  }
  if (line.trim() && lines.length < 10) lines.push(line);
  let best = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const score = counts.length ? Math.min(...counts) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function cell(text: string): string {
  return text.trim().replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

export function csvToMarkdown(text: string, delimiter: string, maxChars: number): CsvTable {
  const lines: string[] = [];
  let width = 0;
  let size = 0;
  let full = false;
  let rows = 0;
  let shownRows = 0;

  let row: string[] = [];
  let rowSize = 0;
  // 공백이 아닌 글자나 구분자가 하나라도 있으면 행으로 센다(빈 줄은 건너뛴다).
  let hasContent = false;
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  const endField = () => {
    if (!full) {
      const c = cell(field);
      row.push(c);
      rowSize += c.length + 3;
      // 한 행이 너무 길어도 칸을 끝없이 모으지 않는다.
      if (size + rowSize > maxChars) full = true;
    }
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (hasContent) rows++;
    if (hasContent && !full) {
      if (lines.length === 0) width = row.length;
      while (row.length < width) row.push("");
      const line = `| ${row.join(" | ")} |`;
      lines.push(line);
      size += line.length + 1;
      shownRows++;
      if (lines.length === 1) {
        const sep = `|${" --- |".repeat(width)}`;
        lines.push(sep);
        size += sep.length + 1;
      }
    }
    row = [];
    rowSize = 0;
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          if (!full) field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else if (!full) {
        field += c;
        if (field.length > maxChars) full = true;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      hasContent = true;
    } else if (c === delimiter) {
      endField();
      hasContent = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      if (!full) {
        field += c;
        if (field.length > maxChars) full = true;
      }
      fieldStarted = true;
      if (c !== " " && c !== "\t") hasContent = true;
    }
  }
  if (hasContent) endRow();

  return { markdown: lines.join("\n"), rows, shownRows, truncated: shownRows < rows };
}
