import { googleJson } from "./auth";

export interface SheetSummary {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
  index: number;
}

export async function listSheets(spreadsheetId: string): Promise<{
  title: string;
  sheets: SheetSummary[];
}> {
  const json = await googleJson<{
    properties?: { title?: string };
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        index?: number;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
  }>(`/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties`);
  const sheets: SheetSummary[] = (json.sheets ?? []).map((s) => ({
    sheetId: s.properties?.sheetId ?? 0,
    title: s.properties?.title ?? "",
    index: s.properties?.index ?? 0,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    columnCount: s.properties?.gridProperties?.columnCount ?? 0,
  }));
  return {
    title: json.properties?.title ?? "",
    sheets,
  };
}

export async function readRange(
  spreadsheetId: string,
  range: string,
): Promise<{ range: string; values: string[][] }> {
  const json = await googleJson<{ range?: string; values?: string[][] }>(
    `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
  );
  return { range: json.range ?? range, values: json.values ?? [] };
}

export async function writeRange(
  spreadsheetId: string,
  range: string,
  values: string[][],
  // 도구 중단 신호(#319): 401 뒤 다시 보내기 전에 중단됐으면 다시 쓰지 않는다.
  signal?: AbortSignal,
): Promise<{ updatedCells: number }> {
  const json = await googleJson<{ updatedCells?: number }>(
    `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    },
    { signal },
  );
  return { updatedCells: json.updatedCells ?? 0 };
}

export async function appendRows(
  spreadsheetId: string,
  range: string,
  values: string[][],
  // 도구 중단 신호(#319): 401 뒤 다시 보내기 전에 중단됐으면 다시 쓰지 않는다.
  signal?: AbortSignal,
): Promise<{ appendedRows: number; updatedRange: string }> {
  const json = await googleJson<{
    updates?: { updatedRange?: string; updatedRows?: number };
  }>(
    `/sheets/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({ majorDimension: "ROWS", values }),
    },
    { signal },
  );
  return {
    appendedRows: json.updates?.updatedRows ?? 0,
    updatedRange: json.updates?.updatedRange ?? range,
  };
}

export function parseMarkdownTable(md: string): string[][] {
  const lines = md
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes("|"));
  if (lines.length < 2) {
    throw new Error("유효한 markdown 표가 아닙니다 (최소 헤더·구분 2행 필요).");
  }
  const parseRow = (row: string) => {
    let s = row;
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  };
  const header = parseRow(lines[0]);
  const separator = parseRow(lines[1]);
  if (!separator.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")))) {
    throw new Error("markdown 표의 두 번째 행이 구분 행(---|---)이 아닙니다.");
  }
  const body = lines.slice(2).map(parseRow);
  const cols = header.length;
  const normalize = (r: string[]) => {
    const out = r.slice(0, cols);
    while (out.length < cols) out.push("");
    return out;
  };
  return [normalize(header), ...body.map(normalize)];
}
