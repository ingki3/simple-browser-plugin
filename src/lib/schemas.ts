import { z } from "zod";

export const describePageArgs = z.object({}).strict();

export const getPageContentArgs = z.object({}).strict();

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
      .max(200),
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

export const toolArgsSchemas = {
  describe_page: describePageArgs,
  get_page_content: getPageContentArgs,
  translate_page: translatePageArgs,
  find_form_fields: findFormFieldsArgs,
  fill_form_fields: fillFormFieldsArgs,
  list_page_images: listPageImagesArgs,
  download_images: downloadImagesArgs,
  query_dom: queryDomArgs,
  find_clickables: findClickablesArgs,
  click_element: clickElementArgs,
} as const;

export type ToolArgs = {
  [K in keyof typeof toolArgsSchemas]: z.infer<(typeof toolArgsSchemas)[K]>;
};
