// 승인·결과 카드에 보이는 도구 이름(#130). 내부 이름(click_element 등)은 카드의 title(마우스를 올리면 보임)과 진단에만 남긴다.
import type { ToolName } from "./messages.ts";

export const TOOL_LABELS: Record<ToolName, string> = {
  describe_page: "페이지 살펴보기",
  get_page_content: "본문 읽기",
  get_youtube_transcript: "영상 자막 읽기",
  read_document: "파일 읽기",
  list_file_links: "첨부 파일 찾기",
  translate_page: "페이지 번역",
  find_form_fields: "입력칸 찾기",
  fill_form_fields: "입력칸 채우기",
  list_page_images: "이미지 찾기",
  download_images: "이미지 저장",
  download_files: "첨부 파일 저장",
  capture_page: "화면 캡처",
  query_dom: "페이지 내용 찾기",
  navigate_to_url: "페이지 이동",
  open_saved_link: "저장한 링크 열기",
  find_clickables: "버튼·링크 찾기",
  click_element: "누르기",
  sign_in: "자동 로그인",
  google_sheets_list: "Google 시트 목록",
  google_sheets_read_range: "Google 시트 읽기",
  google_sheets_write_range: "Google 시트 쓰기",
  google_sheets_append_rows: "Google 시트에 행 추가",
  google_sheets_write_markdown_table: "Google 시트에 표 쓰기",
  google_drive_search: "Google 드라이브 검색",
  google_drive_list_recent: "Google 드라이브 최근 파일",
  google_drive_export: "Google 드라이브 파일 읽기",
  read_other_tabs: "다른 탭 읽기",
  read_linked_pages: "링크한 페이지 읽기",
  confirm_task: "작업 맡기기",
};

// 이름은 모델이 준 글자일 수 있다(인자 검증 실패 결과 등). 등록한 이름만 바꾸고(__proto__ 같은 상속 속성 제외) 나머지는 그대로.
export function toolLabel(name: string): string {
  return Object.hasOwn(TOOL_LABELS, name) ? (TOOL_LABELS as Record<string, string>)[name] : name;
}
