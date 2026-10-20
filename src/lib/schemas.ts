import { z } from "zod";
import { isNavigationSafeUrl } from "./sanitize";
import { checkFileUrl } from "./fileFormat";

export const describePageArgs = z.object({}).strict();

export const getPageContentArgs = z.object({}).strict();

export const getYoutubeTranscriptArgs = z
  .object({
    includeTimestamps: z.boolean().optional(),
    maxChars: z.number().int().min(1000).max(100_000).optional(),
  })
  .strict();

export const readDocumentArgs = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2048)
      .superRefine((u, ctx) => {
        const checked = checkFileUrl(u);
        if (!checked.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: checked.reason });
      }),
    maxChars: z.number().int().min(1000).max(100_000).optional(),
  })
  .strict();

export const listFileLinksArgs = z
  .object({
    query: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const translatePageArgs = z
  .object({
    targetLang: z.string().min(2).max(10),
    scope: z.enum(["visible", "article"]).optional(),
  })
  .strict();

export const findFormFieldsArgs = z
  .object({
    onlyVisible: z.boolean().optional(),
  })
  .strict();

export const fillFormFieldsArgs = z
  .object({
    fills: z
      .array(
        z
          .object({
            id: z.string().min(1),
            value: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .refine((fills) => new Set(fills.map((f) => f.id)).size === fills.length, {
        message: "같은 칸 id가 두 번 들어 있습니다. 칸마다 한 번만 지정하세요.",
      }),
  })
  .strict();

export const listPageImagesArgs = z
  .object({
    minWidth: z.number().int().nonnegative().optional(),
  })
  .strict();

export const downloadImagesArgs = z
  .object({
    urls: z.array(z.string().url()).min(1).max(200),
    folderPrefix: z.string().max(120).optional(),
  })
  .strict();

export const queryDomArgs = z
  .object({
    selector: z.string().min(1).max(300),
    attr: z.string().max(100).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const navigateToUrlArgs = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(isNavigationSafeUrl, "유효한 http/https URL을 입력해야 합니다."),
  })
  .strict();

export const findClickablesArgs = z
  .object({
    query: z.string().max(200).optional(),
    region: z
      .enum(["main", "article", "nav", "aside", "header", "footer", "other"])
      .optional(),
    onlyViewport: z.boolean().optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export const clickElementArgs = z
  .object({
    id: z.string().min(1).max(50),
  })
  .strict();

const spreadsheetIdSchema = z.string().min(20).max(200);

export const googleSheetsListArgs = z
  .object({ spreadsheetId: spreadsheetIdSchema })
  .strict();

export const googleSheetsReadRangeArgs = z
  .object({
    spreadsheetId: spreadsheetIdSchema,
    range: z.string().min(1).max(200),
  })
  .strict();

export const googleSheetsWriteRangeArgs = z
  .object({
    spreadsheetId: spreadsheetIdSchema,
    range: z.string().min(1).max(200),
    values: z.array(z.array(z.string())).min(1).max(10_000),
  })
  .strict();

export const googleSheetsAppendRowsArgs = z
  .object({
    spreadsheetId: spreadsheetIdSchema,
    range: z.string().min(1).max(200),
    values: z.array(z.array(z.string())).min(1).max(10_000),
  })
  .strict();

export const googleSheetsWriteMarkdownTableArgs = z
  .object({
    spreadsheetId: spreadsheetIdSchema,
    range: z.string().min(1).max(200),
    markdownTable: z.string().min(5).max(100_000),
  })
  .strict();

export const googleDriveSearchArgs = z
  .object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().positive().max(50).optional(),
  })
  .strict();

export const googleDriveListRecentArgs = z
  .object({
    mimeType: z.string().max(120).optional(),
    maxResults: z.number().int().positive().max(50).optional(),
  })
  .strict();

export const googleDriveExportArgs = z
  .object({
    fileId: z.string().min(10).max(200),
    format: z.enum(["pdf", "txt", "csv", "tsv", "html", "md", "docx", "xlsx"]),
    maxChars: z.number().int().positive().max(200_000).optional(),
  })
  .strict();

export const readOtherTabsArgs = z
  .object({
    // 사용자에게 보일 이유(무엇을 참고하려는지). 탭은 사용자가 고른다.
    purpose: z.string().min(1).max(200),
  })
  .strict();

export const readLinkedPagesArgs = z
  .object({
    urls: z.array(z.string().min(1).max(2048)).min(1).max(8),
  })
  .strict();

export const toolArgsSchemas = {
  describe_page: describePageArgs,
  get_page_content: getPageContentArgs,
  get_youtube_transcript: getYoutubeTranscriptArgs,
  read_document: readDocumentArgs,
  list_file_links: listFileLinksArgs,
  translate_page: translatePageArgs,
  find_form_fields: findFormFieldsArgs,
  fill_form_fields: fillFormFieldsArgs,
  list_page_images: listPageImagesArgs,
  download_images: downloadImagesArgs,
  query_dom: queryDomArgs,
  navigate_to_url: navigateToUrlArgs,
  find_clickables: findClickablesArgs,
  click_element: clickElementArgs,
  google_sheets_list: googleSheetsListArgs,
  google_sheets_read_range: googleSheetsReadRangeArgs,
  google_sheets_write_range: googleSheetsWriteRangeArgs,
  google_sheets_append_rows: googleSheetsAppendRowsArgs,
  google_sheets_write_markdown_table: googleSheetsWriteMarkdownTableArgs,
  google_drive_search: googleDriveSearchArgs,
  google_drive_list_recent: googleDriveListRecentArgs,
  google_drive_export: googleDriveExportArgs,
  read_other_tabs: readOtherTabsArgs,
  read_linked_pages: readLinkedPagesArgs,
} as const;

export type ToolArgs = {
  [K in keyof typeof toolArgsSchemas]: z.infer<(typeof toolArgsSchemas)[K]>;
};
