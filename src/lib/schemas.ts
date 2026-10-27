import { z } from "zod";
import { isNavigationSafeUrl } from "./sanitize";
import { checkFileUrl } from "./fileFormat";
import { QUERY_DOM_ATTRS } from "./modelText";

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
    // 예전 인자. 숨은 칸은 이제 돌려주지 않아 무시한다(#43).
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

// 보고 있는 페이지 캡처(#49). 늘 PNG로 저장한다(이미지를 모델에 보내는 선택은 아직 없다).
export const capturePageArgs = z
  .object({
    fullPage: z.boolean().optional(),
    folderPrefix: z.string().max(120).optional(),
  })
  .strict();

// 지금 페이지의 첨부·다운로드 링크(#48). 주소가 페이지에 있는지는 카드 전에 확인하므로 형식 검사는 길이만 본다
// (잘못된 주소 하나가 호출 전체를 실패시키지 않고 "받지 않는 주소"로 알리게).
export const downloadFilesArgs = z
  .object({
    urls: z.array(z.string().min(1).max(2048)).min(1).max(20),
    folderPrefix: z.string().max(120).optional(),
  })
  .strict();

export const queryDomArgs = z
  .object({
    selector: z.string().min(1).max(300),
    // 정해 둔 구조 속성만(값 성격·data-*·class 등은 받지 않는다, #43).
    attr: z.enum(QUERY_DOM_ATTRS).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

// 저장한 링크 열기(#86): id와 자리 값. 값의 개수·길이는 여기서 한 번, 자리 이름과의 대응은 저장 링크를 읽어 다시 본다.
export const openSavedLinkArgs = z
  .object({
    id: z.string().trim().min(1).max(100),
    values: z.record(z.string(), z.string().max(200)).optional(),
  })
  .strict()
  .refine((a) => Object.keys(a.values ?? {}).length <= 10, "자리 값은 10개까지입니다.");

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

export const signInArgs = z
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

export const confirmTaskArgs = z
  .object({
    // 사용자에게 보일 할 일 요약.
    summary: z.string().min(1).max(1000),
    // 이 작업에 특히 있을 위험(결제·개인정보 입력·삭제·다른 사이트 등). 카드에 그대로 보인다.
    risks: z.array(z.string().min(1).max(300)).max(8),
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
  download_files: downloadFilesArgs,
  capture_page: capturePageArgs,
  query_dom: queryDomArgs,
  navigate_to_url: navigateToUrlArgs,
  open_saved_link: openSavedLinkArgs,
  find_clickables: findClickablesArgs,
  click_element: clickElementArgs,
  sign_in: signInArgs,
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
  confirm_task: confirmTaskArgs,
} as const;

export type ToolArgs = {
  [K in keyof typeof toolArgsSchemas]: z.infer<(typeof toolArgsSchemas)[K]>;
};
